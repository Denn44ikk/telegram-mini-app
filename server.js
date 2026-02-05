require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

const { buildMessages } = require('./prompts');

const app = express();
const PORT = process.env.PORT || 4000;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MODEL_ID = process.env.MODEL_ID || 'google/gemini-2.0-flash-001';

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
app.post('/api/product-gen', async (req, res) => handleGeneration(req, res));

async function handleGeneration(req, res) {
    const { prompt, initData, imageBase64 } = req.body;
    
    debugLog('1. ЗАПРОС', { prompt, hasImage: !!imageBase64, model: MODEL_ID });

    let chatId = getChatId(initData);

    try {
        const messages = buildMessages(prompt, imageBase64);
        
        debugLog('2. ОТПРАВКА В AI', { model: MODEL_ID, msg_count: messages.length });

        const response = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
                model: MODEL_ID,
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

        debugLog('3. ОТВЕТ (RAW)', response.data);

        let imageUrl = null;
        const choice = response.data.choices?.[0]?.message;
        const content = choice?.content || "";

        debugLog('4. TEXT CONTENT', content);

        // --- ПОИСК КАРТИНКИ ---
        
        const base64Match = content.match(/(data:image\/[a-zA-Z]*;base64,[^\s"\)]+)/);
        const urlMatch = content.match(/(https?:\/\/[^\s\)]+)/);

        if (base64Match) {
            imageUrl = base64Match[1];
            debugLog('5. РЕЗУЛЬТАТ', '✅ Нашли Base64 в тексте');
        } 
        else if (urlMatch) {
            imageUrl = urlMatch[1];
            debugLog('5. РЕЗУЛЬТАТ', `✅ Нашли ссылку в тексте: ${imageUrl}`);
        } 
        else if (choice?.images?.length) {
            const imgObj = choice.images[0];
            if (imgObj.url) {
                imageUrl = imgObj.url;
                debugLog('5. РЕЗУЛЬТАТ', '✅ Нашли ссылку в images[0].url');
            } 
            else if (imgObj.image_url && imgObj.image_url.url) {
                imageUrl = imgObj.image_url.url;
                debugLog('5. РЕЗУЛЬТАТ', '✅ Нашли ссылку в images[0].image_url.url');
            }
        }

        if (!imageUrl) {
            debugLog('5. РЕЗУЛЬТАТ', '❌ Картинка не найдена нигде.');
            throw new Error('AI не вернул картинку (пустой ответ).');
        }

        // Отправка в ТГ
        let sentToChat = false;
        if (chatId) {
            sentToChat = await sendToTelegram(chatId, imageUrl, prompt, true);
        }

        res.json({ imageUrl: imageUrl, sentToChat });

    } catch (error) {
        debugLog('6. ОШИБКА', error.response?.data || error.message);
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
app.listen(PORT, () => console.log(`🚀 SERVER READY: ${MODEL_ID}`));