require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data'); // Нужен для отправки файлов

const app = express();
const PORT = process.env.PORT || 4000;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const publicPath = path.join(__dirname, 'public');
const indexPath = path.join(publicPath, 'index.html');

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static(publicPath));

// === Хелпер для логов с временем ===
function log(message, data = '') {
    const time = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    console.log(`[${time}] ${message}`, data ? data : '');
}

// Логирование всех запросов
app.use((req, res, next) => {
    log(`[ЗАПРОС] ${req.method} ${req.url}`);
    next();
});

// === API ГЕНЕРАЦИИ ===
app.post('/api/generate', async (req, res) => {
    const { prompt, initData } = req.body;
    log(`📝 Получен промпт: "${prompt}"`);

    if (!process.env.OPENROUTER_API_KEY) {
        log('❌ Ошибка: Нет API ключа OpenRouter');
        return res.status(500).json({ error: 'Нет OpenRouter API ключа' });
    }

    // 1. Парсим ID пользователя Telegram
    let chatId = null;
    try {
        if (initData) {
            const urlParams = new URLSearchParams(initData);
            const userJson = urlParams.get('user');
            if (userJson) {
                const user = JSON.parse(userJson);
                chatId = user.id;
                log(`👤 Пользователь: ${user.first_name} (ID: ${chatId})`);
            }
        }
    } catch (e) {
        log('⚠️ Ошибка парсинга initData:', e.message);
    }

    try {
        log('⏳ Отправка запроса к AI...');

        // 2. Генерация картинки
        const response = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
                model: 'google/gemini-3-pro-image-preview',
                messages: [
                    {
                        role: "system",
                        content: "You are an advanced AI image generator. Your ONLY task is to generate an image based on the user prompt. Do not output any conversational text. Just generate the image."
                    },
                    {
                        role: "user",
                        content: `Generate an image of: ${prompt}`
                    }
                ]
            },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://banana-gen.app',
                    'X-Title': 'BananaGen'
                }
            }
        );

        // 3. Извлечение результата
        let imageUrl = null;
        const choices = response.data.choices;
        if (choices && choices.length > 0) {
            const message = choices[0].message;
            if (message.images && message.images.length > 0) {
                imageUrl = message.images[0].image_url.url;
            } else if (message.content) {
                 const urlMatch = message.content.match(/\((https?:\/\/[^\)]+)\)/);
                 if (urlMatch) imageUrl = urlMatch[1];
                 else if (message.content.startsWith('http')) imageUrl = message.content; // Иногда ссылка прямая
            }
        }

        if (!imageUrl) {
            throw new Error('Не удалось найти ссылку/картинку в ответе AI');
        }

        log('✅ Картинка сгенерирована (URL или Base64 получен)');

        // 4. Отправка в Telegram (Сложный метод через FormData, чтобы работало и с URL, и с Base64)
        let sentToChat = false;
        if (chatId && TG_TOKEN) {
            try {
                log(`📤 Подготовка отправки в чат ${chatId}...`);
                
                const form = new FormData();
                form.append('chat_id', chatId);
                form.append('caption', `🎨 Ваш арт: "${prompt}"`);

                // Проверяем: это Base64 или URL?
                if (imageUrl.startsWith('data:')) {
                    // Это Base64 -> Превращаем в буфер
                    const base64Data = imageUrl.split(';base64,').pop();
                    const buffer = Buffer.from(base64Data, 'base64');
                    form.append('document', buffer, { filename: 'generated_art.png' });
                    log('📦 Конвертация Base64 в файл выполнена');
                } else {
                    // Это URL -> Скачиваем поток и отправляем (самый надежный способ)
                    // Если просто кинуть URL в telegram, он может не скачать, если ссылка "грязная"
                    try {
                        const imageStream = await axios.get(imageUrl, { responseType: 'stream' });
                        form.append('document', imageStream.data, { filename: 'generated_art.png' });
                        log('📦 Скачивание изображения по URL для отправки...');
                    } catch (downloadError) {
                         // Если не вышло скачать, попробуем отправить просто ссылку (fallback)
                         log('⚠️ Не удалось скачать файл, пробую отправить ссылку напрямую...');
                         form.append('document', imageUrl);
                    }
                }

                // Отправляем форму в Telegram
                await axios.post(
                    `https://api.telegram.org/bot${TG_TOKEN}/sendDocument`, 
                    form, 
                    { headers: form.getHeaders() }
                );

                sentToChat = true;
                log('📬 Файл успешно доставлен в Telegram!');

            } catch (tgError) {
                log('❌ Ошибка отправки в Telegram:');
                if (tgError.response) {
                    console.error(JSON.stringify(tgError.response.data, null, 2));
                } else {
                    console.error(tgError.message);
                }
            }
        }

        // 5. Ответ фронтенду
        res.json({ imageUrl: imageUrl, sentToChat: sentToChat });

    } catch (error) {
        log('❌ КРИТИЧЕСКАЯ ОШИБКА:', error.message);
        if (error.response) {
            console.error('Детали ошибки API:', JSON.stringify(error.response.data, null, 2));
        }
        res.status(500).json({ error: 'Ошибка генерации' });
    }
});

app.get('/', (req, res) => {
    res.sendFile(indexPath);
});

app.listen(PORT, () => {
    log(`🚀 Сервер запущен на порту ${PORT}`);
});