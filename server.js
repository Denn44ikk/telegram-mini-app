require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
const PORT = process.env.PORT || 4000;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const publicPath = path.join(__dirname, 'public');
const indexPath = path.join(publicPath, 'index.html');

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' })); // Лимит для больших картинок
app.use(express.static(publicPath));

// Хелпер для логов
function log(message) {
    const time = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    console.log(`[${time}] ${message}`);
}

// 1. УНИВЕРСАЛЬНАЯ ГЕНЕРАЦИЯ (Текст ИЛИ Текст+Фото)
app.post('/api/generate', async (req, res) => {
    // Теперь принимаем и картинку тоже
    const { imageBase64 } = req.body;
    handleGeneration(req, res, imageBase64);
});

// 2. ФОТОСЕССИЯ ПРОДУКТА (То же самое, но отдельный эндпоинт для логики разделения)
app.post('/api/product-gen', async (req, res) => {
    const { imageBase64 } = req.body;
    handleGeneration(req, res, imageBase64);
});

// ОСНОВНАЯ ЛОГИКА ГЕНЕРАЦИИ
async function handleGeneration(req, res, inputImageBase64) {
    const { prompt, initData } = req.body;
    log(`🎨 Генерация. Промпт: "${prompt ? prompt.substring(0, 20) : 'Без промпта'}..."`);

    let chatId = getChatId(initData);

    try {
        const messages = [
            {
                role: "system",
                content: "You are an AI visual artist. Generate an image based on the user request."
            }
        ];

        // Логика: Если есть картинка -> Vision запрос, если нет -> Текстовый
        if (inputImageBase64) {
            messages.push({
                role: "user",
                content: [
                    { type: "text", text: `Generate a new image based on this image and description: ${prompt}` },
                    { type: "image_url", image_url: { url: inputImageBase64 } }
                ]
            });
        } else {
            messages.push({ role: "user", content: prompt });
        }

        const response = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
                model: 'google/gemini-2.0-flash-001', 
                messages: messages
            },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://banana-gen.app',
                }
            }
        );

        // Парсинг ответа
        let imageUrl = null;
        const choice = response.data.choices?.[0]?.message;
        
        if (choice?.content) {
             const urlMatch = choice.content.match(/\((https?:\/\/[^\)]+)\)/) || choice.content.match(/https?:\/\/[^\s"]+/);
             if (urlMatch) imageUrl = urlMatch[1] || urlMatch[0];
        }
        if (!imageUrl && choice?.images?.length) imageUrl = choice.images[0].url;

        if (!imageUrl) throw new Error('AI не вернул ссылку на картинку');

        // Отправка в ТГ
        let sentToChat = false;
        if (chatId) sentToChat = await sendToTelegram(chatId, imageUrl, prompt || 'AI Art', false);

        res.json({ imageUrl, sentToChat });

    } catch (error) {
        console.error(error.response?.data || error.message);
        res.json({ error: 'Ошибка генерации', details: error.message });
    }
}

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---
function getChatId(initData) {
    try {
        const urlParams = new URLSearchParams(initData);
        const user = JSON.parse(urlParams.get('user'));
        return user.id;
    } catch (e) { return null; }
}

async function sendToTelegram(chatId, resource, caption, isDocument, fileName = 'image.png') {
    try {
        const form = new FormData();
        form.append('chat_id', chatId);
        form.append('caption', caption);

        if (resource.startsWith('http')) {
            const stream = await axios.get(resource, { responseType: 'stream' });
            form.append(isDocument ? 'document' : 'photo', stream.data, { filename: fileName });
        } else if (resource.startsWith('data:')) {
            const base64Data = resource.split(';base64,').pop();
            const buffer = Buffer.from(base64Data, 'base64');
            form.append('document', buffer, { filename: fileName });
        }

        const method = isDocument ? 'sendDocument' : 'sendPhoto';
        await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, form, { headers: form.getHeaders() });
        return true;
    } catch (e) {
        console.error('Telegram send error:', e.message);
        return false;
    }
}

app.get('/', (req, res) => res.sendFile(indexPath));
app.listen(PORT, () => log(`🚀 Server running on port ${PORT}`));