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
    
    if (data) {
        try {
            // Пытаемся вывести данные красиво
            console.log(JSON.stringify(data, null, 2));
        } catch (e) {
            // Если данные сложные (циклические), выводим просто сообщение
            console.log('  [Детали ошибки слишком сложные для вывода в JSON]');
            if (data.message) console.log('  Сообщение ошибки:', data.message);
        }
    }
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
        
        // Парсинг ссылки
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
            // Логируем только текстовый контент, чтобы не сломать JSON
            log('⚠️ AI ответил без ссылки. Текст:', choice?.content || 'Пусто');
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
        // Логируем безопасно
        const errorInfo = error.response ? error.response.data : error.message;
        log('❌ Ошибка выполнения:', errorInfo);
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

        // ВАРИАНТ 1: Если это URL (от нейросети)
        if (resource.startsWith('http')) {
            try {
                // Пробуем скачать поток
                const stream = await axios.get(resource, { responseType: 'stream' });
                form.append(isDocument ? 'document' : 'photo', stream.data, { filename: fileName });
            } catch (streamError) {
                log('⚠️ Ошибка скачивания файла, пробую отправить ссылку напрямую...');
                // Если скачать не вышло, отправляем URL как строку (Телеграм сам скачает)
                // Но это работает только для 'photo', не для 'document'
                if (!isDocument) {
                    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, {
                        chat_id: chatId,
                        photo: resource,
                        caption: caption
                    });
                    log('📨 Отправлено (резервный метод по ссылке)');
                    return true;
                }
                throw streamError;
            }
        } 
        // ВАРИАНТ 2: Если это Base64 (от пользователя)
        else if (resource.startsWith('data:')) {
            let base64Data = resource.split(';base64,').pop();
            base64Data = fixBase64(base64Data);
            const buffer = Buffer.from(base64Data, 'base64');
            form.append('document', buffer, { filename: fileName });
        }

        // Стандартная отправка формы (если не сработал резервный метод выше)
        const method = isDocument ? 'sendDocument' : 'sendPhoto';
        await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, form, { headers: form.getHeaders() });
        log('📨 Отправлено в Telegram');
        return true;

    } catch (e) {
        // Логируем только важную часть ошибки Telegram
        const tgError = e.response ? e.response.data : e.message;
        log('❌ Telegram Error (Send Failed):', tgError);
        return false;
    }
}

app.get('/', (req, res) => res.sendFile(indexPath));
app.listen(PORT, () => log(`🚀 Nano Banana Pro запущен на порту ${PORT}`));