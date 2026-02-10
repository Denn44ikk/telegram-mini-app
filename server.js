require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const multer = require('multer');

const { buildMessages, buildRefPairMessages, getModelId, setModelId, getAvailableModels } = require('./prompts');

const app = express();
const PORT = process.env.PORT || 4000;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const publicPath = path.join(__dirname, 'public');
const indexPath = path.join(publicPath, 'index.html');

// Для загрузки фото без base64 — multipart, до 50MB
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' })); 
app.use(express.static(publicPath));

// === ДЕБАГ ЛОГГЕР ===
function debugLog(stepName, data) {
    const time = new Date().toLocaleTimeString('ru-RU');
    console.log(`\n🔻🔻🔻 [${time}] --- STEP: ${stepName} --- 🔻🔻🔻`);
    if (typeof data === 'string') {
        console.log(data);
    } else {
        try {
            console.log(JSON.stringify(data, null, 2));
        } catch (e) {
            console.log('[JSON Error]', data);
        }
    }
    console.log(`🔺🔺🔺 ----------------------------------------- 🔺🔺🔺\n`);
}

// === API ENDPOINTS ===
app.get('/api/health', (req, res) => {
    const hasKey = !!process.env.OPENROUTER_API_KEY;
    res.json({ ok: true, openrouter: hasKey ? 'ok' : 'missing' });
});

app.post('/api/generate', async (req, res) => handleGeneration(req, res));
// Multipart — фото целиком, без base64 (обход лимитов прокси)
app.post('/api/generate-image', upload.single('image'), async (req, res) => {
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
// Новый режим: генерация по двум фото (референс + основное)
app.post('/api/generate-refpair', async (req, res) => handleRefPairGeneration(req, res));
app.post('/api/product-gen', async (req, res) => handleProductGeneration(req, res));
app.post('/api/product-gen-image', upload.single('image'), async (req, res) => {
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
// Новый режим: генерация случайных поз по фото
app.post('/api/poses-gen-image', upload.single('image'), async (req, res) => {
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

app.get('/api/settings', (req, res) => {
    res.json({ modelId: getModelId(), availableModels: getAvailableModels() });
});
app.put('/api/settings', (req, res) => {
    const { modelId } = req.body;
    if (modelId && getAvailableModels().some(m => m.id === modelId)) {
        setModelId(modelId);
        res.json({ success: true, modelId });
    } else {
        res.status(400).json({ error: 'Недопустимая модель' });
    }
});

// Таймаут на один запрос к AI (генерация картинки может занимать 1–2 мин)
const AI_REQUEST_TIMEOUT_MS = 180000;

async function callAIWithMessages(messages) {
    const modelId = getModelId();
    // Логируем только кратко: количество сообщений и наличие картинок, без base64
    try {
        const safeMessages = messages.map((m, idx) => {
            const entry = { role: m.role, idx };
            if (Array.isArray(m.content)) {
                entry.parts = m.content.map((c) => ({
                    type: c.type || (typeof c === 'string' ? 'text' : 'unknown'),
                    hasImageUrl: !!(c.image_url && c.image_url.url),
                    textSnippet: c.text ? String(c.text).substring(0, 60) : undefined
                }));
            } else if (typeof m.content === 'string') {
                entry.textSnippet = m.content.substring(0, 80);
            }
            return entry;
        });
        debugLog('AI CALL PREPARE', { modelId, messagesCount: messages.length, messages: safeMessages });
    } catch (e) {
        debugLog('AI CALL PREPARE ERROR', e.message);
    }
    const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        { model: modelId, messages },
        {
            timeout: AI_REQUEST_TIMEOUT_MS,
            headers: {
                'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://banana-gen.app',
            }
        }
    );
    const choice = response.data.choices?.[0]?.message;
    const content = choice?.content || "";
    debugLog('AI RAW RESPONSE META', {
        hasContent: !!content,
        contentSnippet: typeof content === 'string' ? content.substring(0, 120) : '[non-string]',
        hasImagesArray: Array.isArray(choice?.images) && choice.images.length > 0
    });
    const base64Match = content.match(/(data:image\/[a-zA-Z]*;base64,[^\s"\)]+)/);
    const urlMatch = content.match(/(https?:\/\/[^\s\)]+)/);
    if (base64Match) {
        debugLog('AI PARSE', { type: 'base64', length: base64Match[1].length });
        return base64Match[1];
    }
    if (urlMatch) {
        debugLog('AI PARSE', { type: 'url', urlSnippet: urlMatch[1].substring(0, 120) });
        return urlMatch[1];
    }
    if (choice?.images?.length) {
        const img = choice.images[0];
        if (img.url) {
            debugLog('AI PARSE', { type: 'images[0].url', urlSnippet: img.url.substring(0, 120) });
            return img.url;
        }
        if (img.image_url?.url) {
            debugLog('AI PARSE', { type: 'images[0].image_url.url', urlSnippet: img.image_url.url.substring(0, 120) });
            return img.image_url.url;
        }
    }
    debugLog('AI PARSE ERROR', 'AI не вернул распознаваемый url/base64');
    throw new Error('AI не вернул картинку (пустой ответ).');
}

async function callAI(prompt, imageBase64, mode) {
    const messages = buildMessages(prompt, imageBase64, mode || 'gen');
    return callAIWithMessages(messages);
}

async function handleProductGeneration(req, res) {
    if (!process.env.OPENROUTER_API_KEY) {
        return res.status(500).json({ error: 'Не настроен OPENROUTER_API_KEY. Добавьте ключ в .env' });
    }
    // Генерация 5 фото может занять 2–3 мин — увеличиваем таймаут запроса (по умолчанию ~2 мин)
    res.setTimeout(300000);
    const { prompt, initData, imageBase64 } = req.body;
    const modelId = getModelId();
    debugLog('1. PRODUCT ЗАПРОС', { prompt, hasImage: !!imageBase64, model: modelId, count: 5 });

    const chatId = getChatId(initData);

    try {
        // Все 5 фото генерируются параллельно — быстрее по времени
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

        // Отдаём фото в приложение (таймаут запроса уже увеличен — 5 мин)
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
    // Генерация N поз может занять 1–3 мин
    res.setTimeout(300000);
    const { prompt, initData, imageBase64, count } = req.body;
    const modelId = getModelId();
    let posesCount = parseInt(count, 10);
    if (isNaN(posesCount) || posesCount < 1) posesCount = 1;
    if (posesCount > 10) posesCount = 10;

    debugLog('1. POSES ЗАПРОС', { prompt, hasImage: !!imageBase64, model: modelId, count: posesCount });

    const chatId = getChatId(initData);

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

        res.json({ imageUrls, sentToChat });
    } catch (error) {
        debugLog('POSES ОШИБКА', error.message);
        if (chatId) await sendText(chatId, `❌ Error: ${error.message.substring(0, 200)}`);
        res.json({ error: 'Ошибка генерации поз', details: error.message });
    }
}

async function handleGeneration(req, res) {
    if (!process.env.OPENROUTER_API_KEY) {
        return res.status(500).json({ error: 'Не настроен OPENROUTER_API_KEY. Добавьте ключ в .env' });
    }
    const { prompt, initData, imageBase64 } = req.body;
    const modelId = getModelId();
    debugLog('1. ЗАПРОС', { prompt, hasImage: !!imageBase64, model: modelId });

    const chatId = getChatId(initData);

    try {
        const imageUrl = await callAI(prompt, imageBase64, 'gen');
        debugLog('2. РЕЗУЛЬТАТ', '✅ Картинка получена');

        let sentToChat = false;
        if (chatId) {
            sentToChat = await sendToTelegram(chatId, imageUrl, prompt, true);
        }

        res.json({ imageUrl, sentToChat });
    } catch (error) {
        debugLog('3. ОШИБКА', error.response?.data || error.message);
        if (chatId) await sendText(chatId, `❌ Error:\n${error.message.substring(0, 200)}`);
        res.json({ error: 'Ошибка генерации', details: error.message });
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

    try {
        let imageUrl;

        if (targetImageBase64) {
            // Классический режим: референс + основное фото
            const messages = buildRefPairMessages(prompt, refImageBase64, targetImageBase64);
            imageUrl = await callAIWithMessages(messages);
        } else {
            // Новый режим: только референс + промт (как «фото по промту с референсом»)
            const messages = buildMessages(prompt, refImageBase64, 'gen');
            imageUrl = await callAIWithMessages(messages);
        }

        debugLog('2. REFPAIR РЕЗУЛЬТАТ', '✅ Картинка получена');

        let sentToChat = false;
        if (chatId) {
            sentToChat = await sendToTelegram(chatId, imageUrl, prompt, true);
        }

        res.json({ imageUrl, sentToChat });
    } catch (error) {
        debugLog('REFPAIR ОШИБКА', error.response?.data || error.message);
        if (chatId) await sendText(chatId, `❌ Error:\n${error.message.substring(0, 200)}`);
        res.json({ error: 'Ошибка генерации по референсу', details: error.message });
    }
}

app.post('/api/send-file', async (req, res) => { res.json({success: false}); });

// === ФУНКЦИИ ===

function getChatId(initData) {
    try {
        const urlParams = new URLSearchParams(initData);
        const user = JSON.parse(urlParams.get('user'));
        return user.id;
    } catch (e) { return null; }
}

function fixBase64(str) {
    str = str.replace(/\s/g, '');
    while (str.length % 4 !== 0) str += '=';
    return str;
}

async function sendText(chatId, text) {
    try {
        await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, { chat_id: chatId, text: text });
    } catch (e) {}
}

async function sendMediaGroupToTelegram(chatId, imageUrls, caption) {
    try {
        const hasDataUrls = imageUrls.some(u => u.startsWith('data:'));
        const captionText = `🎨 Фотосессия: "${(caption || '').substring(0, 900)}"`;

        if (hasDataUrls) {
            const form = new FormData();
            form.append('chat_id', chatId);
            const media = [];
            for (let i = 0; i < imageUrls.length; i++) {
                const url = imageUrls[i];
                const key = `photo${i}`;
                media.push({ type: 'photo', media: `attach://${key}`, caption: i === 0 ? captionText : undefined });
                if (url.startsWith('data:')) {
                    const base64 = url.split(';base64,').pop();
                    form.append(key, Buffer.from(fixBase64(base64), 'base64'), { filename: 'gen.png' });
                } else {
                    const stream = await axios.get(url, { responseType: 'stream', timeout: 20000 });
                    form.append(key, stream.data, { filename: 'gen.png' });
                }
            }
            form.append('media', JSON.stringify(media));
            await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMediaGroup`, form, { headers: form.getHeaders() });
        } else {
            const media = imageUrls.map((url, i) => ({
                type: 'photo',
                media: url,
                caption: i === 0 ? captionText : undefined
            }));
            await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMediaGroup`, { chat_id: chatId, media });
        }
        debugLog('TELEGRAM', `✅ Отправлен альбом из ${imageUrls.length} фото`);
        return true;
    } catch (e) {
        debugLog('TELEGRAM MEDIAGROUP ERROR', e.response?.data || e.message);
        return false;
    }
}

async function sendToTelegram(chatId, resource, caption, isDocument) {
    try {
        const form = new FormData();
        form.append('chat_id', chatId);

        // --- ВОТ ТУТ ИСПРАВЛЕНИЕ ЗАГОЛОВКА ---
        // Формируем красивую подпись с промптом
        const finalCaption = caption 
            ? `🎨 Ваш арт: "${caption}"` 
            : '🎨 Ваш арт';
            
        // Обрезаем до 1000 символов (лимит ТГ для подписей к медиа)
        form.append('caption', finalCaption.substring(0, 1000));
        // -------------------------------------

        const isUrl = resource.startsWith('http');
        const isData = resource.startsWith('data:');

        if (isUrl) {
            debugLog('TELEGRAM', `Скачиваю: ${resource.substring(0, 30)}...`);
            try {
                const stream = await axios.get(resource, { 
                    responseType: 'stream',
                    timeout: 20000, 
                    headers: { 'User-Agent': 'Mozilla/5.0' }
                });
                form.append(isDocument ? 'document' : 'photo', stream.data, { filename: 'gen.png' });
            } catch (e) {
                debugLog('DOWNLOAD ERROR', e.message);
                throw new Error('Не удалось скачать файл');
            }
        } 
        else if (isData) {
            debugLog('TELEGRAM', 'Обрабатываю Base64...');
            let base64Data = resource.split(';base64,').pop();
            base64Data = fixBase64(base64Data);
            const buffer = Buffer.from(base64Data, 'base64');
            form.append('document', buffer, { filename: 'gen.png' });
        }

        const method = isDocument ? 'sendDocument' : 'sendPhoto';
        await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, form, { headers: form.getHeaders() });
        debugLog('TELEGRAM', '✅ Отправлено!');
        return true;

    } catch (e) {
        debugLog('TELEGRAM ERROR', e.response?.data || e.message);
        return false;
    }
}

app.get('/', (req, res) => res.sendFile(indexPath));

// Всегда возвращаем JSON при ошибках
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Ошибка сервера', details: err.message });
});

app.listen(PORT, () => {
    const keyOk = !!process.env.OPENROUTER_API_KEY;
    console.log(`🚀 SERVER READY: ${getModelId()}`);
    if (!keyOk) console.warn('⚠️  OPENROUTER_API_KEY не задан в .env — генерация не будет работать!');
});