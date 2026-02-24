const express = require('express');
const multer = require('multer');
const { getModelId, setModelId, getAvailableModels } = require('../../prompts');
const { initDb, getOrCreateUser, getBalance, getReferralStats, listUsersWithRefs, setUserBalance, acceptTerms } = require('../../db');
const { debugLog } = require('../utils/logger');
const { adminGuard } = require('../middleware/adminGuard');
const { telegramWebhookGuard } = require('../middleware/telegramWebhookGuard');
const { handleTelegramWebhook } = require('../handlers/telegramWebhook');
const {
    createSBPPayment,
    createCryptoPayment,
    verifyPayment,
    getPaymentHistory,
    MIN_AMOUNT,
    MAX_AMOUNT
} = require('../services/payment');
const {
    handleGeneration,
    handleProductGeneration,
    handlePosesGeneration,
    handleRefPairGeneration
} = require('../handlers/generation');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

router.use((req, res, next) => {
    if (req.path === '/telegram-webhook') {
        debugLog('INCOMING REQUEST', {
            method: req.method,
            path: req.path,
            headers: {
                'content-type': req.headers['content-type'],
                'user-agent': req.headers['user-agent']
            },
            bodyExists: !!req.body,
            bodyKeys: req.body ? Object.keys(req.body) : []
        });
    }
    next();
});

router.get('/health', (req, res) => {
    const hasKey = !!process.env.OPENROUTER_API_KEY;
    const hasToken = !!process.env.TELEGRAM_BOT_TOKEN;
    res.json({
        ok: true,
        openrouter: hasKey ? 'ok' : 'missing',
        telegram: hasToken ? 'ok' : 'missing',
        timestamp: new Date().toISOString()
    });
});

router.get('/telegram-webhook', (req, res) => {
    res.json({
        ok: true,
        message: 'Webhook endpoint is accessible. Use POST method for Telegram updates.',
        hasToken: !!process.env.TELEGRAM_BOT_TOKEN
    });
});

router.post('/telegram-webhook', telegramWebhookGuard, handleTelegramWebhook);

router.get('/settings', (req, res) => {
    res.json({ modelId: getModelId(), availableModels: getAvailableModels() });
});

router.put('/settings', (req, res) => {
    const { modelId } = req.body;
    if (modelId && getAvailableModels().some(m => m.id === modelId)) {
        setModelId(modelId);
        res.json({ success: true, modelId });
    } else {
        res.status(400).json({ error: 'Недопустимая модель' });
    }
});

router.post('/generate', (req, res) => handleGeneration(req, res));

router.post('/generate-image', upload.single('image'), async (req, res) => {
    try {
        const prompt = req.body?.prompt;
        const initData = req.body?.initData;
        const file = req.file;
        if (!prompt || !file) {
            debugLog('GENERATE-IMAGE ВАЛИДАЦИЯ', { ok: false, reason: 'no prompt or file', hasPrompt: !!prompt, hasFile: !!file });
            return res.status(400).json({ error: 'Нужны prompt и image' });
        }
        const buffer = file.buffer;
        const mime = file.mimetype || 'image/jpeg';
        const imageBase64 = `data:${mime};base64,${buffer.toString('base64')}`;
        debugLog('GENERATE-IMAGE UPLOAD', {
            ok: true,
            promptSnippet: String(prompt).substring(0, 80),
            mime,
            size: buffer.length
        });
        req.body = { prompt, initData, imageBase64 };
        return handleGeneration(req, res);
    } catch (e) {
        debugLog('GENERATE-IMAGE ERROR', e.message);
        res.status(500).json({ error: 'Ошибка загрузки', details: e.message });
    }
});

router.post('/generate-refpair', (req, res) => handleRefPairGeneration(req, res));
router.post('/product-gen', (req, res) => handleProductGeneration(req, res));

router.post('/product-gen-image', upload.single('image'), async (req, res) => {
    try {
        const prompt = req.body?.prompt;
        const initData = req.body?.initData;
        const file = req.file;
        if (!prompt || !file) {
            debugLog('PRODUCT-UPLOAD ВАЛИДАЦИЯ', { ok: false, reason: 'no prompt or file', hasPrompt: !!prompt, hasFile: !!file });
            return res.status(400).json({ error: 'Нужны prompt и image' });
        }
        const buffer = file.buffer;
        const mime = file.mimetype || 'image/jpeg';
        const imageBase64 = `data:${mime};base64,${buffer.toString('base64')}`;
        debugLog('PRODUCT-UPLOAD', {
            ok: true,
            promptSnippet: String(prompt).substring(0, 80),
            mime,
            size: buffer.length
        });
        req.body = { prompt, initData, imageBase64 };
        return handleProductGeneration(req, res);
    } catch (e) {
        debugLog('PRODUCT-UPLOAD ERROR', e.message);
        res.status(500).json({ error: 'Ошибка загрузки', details: e.message });
    }
});

router.post('/poses-gen-image', upload.single('image'), async (req, res) => {
    try {
        const prompt = req.body?.prompt;
        const initData = req.body?.initData;
        const count = req.body?.count;
        const file = req.file;
        if (!file) {
            debugLog('POSES-UPLOAD ВАЛИДАЦИЯ', { ok: false, reason: 'no file', hasPrompt: !!prompt, rawCount: count });
            return res.status(400).json({ error: 'Нужно фото человека' });
        }
        const buffer = file.buffer;
        const mime = file.mimetype || 'image/jpeg';
        const imageBase64 = `data:${mime};base64,${buffer.toString('base64')}`;
        debugLog('POSES-UPLOAD', {
            ok: true,
            promptSnippet: String(prompt || '').substring(0, 80),
            mime,
            size: buffer.length,
            rawCount: count
        });
        req.body = { prompt, initData, imageBase64, count };
        return handlePosesGeneration(req, res);
    } catch (e) {
        debugLog('POSES-UPLOAD ERROR', e.message);
        res.status(500).json({ error: 'Ошибка загрузки', details: e.message });
    }
});

router.post('/accept-terms', async (req, res) => {
    try {
        const initData = req.body?.initData;
        if (!initData) {
            return res.status(400).json({ error: 'Нужен initData' });
        }
        const user = await getOrCreateUser(initData, null);
        if (!user) {
            return res.status(400).json({ error: 'Не удалось распарсить пользователя из initData' });
        }
        const ok = await acceptTerms(user.telegram_user_id);
        if (!ok) {
            return res.status(400).json({ error: 'Не удалось обновить соглашение' });
        }
        res.json({ success: true });
    } catch (e) {
        debugLog('API ACCEPT-TERMS ERROR', e.message);
        res.status(500).json({ error: 'Ошибка принятия соглашения', details: e.message });
    }
});

router.get('/balance', async (req, res) => {
    try {
        const initData = req.query.initData;
        debugLog('API BALANCE', { hasInitData: !!initData });
        const user = await getOrCreateUser(initData, null);
        if (!user) {
            debugLog('API BALANCE', '❌ Failed to parse user from initData');
            return res.status(400).json({ error: 'Не удалось распарсить пользователя из initData' });
        }
        const balance = await getBalance(user.telegram_user_id);
        const ref = await getReferralStats(user.telegram_user_id);
        const termsAccepted = !!user.terms_accepted_at;
        const botUsername = process.env.BOT_USERNAME || null;
        debugLog('API BALANCE', { userId: user.telegram_user_id, balance, refCode: ref.refCode, termsAccepted });
        res.json({
            balance,
            refCode: ref.refCode,
            referredCount: ref.referredCount,
            termsAccepted,
            botLink: botUsername ? `https://t.me/${botUsername.replace(/^@/, '')}` : null
        });
    } catch (e) {
        debugLog('API BALANCE ERROR', e.message);
        res.status(500).json({ error: 'Ошибка чтения баланса', details: e.message });
    }
});

router.get('/admin/users', adminGuard, async (req, res) => {
    try {
        const users = await listUsersWithRefs();
        res.json({ users });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка чтения пользователей', details: e.message });
    }
});

router.post('/admin/set-balance', adminGuard, async (req, res) => {
    try {
        const { telegram_user_id, balance } = req.body || {};
        const parsedBalance = parseInt(balance, 10);
        if (!telegram_user_id || isNaN(parsedBalance)) {
            return res.status(400).json({ error: 'Нужны telegram_user_id и целочисленный balance' });
        }
        const ok = await setUserBalance(telegram_user_id, parsedBalance);
        if (!ok) return res.status(404).json({ error: 'Пользователь не найден' });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка обновления баланса', details: e.message });
    }
});

router.post('/send-file', async (req, res) => { res.json({ success: false }); });

// ========== ПЛАТЕЖНАЯ СИСТЕМА ==========

/**
 * Создание платежа через СБП
 * POST /api/payment/sbp
 * Body: { initData, amount }
 */
router.post('/payment/sbp', async (req, res) => {
    try {
        const { initData, amount } = req.body || {};
        const amountNum = parseFloat(amount);

        if (!initData) {
            return res.status(400).json({ error: 'Нужен initData' });
        }

        if (!amount || isNaN(amountNum) || amountNum < MIN_AMOUNT || amountNum > MAX_AMOUNT) {
            return res.status(400).json({ 
                error: `Сумма должна быть от ${MIN_AMOUNT} до ${MAX_AMOUNT} рублей` 
            });
        }

        const user = await getOrCreateUser(initData, null);
        if (!user) {
            return res.status(400).json({ error: 'Не удалось распарсить пользователя из initData' });
        }

        const result = await createSBPPayment(user.telegram_user_id, amountNum);
        
        if (!result.success) {
            return res.status(400).json({ error: result.error });
        }

        debugLog('API PAYMENT SBP', {
            userId: user.telegram_user_id,
            amount: amountNum,
            paymentId: result.payment.paymentId
        });

        res.json(result);
    } catch (e) {
        debugLog('API PAYMENT SBP ERROR', e.message);
        res.status(500).json({ error: 'Ошибка создания платежа СБП', details: e.message });
    }
});

/**
 * Создание платежа через криптовалюту
 * POST /api/payment/crypto
 * Body: { initData, amount, cryptoType }
 */
router.post('/payment/crypto', async (req, res) => {
    try {
        const { initData, amount, cryptoType = 'USDT' } = req.body || {};
        const amountNum = parseFloat(amount);

        if (!initData) {
            return res.status(400).json({ error: 'Нужен initData' });
        }

        if (!amount || isNaN(amountNum) || amountNum < MIN_AMOUNT || amountNum > MAX_AMOUNT) {
            return res.status(400).json({ 
                error: `Сумма должна быть от ${MIN_AMOUNT} до ${MAX_AMOUNT} рублей` 
            });
        }

        const user = await getOrCreateUser(initData, null);
        if (!user) {
            return res.status(400).json({ error: 'Не удалось распарсить пользователя из initData' });
        }

        const result = await createCryptoPayment(user.telegram_user_id, amountNum, cryptoType);
        
        if (!result.success) {
            return res.status(400).json({ error: result.error });
        }

        debugLog('API PAYMENT CRYPTO', {
            userId: user.telegram_user_id,
            amount: amountNum,
            cryptoType,
            paymentId: result.payment.paymentId
        });

        res.json(result);
    } catch (e) {
        debugLog('API PAYMENT CRYPTO ERROR', e.message);
        res.status(500).json({ error: 'Ошибка создания криптоплатежа', details: e.message });
    }
});

/**
 * Проверка статуса платежа
 * GET /api/payment/verify?paymentId=...&initData=...
 */
router.get('/payment/verify', async (req, res) => {
    try {
        const { paymentId, initData } = req.query;

        if (!paymentId || !initData) {
            return res.status(400).json({ error: 'Нужны paymentId и initData' });
        }

        const user = await getOrCreateUser(initData, null);
        if (!user) {
            return res.status(400).json({ error: 'Не удалось распарсить пользователя из initData' });
        }

        const result = await verifyPayment(paymentId, user.telegram_user_id);
        
        debugLog('API PAYMENT VERIFY', {
            userId: user.telegram_user_id,
            paymentId,
            success: result.success
        });

        res.json(result);
    } catch (e) {
        debugLog('API PAYMENT VERIFY ERROR', e.message);
        res.status(500).json({ error: 'Ошибка проверки платежа', details: e.message });
    }
});

/**
 * История платежей пользователя
 * GET /api/payment/history?initData=...
 */
router.get('/payment/history', async (req, res) => {
    try {
        const { initData } = req.query;

        if (!initData) {
            return res.status(400).json({ error: 'Нужен initData' });
        }

        const user = await getOrCreateUser(initData, null);
        if (!user) {
            return res.status(400).json({ error: 'Не удалось распарсить пользователя из initData' });
        }

        const result = await getPaymentHistory(user.telegram_user_id);
        
        debugLog('API PAYMENT HISTORY', {
            userId: user.telegram_user_id,
            paymentsCount: result.payments?.length || 0
        });

        res.json(result);
    } catch (e) {
        debugLog('API PAYMENT HISTORY ERROR', e.message);
        res.status(500).json({ error: 'Ошибка получения истории платежей', details: e.message });
    }
});

/**
 * Получение лимитов и настроек платежей
 * GET /api/payment/limits
 */
router.get('/payment/limits', (req, res) => {
    res.json({
        minAmount: MIN_AMOUNT,
        maxAmount: MAX_AMOUNT,
        supportedMethods: ['sbp', 'crypto'],
        supportedCrypto: ['USDT', 'BTC', 'ETH']
    });
});

module.exports = { apiRouter: router };
