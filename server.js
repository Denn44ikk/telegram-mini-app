require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

const { buildMessages, getModelId, setModelId, getAvailableModels } = require('./prompts');

const app = express();
const PORT = process.env.PORT || 4000;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const publicPath = path.join(__dirname, 'public');
const indexPath = path.join(publicPath, 'index.html');

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
app.post('/api/generate', async (req, res) => handleGeneration(req, res));
app.post('/api/product-gen', async (req, res) => handleProductGeneration(req, res));

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

async function callAI(prompt, imageBase64, mode) {
    const modelId = getModelId();
    const messages = buildMessages(prompt, imageBase64, mode || 'gen');
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
    const base64Match = content.match(/(data:image\/[a-zA-Z]*;base64,[^\s"\)]+)/);
    const urlMatch = content.match(/(https?:\/\/[^\s\)]+)/);
    if (base64Match) return base64Match[1];
    if (urlMatch) return urlMatch[1];
    if (choice?.images?.length) {
        const img = choice.images[0];
        if (img.url) return img.url;
        if (img.image_url?.url) return img.image_url.url;
    }
    throw new Error('AI не вернул картинку (пустой ответ).');
}

async function handleProductGeneration(req, res) {
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

        res.json({ imageUrls, sentToChat });
    } catch (error) {
        debugLog('PRODUCT ОШИБКА', error.message);
        if (chatId) await sendText(chatId, `❌ Error: ${error.message.substring(0, 200)}`);
        res.json({ error: 'Ошибка генерации', details: error.message });
    }
}

async function handleGeneration(req, res) {
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
app.listen(PORT, () => console.log(`🚀 SERVER READY: ${getModelId()}`));