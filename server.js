require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 4000;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const publicPath = path.join(__dirname, 'public');
const indexPath = path.join(publicPath, 'index.html');

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static(publicPath));

// Логирование
app.use((req, res, next) => {
    console.log(`[ЗАПРОС] ${req.method} ${req.url}`);
    next();
});

// === API ГЕНЕРАЦИИ ===
app.post('/api/generate', async (req, res) => {
    const { prompt, initData } = req.body; // Получаем initData от клиента
    console.log('📝 Получен промпт:', prompt);

    if (!process.env.OPENROUTER_API_KEY) {
        return res.status(500).json({ error: 'Нет OpenRouter API ключа' });
    }
    if (!TG_TOKEN) {
        return res.status(500).json({ error: 'Нет Telegram Bot API ключа' });
    }

    // 1. Парсим initData, чтобы узнать ID пользователя
    let chatId = null;
    try {
        if (initData) {
            const urlParams = new URLSearchParams(initData);
            const userJson = urlParams.get('user');
            if (userJson) {
                const user = JSON.parse(userJson);
                chatId = user.id;
                console.log('👤 Пользователь определен:', user.first_name, `(ID: ${chatId})`);
            }
        }
    } catch (e) {
        console.error('⚠️ Ошибка парсинга initData:', e.message);
        // Не прерываем, попробуем просто сгенерировать, но не отправим в ЛС
    }

    try {
        console.log('⏳ Генерация через Gemini...');

        // 2. Запрос к OpenRouter
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

        // 3. Достаем ссылку на картинку
        let imageUrl = null;
        const choices = response.data.choices;
        if (choices && choices.length > 0) {
            const message = choices[0].message;
            if (message.images && message.images.length > 0) {
                imageUrl = message.images[0].image_url.url;
            } else if (message.content) {
                 const urlMatch = message.content.match(/\((https?:\/\/[^\)]+)\)/);
                 if (urlMatch) imageUrl = urlMatch[1];
            }
        }

        if (!imageUrl) {
            throw new Error('Не удалось найти ссылку на картинку в ответе AI');
        }

        console.log('✅ Картинка сгенерирована:', imageUrl);

        // 4. Отправляем картинку в Telegram как ДОКУМЕНТ (sendDocument)
        // Это сохраняет качество и отправляет "файлом"
        let sentToChat = false;
        if (chatId) {
            try {
                console.log(`📤 Отправка файла в чат ${chatId}...`);
                await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendDocument`, {
                    chat_id: chatId,
                    document: imageUrl, // Telegram умеет скачивать по URL сам
                    caption: `🎨 Ваш арт по запросу: "${prompt}"`
                });
                sentToChat = true;
                console.log('📬 Файл успешно отправлен в Telegram!');
            } catch (tgError) {
                console.error('❌ Ошибка отправки в Telegram:', tgError.response?.data || tgError.message);
                // Не валим весь запрос, если не ушло в телегу, просто вернем картинку на сайт
            }
        }

        // 5. Возвращаем ответ фронтенду
        res.json({ 
            imageUrl: imageUrl, 
            sentToChat: sentToChat 
        });

    } catch (error) {
        console.error('❌ ОШИБКА:', error.message);
        res.status(500).json({ error: 'Ошибка генерации или сети' });
    }
});

app.get('/', (req, res) => {
    res.sendFile(indexPath);
});

app.listen(PORT, () => {
    console.log(`🚀 Server started on port ${PORT}`);
});