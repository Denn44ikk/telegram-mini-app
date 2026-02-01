require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 4000;

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

// === API ГЕНЕРАЦИИ (OpenRouter / Gemini 3) ===
app.post('/api/generate', async (req, res) => {
    const { prompt } = req.body;
    console.log('📝 Получен промпт:', prompt);

    if (!process.env.OPENROUTER_API_KEY) {
        return res.status(500).json({ error: 'Нет API ключа на сервере' });
    }

    try {
        console.log('⏳ Отправляю запрос к Gemini 3 через OpenRouter...');

        const response = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
                model: 'google/gemini-3-pro-image-preview', // Ваша модель
                messages: [
                    {
                        // СИСТЕМНЫЙ ПРОМПТ: ЗАПРЕЩАЕМ ТЕКСТ, ТРЕБУЕМ ФОТО
                        role: "system",
                        content: "You are an advanced AI image generator. Your ONLY task is to generate an image based on the user prompt. Do not output any conversational text, explanations, or code. Just generate the image. If the user asks for 'sunset', generate a picture of a sunset."
                    },
                    {
                        role: "user",
                        content: `Generate an image of: ${prompt}` // Усиливаем запрос
                    }
                ]
                // УБРАЛИ modalities, так как OpenRouter ругается на него ошибкой 404
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

        const result = response.data;
        // console.log('Full Response:', JSON.stringify(result, null, 2)); // Для отладки

        if (result.choices && result.choices.length > 0) {
            const message = result.choices[0].message;
            
            // 1. Проверяем, пришла ли картинка в специальном поле (редко для OpenRouter)
            if (message.images && message.images.length > 0) {
                const imageUrl = message.images[0].image_url.url; 
                console.log('✅ Картинка получена (поле images)');
                return res.json({ imageUrl: imageUrl });
            } 
            
            // 2. Чаще всего Gemini через OpenRouter возвращает Markdown ссылку в тексте
            // Пример: "Here is your image: ![Image](https://...)"
            if (message.content) {
                 console.log('🔍 Анализирую текст ответа на наличие ссылок...');
                 
                 // Ищем паттерн markdown картинки: ![alt](url) или просто (https://...)
                 const urlMatch = message.content.match(/\((https?:\/\/[^\)]+)\)/);
                 
                 if (urlMatch) {
                     console.log('✅ Картинка найдена в тексте (Markdown)');
                     return res.json({ imageUrl: urlMatch[1] });
                 } else {
                     // Если ссылок нет, значит модель все-таки ответила текстом
                     console.warn('⚠️ Модель ответила текстом без картинки:', message.content);
                 }
            }
        }

        console.error('⚠️ Картинка не найдена. Ответ API:', JSON.stringify(result));
        res.status(500).json({ error: 'Не удалось сгенерировать изображение. Попробуйте еще раз.' });

    } catch (error) {
        console.error('❌ ОШИБКА ЗАПРОСА:');
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Data:', JSON.stringify(error.response.data, null, 2));
            res.status(500).json({ error: error.response.data.error?.message || 'Ошибка API OpenRouter' });
        } else {
            console.error(error.message);
            res.status(500).json({ error: 'Ошибка сети' });
        }
    }
});

app.get('/', (req, res) => {
    res.sendFile(indexPath);
});

app.listen(PORT, () => {
    console.log(`🚀 Server started on port ${PORT}`);
});