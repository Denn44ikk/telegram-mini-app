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
app.use(bodyParser.json());
app.use(express.static(publicPath));

// Логирование
app.use((req, res, next) => {
    console.log(`[ЗАПРОС] ${req.method} ${req.url}`);
    next();
});

// === API ГЕНЕРАЦИИ (OpenRouter / Gemini) ===
app.post('/api/generate', async (req, res) => {
    const { prompt } = req.body;
    console.log('📝 Получен промпт:', prompt);

    if (!process.env.OPENROUTER_API_KEY) {
        return res.status(500).json({ error: 'Нет API ключа на сервере' });
    }

    try {
        console.log('⏳ Отправляю запрос к Gemini через OpenRouter...');

        // Используем эндпоинт chat/completions, как в твоей документации
        const response = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
                // Модель из твоего примера
                model: 'google/gemini-2.0-flash-001', // ВНИМАНИЕ: gemini-3 может быть еще недоступна всем, лучше используй 2.0-flash или точное название из списка моделей
                messages: [
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                // Важный параметр для генерации картинок в Gemini
                modalities: ['image', 'text']
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

        // Логируем структуру ответа, чтобы видеть, что пришло
        // console.log('Ответ OpenRouter:', JSON.stringify(response.data, null, 2));

        const choices = response.data.choices;
        
        // Разбираем ответ согласно твоей документации
        // Ищем message.images
        if (choices && choices.length > 0) {
            const message = choices[0].message;
            
            // Проверка 1: Если картинка пришла в спец. поле images (как в доке Gemini)
            if (message.images && message.images.length > 0) {
                const imageUrl = message.images[0].image_url.url; // Base64
                console.log('✅ Картинка получена (метод images)');
                return res.json({ imageUrl: imageUrl });
            } 
            // Проверка 2: Иногда OpenRouter возвращает картинку как Markdown ссылку в content
            else if (message.content && message.content.includes('http')) {
                 // Пытаемся найти URL в тексте (простой парсинг)
                 const urlMatch = message.content.match(/\((https?:\/\/[^\)]+)\)/);
                 if (urlMatch) {
                     console.log('✅ Картинка найдена в тексте');
                     return res.json({ imageUrl: urlMatch[1] });
                 }
            }
        }

        console.error('⚠️ Картинка не найдена в ответе:', JSON.stringify(response.data));
        res.status(500).json({ error: 'API не вернуло картинку (возможно, модель только текстовая)' });

    } catch (error) {
        console.error('❌ ОШИБКА ЗАПРОСА:');
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Data:', JSON.stringify(error.response.data, null, 2));
            res.status(500).json({ error: error.response.data.error?.message || 'Ошибка API' });
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