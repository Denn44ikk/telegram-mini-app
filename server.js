require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

// Подключаем промпты
const { buildMessages } = require('./prompts');

const app = express();
const PORT = process.env.PORT || 4000;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// Читаем модель из .env (или используем дефолтную, если забыли прописать)
const MODEL_ID = process.env.MODEL_ID || 'google/gemini-2.0-flash-001';

const publicPath = path.join(__dirname, 'public');
const indexPath = path.join(publicPath, 'index.html');

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' })); 
app.use(express.static(publicPath));

// === МОЩНЫЙ ЛОГГЕР ДЛЯ ДЕБАГА ===
function debugLog(stepName, data) {
    const time = new Date().toLocaleTimeString('ru-RU');
    console.log(`\n🔻🔻🔻 [${time}] --- STEP: ${stepName} --- 🔻🔻🔻`);
    if (typeof data === 'string') {
        console.log(data);
    } else {
        try {
            console.log(JSON.stringify(data, null, 2));
        } catch (e) {
            console.log('[Невозможно отобразить объект JSON]', data);
        }
    }
    console.log(`🔺🔺🔺 ----------------------------------------- 🔺🔺🔺\n`);
}

// === API ENDPOINTS ===
app.post('/api/generate', async (req, res) => handleGeneration(req, res));
app.post('/api/product-gen', async (req, res) => handleGeneration(req, res));

async function handleGeneration(req, res) {
    const { prompt, initData, imageBase64 } = req.body;
    
    // 1. ЛОГИРУЕМ ЗАПРОС
    debugLog('1. ПОЛУЧЕН ЗАПРОС', {
        prompt: prompt,
        hasImage: !!imageBase64,
        usingModel: MODEL_ID // Показываем, какая модель сейчас активна
    });

    let chatId = getChatId(initData);

    try {
        const messages = buildMessages(prompt, imageBase64);
        
        // 2. ОТПРАВЛЯЕМ В OPENROUTER
        debugLog('2. ОТПРАВЛЯЕМ В AI', {
            model: MODEL_ID,
            messages_count: messages.length
        });

        const response = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
                model: MODEL_ID, // <-- ТЕПЕРЬ БЕРЕТСЯ ИЗ ПЕРЕМЕННОЙ
                messages: messages,
            },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://banana-gen.app',
                }
            }
        );

        // 3. ПОЛНЫЙ ОТВЕТ ОТ НЕЙРОСЕТИ
        debugLog('3. ПОЛНЫЙ ОТВЕТ (RAW)', response.data);

        let imageUrl = null;
        const choice = response.data.choices?.[0]?.message;
        const content = choice?.content || "";

        // 4. ТЕКСТОВОЕ СОДЕРЖИМОЕ
        debugLog('4. ТЕКСТ CONTENT', content);

        // Поиск BASE64
        const base64Match = content.match(/(data:image\/[a-zA-Z]*;base64,[^\s"\)]+)/);
        // Поиск URL
        const urlMatch = content.match(/(https?:\/\/[^\s\)]+)/);

        if (base64Match) {
            imageUrl = base64Match[1];
            debugLog('5. РЕЗУЛЬТАТ', '✅ Нашли BASE64 код');
        } else if (urlMatch) {
            imageUrl = urlMatch[1];
            debugLog('5. РЕЗУЛЬТАТ', `✅ Нашли ссылку: ${imageUrl}`);
        } else if (choice?.images?.length) {
            imageUrl = choice.images[0].url;
            debugLog('5. РЕЗУЛЬТАТ', `✅ Нашли ссылку в массиве images: ${imageUrl}`);
        } else {
            debugLog('5. РЕЗУЛЬТАТ', '❌ Картинка не найдена.');
        }

        if (!imageUrl) {
            throw new Error('В ответе нейросети нет ссылки или кода картинки.');
        }

        // Отправка в ТГ
        let sentToChat = false;
        if (chatId) {
            sentToChat = await sendToTelegram(chatId, imageUrl, prompt, true);
        }

        res.json({ imageUrl: imageUrl, sentToChat });

    } catch (error) {
        debugLog('6. ОШИБКА', error.response?.data || error.message);
        if (chatId) await sendText(chatId, `❌ ERROR (${MODEL_ID}):\n${error.message.substring(0, 200)}`);
        res.json({ error: 'Ошибка генерации', details: error.message });
    }
}

app.post('/api/send-file', async (req, res) => { res.json({success: false, error: "Use Pro version"}); });

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

async function sendToTelegram(chatId, resource, caption, isDocument) {
    try {
        const form = new FormData();
        form.append('chat_id', chatId);
        form.append('caption', 'BananaGen Art');

        const isUrl = resource.startsWith('http');
        const isData = resource.startsWith('data:');

        if (isUrl) {
            debugLog('TELEGRAM', `Скачиваю ссылку: ${resource}`);
            try {
                const stream = await axios.get(resource, { 
                    responseType: 'stream',
                    timeout: 15000,
                    headers: { 'User-Agent': 'Mozilla/5.0' }
                });
                form.append(isDocument ? 'document' : 'photo', stream.data, { filename: 'gen.png' });
            } catch (e) {
                debugLog('DOWNLOAD ERROR', e.message);
                throw new Error(`Не удалось скачать файл: ${resource}`);
            }
        } 
        else if (isData) {
            debugLog('TELEGRAM', 'Отправляю Base64...');
            let base64Data = resource.split(';base64,').pop();
            base64Data = fixBase64(base64Data);
            const buffer = Buffer.from(base64Data, 'base64');
            form.append('document', buffer, { filename: 'gen.png' });
        }

        const method = isDocument ? 'sendDocument' : 'sendPhoto';
        await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, form, { headers: form.getHeaders() });
        debugLog('TELEGRAM', '✅ Успешно отправлено!');
        return true;

    } catch (e) {
        debugLog('TELEGRAM FINAL ERROR', e.response?.data || e.message);
        return false;
    }
}

app.get('/', (req, res) => res.sendFile(indexPath));
app.listen(PORT, () => console.log(`🚀 DEBUG SERVER STARTED using model: ${MODEL_ID}`));