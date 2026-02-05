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
app.use(bodyParser.json({ limit: '50mb' })); 
app.use(express.static(publicPath));

// --- БЕЗОПАСНЫЙ ЛОГГЕР ---
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
    
    log(`🎨 Запрос Nano Banana Pro. Промпт: "${prompt ? prompt.substring(0, 30) : '...'}"`);

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
        const choice = response.data.choices?.[0]?.message;
        
        // Поиск ссылки
        if (choice?.content) {
             const mdMatch = choice.content.match(/!\[.*?\]\((https?:\/\/[^\)]+)\)/);
             if (mdMatch) imageUrl = mdMatch[1];
             else {
                 const urlMatch = choice.content.match(/(https?:\/\/[^\s\)]+)/);
                 if (urlMatch) imageUrl = urlMatch[1];
             }
        }
        if (!imageUrl && choice?.images?.length) imageUrl = choice.images[0].url;

        if (!imageUrl) {
            log('⚠️ AI ответил без ссылки.');
            throw new Error('AI не вернул ссылку');
        }

        log(`✅ Ссылка получена!`);

        // Отправка в ТГ
        let sentToChat = false;
        if (chatId) {
            sentToChat = await sendToTelegram(chatId, imageUrl, prompt || 'Banana Art', false);
        }

        res.json({ imageUrl, sentToChat });

    } catch (error) {
        log('❌ Ошибка выполнения:', error.message);
        res.json({ error: 'Ошибка генерации', details: error.message });
    }
}

app.post('/api/send-file', async (req, res) => { res.json({success: false, error: "Not implemented"}); });


// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===

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

async function sendToTelegram(chatId, resource, caption, isDocument, fileName = 'image.png') {
    try {
        const form = new FormData();
        form.append('chat_id', chatId);
        form.append('caption', caption ? caption.substring(0, 1000) : 'BananaGen');

        // ВАРИАНТ 1: URL
        if (resource.startsWith('http')) {
            try {
                // Скачиваем, притворяясь браузером (User-Agent)
                const stream = await axios.get(resource, { 
                    responseType: 'stream',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                    }
                });
                form.append(isDocument ? 'document' : 'photo', stream.data, { filename: fileName });
            } catch (streamError) {
                log('⚠️ Ошибка скачивания, пробуем отправить ссылку напрямую...');
                // План Б: Просто кидаем ссылку
                await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, {
                    chat_id: chatId,
                    photo: resource,
                    caption: caption
                });
                return true;
            }
        } 
        // ВАРИАНТ 2: Base64
        else if (resource.startsWith('data:')) {
            let base64Data = resource.split(';base64,').pop();
            base64Data = fixBase64(base64Data);
            const buffer = Buffer.from(base64Data, 'base64');
            form.append('document', buffer, { filename: fileName });
        }

        const method = isDocument ? 'sendDocument' : 'sendPhoto';
        await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, form, { headers: form.getHeaders() });
        log('📨 Отправлено в Telegram');
        return true;

    } catch (e) {
        log('❌ Telegram Error:', e.response?.data || e.message);
        return false;
    }
}

app.get('/', (req, res) => res.sendFile(indexPath));
app.listen(PORT, () => log(`🚀 Nano Banana Pro запущен на порту ${PORT}`));