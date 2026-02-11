const { initDb, getOrCreateUser } = require('../../db');
const { buildMessages, buildRefPairMessages, getModelId } = require('../../prompts');
const { callAI, callAIWithMessages } = require('../services/ai');
const { sendText, sendMediaGroupToTelegram, sendToTelegram } = require('../services/telegram');
const { getChatId } = require('../utils/telegram');
const { debugLog } = require('../utils/logger');
const { chargeUserForModel } = require('../services/billing');

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

    try {
        const imageUrl = await callAI(prompt, imageBase64, 'gen');
        debugLog('2. РЕЗУЛЬТАТ', '✅ Картинка получена');

        let sentToChat = false;
        if (chatId) {
            sentToChat = await sendToTelegram(chatId, imageUrl, prompt, true);
        }

        if (user?.telegram_user_id) {
            await chargeUserForModel(user.telegram_user_id, modelId, { mode: 'gen' });
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
    if (!process.env.OPENROUTER_API_KEY) {
        return res.status(500).json({ error: 'Не настроен OPENROUTER_API_KEY. Добавьте ключ в .env' });
    }
    const { prompt, initData, refImageBase64, targetImageBase64 } = req.body;
    const modelId = getModelId();
    debugLog('1. REFPAIR ЗАПРОС', { prompt, hasRef: !!refImageBase64, hasTarget: !!targetImageBase64, model: modelId });

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

        if (user?.telegram_user_id) {
            await chargeUserForModel(user.telegram_user_id, modelId, { mode: 'ref' });
        }

        res.json({ imageUrl, sentToChat });
    } catch (error) {
        debugLog('REFPAIR ОШИБКА', error.response?.data || error.message);
        if (chatId) await sendText(chatId, `❌ Error:\n${error.message.substring(0, 200)}`);
        res.json({ error: 'Ошибка генерации по референсу', details: error.message });
    }
}

module.exports = {
    handleGeneration,
    handleProductGeneration,
    handlePosesGeneration,
    handleRefPairGeneration
};
