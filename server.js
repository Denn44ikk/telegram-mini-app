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

const publicPath = path.join(__dirname, 'public');
const indexPath = path.join(publicPath, 'index.html');

app.use(cors());
// Важно: лимит 50mb, так как base64 в тексте занимают много места
app.use(bodyParser.json({ limit: '50mb' })); 
app.use(express.static(publicPath));

// --- ЛОГГЕР ---
function log(message, data = null) {
    const time = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    console.log(`[${time}] ${message}`);
    if (data && data.message) console.log('  Error:', data.message);
}

// === API ENDPOINTS ===
app.post('/api/generate', async (req, res) => handleGeneration(req, res));
app.post('/api/product-gen', async (req, res) => handleGeneration(req, res));

async function handleGeneration(req, res) {
    const { prompt, initData, imageBase64 } = req.body;
    
    log(`🎨 Промпт: "${prompt ? prompt.substring(0, 30) : '...'}"`);

    let chatId = getChatId(initData);

    try {
        const messages = buildMessages(prompt, imageBase64);

        const response = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
                model: 'google/gemini-2.0-flash-001', 
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

        let imageUrl = null;
        let isBase64 = false;
        const choice = response.data.choices?.[0]?.message;
        const content = choice?.content || "";

        // 1. Сначала ищем BASE64 (data:image/png;base64,...)
        // Нейросеть может выдать его в markdown: ![img](data:...) или просто текстом
        const base64Match = content.match(/(data:image\/[a-zA-Z]*;base64,[^\s"\)]+)/);
        
        if (base64Match) {
            imageUrl = base64Match[1];
            isBase64 = true;
            log('✅ Найдена Base64 картинка в ответе!');
        } 
        // 2. Если Base64 нет, ищем обычную ССЫЛКУ (http)
        else {
             const urlMatch = content.match(/(https?:\/\/[^\s\)]+)/);
             if (urlMatch) {
                 imageUrl = urlMatch[1];
                 isBase64 = false;
                 log('✅ Найдена ссылка на картинку');
             } else if (choice?.images?.length) {
                 imageUrl = choice.images[0].url;
                 isBase64 = false;
             }
        }

        if (!imageUrl) {
            log('⚠️ Ответ без картинки/ссылки. Текст:', content.substring(0, 100));
            throw new Error('AI не вернул ни ссылку, ни Base64.');
        }

        // Отправка в ТГ
        let sentToChat = false;
        if (chatId) {
            // Передаем флаг isBase64, чтобы функция знала, что делать
            sentToChat = await sendToTelegram(chatId, imageUrl, prompt || 'Banana Art', true, 'gen_image.png');
        }

        // Если это base64, он может быть гигантским, не отправляем его обратно во фронтенд целиком, если не просили
        // Но фронтенду нужно показать превью.
        res.json({ imageUrl: imageUrl, sentToChat });

    } catch (error) {
        log('❌ Ошибка:', error.message);
        if (chatId) await sendText(chatId, `❌ Ошибка: ${error.message}`);
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

async function sendToTelegram(chatId, resource, caption, isDocument, fileName = 'image.png') {
    try {
        const form = new FormData();
        form.append('chat_id', chatId);
        form.append('caption', caption ? caption.substring(0, 1000) : 'BananaGen');

        // ЛОГИКА ОПРЕДЕЛЕНИЯ ТИПА
        const isUrl = resource.startsWith('http');
        const isData = resource.startsWith('data:');

        if (isUrl) {
            // ЭТО ССЫЛКА -> СКАЧИВАЕМ
            log('⏳ Скачиваю по ссылке...');
            try {
                const stream = await axios.get(resource, { 
                    responseType: 'stream',
                    timeout: 15000,
                    headers: { 'User-Agent': 'Mozilla/5.0' }
                });
                form.append(isDocument ? 'document' : 'photo', stream.data, { filename: fileName });
            } catch (e) {
                log('⚠️ Ссылка недоступна, отправляю как текст');
                await sendText(chatId, `Картинка создана, но ссылка недоступна: ${resource}`);
                return false;
            }
        } 
        else if (isData) {
            // ЭТО BASE64 -> ПРОСТО КОНВЕРТИРУЕМ (БЕЗ СКАЧИВАНИЯ)
            log('⚙️ Обрабатываю Base64...');
            
            // Очищаем от заголовка "data:image/png;base64,"
            let base64Data = resource.split(';base64,').pop();
            base64Data = fixBase64(base64Data);
            
            const buffer = Buffer.from(base64Data, 'base64');
            form.append('document', buffer, { filename: fileName });
        }

        const method = isDocument ? 'sendDocument' : 'sendPhoto';
        await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, form, { headers: form.getHeaders() });
        log('📨 Картинка отправлена в ТГ!');
        return true;

    } catch (e) {
        log('❌ Telegram Error:', e.response?.data || e.message);
        return false;
    }
}

app.get('/', (req, res) => res.sendFile(indexPath));
app.listen(PORT, () => log(`🚀 Server running on port ${PORT}`));