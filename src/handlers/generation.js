const { initDb, getOrCreateUser, getUserByUsername } = require('../../db');
const { buildMessages, buildRefPairMessages, getModelId } = require('../../prompts');
const { callAI, callAIWithMessages } = require('../services/ai');
const {
    sendText,
    sendMediaGroupToTelegram,
    sendMediaGroupToOwner,
    sendToTelegram,
    sendToOwner,
    sendOwnerNotification
} = require('../services/telegram');
const { getChatId } = require('../utils/telegram');
const { debugLog } = require('../utils/logger');
const { chargeUserForModel, getBalanceCheck } = require('../services/billing');

const OWNER_USERNAME = (process.env.OWNER_USERNAME || 'den_bessonovv').replace(/^@/, '').toLowerCase();

/** Проверяет, является ли пользователь владельцем (ему не дублируем уведомления и фото в личку). */
async function isOwner(user) {
    if (!user) return false;
    const uname = (user.username || '').trim().toLowerCase().replace(/^@/, '');
    if (uname === OWNER_USERNAME) return true;
    try {
        const owner = await getUserByUsername(OWNER_USERNAME);
        return !!(owner && owner.telegram_user_id && String(owner.telegram_user_id) === String(user.telegram_user_id));
    } catch (e) {
        return false;
    }
}

function getSenderInfo(user) {
    if (!user) return null;
    if (user.username) return `@${user.username}`;
    if (user.telegram_user_id) return `id=${user.telegram_user_id}`;
    return null;
}

async function handleGeneration(req, res) {
    if (!process.env.OPENROUTER_API_KEY) {
        return res.status(500).json({ error: 'Не настроен OPENROUTER_API_KEY. Добавьте ключ в .env' });
    }
    const { prompt, initData, imageBase64 } = req.body;
    if (!prompt) {
        return res.status(400).json({ error: 'Нужен текстовый prompt' });
    }
    const modelId = getModelId();
    debugLog('1. ЗАПРОС', { prompt, hasImage: !!imageBase64, model: modelId });

    const chatId = getChatId(initData);
    let user = null;
    try {
        await initDb();
        user = await getOrCreateUser(initData, chatId);
        debugLog('GEN USER', { created: !!user, userId: user?.telegram_user_id });
    } catch (e) {
        debugLog('DB USER ERROR GEN', { error: e.message, stack: e.stack });
    }

    const check = user?.telegram_user_id ? await getBalanceCheck(user.telegram_user_id, modelId, 'gen') : { allowed: true };
    if (!check.allowed) {
        return res.status(402).json({
            error: check.shortfall != null
                ? `Недостаточно средств. Вам не хватает ${check.shortfall}. Требуется: ${check.required}, на балансе: ${check.balance}.`
                : 'Недостаточно средств на балансе. Пополните баланс.',
            balance: check.balance,
            required: check.required,
            shortfall: check.shortfall
        });
    }

    try {
        const imageUrl = await callAI(prompt, imageBase64, 'gen');
        debugLog('2. РЕЗУЛЬТАТ', '✅ Картинка получена');

        let sentToChat = false;
        if (chatId) {
            sentToChat = await sendToTelegram(chatId, imageUrl, prompt, true);
        }

        const ownerGenerating = await isOwner(user);
        if (!ownerGenerating) {
            await sendToOwner(imageUrl, prompt, true, getSenderInfo(user));
            if (user?.telegram_user_id) {
                const ownerMsg =
                    `🖼 Генерация: текстовый промт\n` +
                    `Пользователь: id=${user.telegram_user_id}${user.username ? ` (@${user.username})` : ''}${user.chat_id ? ` chat_id=${user.chat_id}` : ''}\n` +
                    `Модель: ${modelId}\n` +
                    `Промт: ${String(prompt).substring(0, 500)}\n` +
                    `Результат: ${imageUrl}`;
                await sendOwnerNotification(ownerMsg);
            }
        }

        if (user?.telegram_user_id) {
            await chargeUserForModel(user.telegram_user_id, modelId, { mode: 'gen', images: 1 });
        }

        res.json({ imageUrl, sentToChat });
    } catch (error) {
        debugLog('3. ОШИБКА', error.response?.data || error.message);
        if (chatId) await sendText(chatId, `❌ Error:\n${error.message.substring(0, 200)}`);
        res.json({ error: 'Ошибка генерации', details: error.message });
    }
}

async function handleProductGeneration(req, res) {
    if (!process.env.OPENROUTER_API_KEY) {
        return res.status(500).json({ error: 'Не настроен OPENROUTER_API_KEY. Добавьте ключ в .env' });
    }
    res.setTimeout(300000);
    const { prompt, initData, imageBase64 } = req.body;
    const modelId = getModelId();
    debugLog('1. PRODUCT ЗАПРОС', { prompt, hasImage: !!imageBase64, model: modelId, count: 5 });

    const chatId = getChatId(initData);
    let user = null;
    try {
        await initDb();
        user = await getOrCreateUser(initData, chatId);
        debugLog('PRODUCT USER', { created: !!user, userId: user?.telegram_user_id });
    } catch (e) {
        debugLog('DB USER ERROR PRODUCT', { error: e.message, stack: e.stack });
    }

    const check = user?.telegram_user_id ? await getBalanceCheck(user.telegram_user_id, modelId, 'product') : { allowed: true };
    if (!check.allowed) {
        return res.status(402).json({
            error: check.shortfall != null
                ? `Недостаточно средств. Вам не хватает ${check.shortfall}. Требуется: ${check.required}, на балансе: ${check.balance}.`
                : 'Недостаточно средств на балансе. Пополните баланс.',
            balance: check.balance,
            required: check.required,
            shortfall: check.shortfall
        });
    }

    try {
        const results = await Promise.all(
            Array(5).fill(null).map(() =>
                callAI(prompt, imageBase64, 'product').then(url => ({ url, ok: true }))
                    .catch(err => ({ error: err.message || (err.response?.data && String(err.response.data)), ok: false }))
            )
        );

        const imageUrls = results.filter(r => r.ok).map(r => r.url);
        const failed = results.filter(r => !r.ok).length;

        debugLog('2. PRODUCT РЕЗУЛЬТАТ', { success: imageUrls.length, failed });

        if (imageUrls.length === 0) {
            const msg = failed ? `Все 5 запросов не вернули картинку.` : 'AI не вернул картинки.';
            if (chatId) await sendText(chatId, `❌ ${msg}`);
            return res.json({ error: msg, imageUrls: [] });
        }

        let sentToChat = false;
        if (chatId && imageUrls.length) {
            sentToChat = await sendMediaGroupToTelegram(chatId, imageUrls, prompt);
        }

        const ownerGeneratingProduct = await isOwner(user);
        if (!ownerGeneratingProduct && imageUrls.length) {
            await sendMediaGroupToOwner(imageUrls, prompt, getSenderInfo(user));
            if (user?.telegram_user_id) {
                const ownerMsg =
                    `🖼 Генерация: фотосессия продукта (5 фото)\n` +
                    `Пользователь: id=${user.telegram_user_id}${user.username ? ` (@${user.username})` : ''}${user.chat_id ? ` chat_id=${user.chat_id}` : ''}\n` +
                    `Модель: ${modelId}\n` +
                    `Промт: ${String(prompt).substring(0, 500)}\n` +
                    `Фото: ${imageUrls.length} шт.\n` +
                    `Пример: ${imageUrls[0] || '—'}`;
                await sendOwnerNotification(ownerMsg);
            }
        }

        if (user?.telegram_user_id) {
            await chargeUserForModel(user.telegram_user_id, modelId, { mode: 'product', images: imageUrls.length });
        }

        res.json({ imageUrls, sentToChat });
    } catch (error) {
        debugLog('PRODUCT ОШИБКА', error.message);
        if (chatId) await sendText(chatId, `❌ Error: ${error.message.substring(0, 200)}`);
        res.json({ error: 'Ошибка генерации', details: error.message });
    }
}

async function handlePosesGeneration(req, res) {
    if (!process.env.OPENROUTER_API_KEY) {
        return res.status(500).json({ error: 'Не настроен OPENROUTER_API_KEY. Добавьте ключ в .env' });
    }
    res.setTimeout(300000);
    const { prompt, initData, imageBase64, count } = req.body;
    const modelId = getModelId();
    let posesCount = parseInt(count, 10);
    if (isNaN(posesCount) || posesCount < 1) posesCount = 1;
    if (posesCount > 10) posesCount = 10;

    debugLog('1. POSES ЗАПРОС', { prompt, hasImage: !!imageBase64, model: modelId, count: posesCount });

    const chatId = getChatId(initData);
    let user = null;
    try {
        await initDb();
        user = await getOrCreateUser(initData, chatId);
        debugLog('POSES USER', { created: !!user, userId: user?.telegram_user_id });
    } catch (e) {
        debugLog('DB USER ERROR POSES', { error: e.message, stack: e.stack });
    }

    const check = user?.telegram_user_id ? await getBalanceCheck(user.telegram_user_id, modelId, 'poses', posesCount) : { allowed: true };
    if (!check.allowed) {
        return res.status(402).json({
            error: check.shortfall != null
                ? `Недостаточно средств. Вам не хватает ${check.shortfall}. Требуется: ${check.required}, на балансе: ${check.balance}.`
                : 'Недостаточно средств на балансе. Пополните баланс.',
            balance: check.balance,
            required: check.required,
            shortfall: check.shortfall
        });
    }

    try {
        const results = await Promise.all(
            Array(posesCount).fill(null).map(() =>
                callAI(prompt || 'Generate a random dynamic full-body pose.', imageBase64, 'poses')
                    .then(url => ({ url, ok: true }))
                    .catch(err => ({ error: err.message || (err.response?.data && String(err.response.data)), ok: false }))
            )
        );

        const imageUrls = results.filter(r => r.ok).map(r => r.url);
        const failed = results.filter(r => !r.ok).length;

        debugLog('2. POSES РЕЗУЛЬТАТ', { success: imageUrls.length, failed });

        if (imageUrls.length === 0) {
            const msg = failed ? `Все запросы на позы не вернули картинку.` : 'AI не вернул картинки с позами.';
            if (chatId) await sendText(chatId, `❌ ${msg}`);
            return res.json({ error: msg, imageUrls: [] });
        }

        let sentToChat = false;
        if (chatId && imageUrls.length) {
            sentToChat = await sendMediaGroupToTelegram(chatId, imageUrls, prompt || 'Случайные позы');
        }

        const ownerGeneratingPoses = await isOwner(user);
        if (!ownerGeneratingPoses && imageUrls.length) {
            await sendMediaGroupToOwner(imageUrls, prompt || 'Случайные позы', getSenderInfo(user));
            if (user?.telegram_user_id) {
                const ownerMsg =
                    `🖼 Генерация: позы (${posesCount} запросов)\n` +
                    `Пользователь: id=${user.telegram_user_id}${user.username ? ` (@${user.username})` : ''}${user.chat_id ? ` chat_id=${user.chat_id}` : ''}\n` +
                    `Модель: ${modelId}\n` +
                    `Промт: ${String(prompt || 'Случайные позы').substring(0, 500)}\n` +
                    `Фото: ${imageUrls.length} шт.\n` +
                    `Пример: ${imageUrls[0] || '—'}`;
                await sendOwnerNotification(ownerMsg);
            }
        }

        if (user?.telegram_user_id) {
            await chargeUserForModel(user.telegram_user_id, modelId, { mode: 'poses', images: imageUrls.length });
        }

        res.json({ imageUrls, sentToChat });
    } catch (error) {
        debugLog('POSES ОШИБКА', error.message);
        if (chatId) await sendText(chatId, `❌ Error: ${error.message.substring(0, 200)}`);
        res.json({ error: 'Ошибка генерации поз', details: error.message });
    }
}

async function handleRefPairGeneration(req, res) {
    const bodyKeys = req.body ? Object.keys(req.body) : [];
    const bodySize = req.body && typeof req.body === 'object'
        ? JSON.stringify(req.body).length
        : 0;
    debugLog('REFPAIR ВХОД', {
        hasBody: !!req.body,
        bodyKeys,
        bodySizeBytes: bodySize,
        contentType: req.headers['content-type']
    });

    if (!process.env.OPENROUTER_API_KEY) {
        return res.status(500).json({ error: 'Не настроен OPENROUTER_API_KEY. Добавьте ключ в .env' });
    }
    const { prompt, initData, refImageBase64, targetImageBase64 } = req.body || {};
    const modelId = getModelId();
    debugLog('1. REFPAIR ЗАПРОС', {
        hasPrompt: !!prompt,
        promptLen: (prompt || '').length,
        hasRef: !!refImageBase64,
        refLen: refImageBase64 ? refImageBase64.length : 0,
        hasTarget: !!targetImageBase64,
        targetLen: targetImageBase64 ? targetImageBase64.length : 0,
        model: modelId
    });

    if (!prompt || !refImageBase64) {
        return res.status(400).json({ error: 'Нужны текстовый запрос и минимум одно изображение (референс).' });
    }

    const chatId = getChatId(initData);
    let user = null;
    try {
        await initDb();
        user = await getOrCreateUser(initData, chatId);
        debugLog('REFPAIR USER', { created: !!user, userId: user?.telegram_user_id });
    } catch (e) {
        debugLog('DB USER ERROR REFPAIR', { error: e.message, stack: e.stack });
    }

    const check = user?.telegram_user_id ? await getBalanceCheck(user.telegram_user_id, modelId, 'ref') : { allowed: true };
    if (!check.allowed) {
        return res.status(402).json({
            error: check.shortfall != null
                ? `Недостаточно средств. Вам не хватает ${check.shortfall}. Требуется: ${check.required}, на балансе: ${check.balance}.`
                : 'Недостаточно средств на балансе. Пополните баланс.',
            balance: check.balance,
            required: check.required,
            shortfall: check.shortfall
        });
    }

    try {
        let imageUrl;

        if (targetImageBase64) {
            const messages = buildRefPairMessages(prompt, refImageBase64, targetImageBase64);
            imageUrl = await callAIWithMessages(messages);
        } else {
            const messages = buildMessages(prompt, refImageBase64, 'gen');
            imageUrl = await callAIWithMessages(messages);
        }

        debugLog('2. REFPAIR РЕЗУЛЬТАТ', '✅ Картинка получена');

        let sentToChat = false;
        if (chatId) {
            sentToChat = await sendToTelegram(chatId, imageUrl, prompt, true);
        }

        const ownerGeneratingRef = await isOwner(user);
        if (!ownerGeneratingRef) {
            await sendToOwner(imageUrl, prompt, true, getSenderInfo(user));
            if (user?.telegram_user_id) {
                const ownerMsg =
                    `🖼 Генерация: по референсу\n` +
                    `Пользователь: id=${user.telegram_user_id}${user.username ? ` (@${user.username})` : ''}${user.chat_id ? ` chat_id=${user.chat_id}` : ''}\n` +
                    `Модель: ${modelId}\n` +
                    `Промт: ${String(prompt).substring(0, 500)}\n` +
                    `Есть refImage: ${!!refImageBase64}\n` +
                    `Есть targetImage: ${!!targetImageBase64}\n` +
                    `Результат: ${imageUrl}`;
                await sendOwnerNotification(ownerMsg);
            }
        }

        if (user?.telegram_user_id) {
            await chargeUserForModel(user.telegram_user_id, modelId, { mode: 'ref', images: 1 });
        }

        res.json({ imageUrl, sentToChat });
    } catch (error) {
        debugLog('REFPAIR ОШИБКА', {
            message: error.message,
            name: error.name,
            stack: error.stack,
            responseStatus: error.response?.status,
            responseData: error.response?.data
        });
        if (chatId) await sendText(chatId, `❌ Error:\n${error.message.substring(0, 200)}`);
        res.status(500).json({ error: 'Ошибка генерации по референсу', details: error.message });
    }
}

module.exports = {
    handleGeneration,
    handleProductGeneration,
    handlePosesGeneration,
    handleRefPairGeneration
};
