require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

// ПОДКЛЮЧАЕМ НАШ НОВЫЙ ФАЙЛ С ПРОМПТАМИ
const { buildMessages } = require('./prompts');

const app = express();
const PORT = process.env.PORT || 4000;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const publicPath = path.join(__dirname, 'public');
const indexPath = path.join(publicPath, 'index.html');

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' })); 
app.use(express.static(publicPath));

// Хелпер для логов
function log(message, data = null) {
    const time = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    console.log(`[${time}] ${message}`);
    if (data) console.log(JSON.stringify(data, null, 2));
}

// === API ENDPOINTS ===

// Общий обработчик для генерации (Текст и Фотосессия)
app.post('/api/generate', async (req, res) => handleGeneration(req, res));
app.post('/api/product-gen', async (req, res) => handleGeneration(req, res));

async function handleGeneration(req, res) {
    const { prompt, initData, imageBase64 } = req.body;
    
    log(`🎨 Запрос Nano Banana Pro. Промпт: "${prompt ? prompt.substring(0, 30) : '...'}"`);

    let chatId = getChatId(initData);

    try {
        // 1. БЕРЕМ ПРОМПТЫ ИЗ ОТДЕЛЬНОГО ФАЙЛА
        const messages = buildMessages(prompt, imageBase64);

        // 2. ОТПРАВЛЯЕМ ЗАПРОС
        const response = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
                model: 'google/gemini-2.0-flash-001', // Твоя модель
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

        // 3. ПАРСИМ ОТВЕТ
        let imageUrl = null;
        const choice = response.data.choices?.[0]?.message;
        
        // Поиск ссылки (Markdown или Raw URL)
        if (choice?.content) {
             const mdMatch = choice.content.match(/!\[.*?\]\((https?:\/\/[^\)]+)\)/); // Markdown
             if (mdMatch) imageUrl = mdMatch[1];
             else {
                 const urlMatch = choice.content.match(/(https?:\/\/[^\s\)]+)/); // Просто ссылка
                 if (urlMatch) imageUrl = urlMatch[1];
             }
        }
        // Поиск в массиве images
        if (!imageUrl && choice?.images?.length) imageUrl = choice.images[0].url;

        if (!imageUrl) {
            log('⚠️ AI ответил текстом (нет ссылки):', choice?.content);
            throw new Error(choice?.content || 'AI не вернул ссылку');
        }

        log(`✅ Ссылка получена!`);

        // 4. ОТПРАВКА В ТЕЛЕГРАМ
        let sentToChat = false;
        if (chatId) {
            sentToChat = await sendToTelegram(chatId, imageUrl, prompt || 'Banana Art', false);
        }

        res.json({ imageUrl, sentToChat });

    } catch (error) {
        log('❌ Ошибка:', error.response?.data || error.message);
        res.json({ error: 'Ошибка генерации', details: error.message });
    }
}

// Заглушка для отправки файлов (если используется)
app.post('/api/send-file', async (req, res) => { res.json({success: false, error: "Not implemented in Pro version yet"}); });


// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===

function getChatId(initData) {
    try {
        const urlParams = new URLSearchParams(initData);
        const user = JSON.parse(urlParams.get('user'));
        return user.id;
    } catch (e) { return null; }
}

// Фикс "Wrong padding length"
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

        if (resource.startsWith('http')) {
            const stream = await axios.get(resource, { responseType: 'stream' });
            form.append(isDocument ? 'document' : 'photo', stream.data, { filename: fileName });
        } else if (resource.startsWith('data:')) {
            let base64Data = resource.split(';base64,').pop();
            base64Data = fixBase64(base64Data); // Применяем лечение
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