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
app.use(bodyParser.json({ limit: '50mb' })); // Увеличим лимит, так как картинки могут приходить в base64
app.use(express.static(publicPath));

// Логирование
app.use((req, res, next) => {
    console.log(`[ЗАПРОС] ${req.method} ${req.url}`);
    next();
});

// === API ГЕНЕРАЦИИ (OpenRouter / Gemini 3 Preview) ===
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
                // Указанная вами модель
                model: 'google/gemini-3-pro-image-preview',
                messages: [
                    {
                        role: "user",
                        content: prompt // Подставляем промпт от клиента
                    }
                ],
                // Ваш параметр для генерации картинок
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

        const result = response.data;
        
        // Логика парсинга из вашего примера
        if (result.choices && result.choices.length > 0) {
            const message = result.choices[0].message;
            
            // Проверяем наличие массива images (как в вашем примере)
            if (message.images && message.images.length > 0) {
                // Берем первую картинку
                const imageUrl = message.images[0].image_url.url; 
                console.log('✅ Картинка получена (Base64/URL)');
                return res.json({ imageUrl: imageUrl });
            } 
            // На случай, если модель решит вернуть текст или markdown ссылку
            else if (message.content) {
                 console.log('⚠️ Поле images пустое, проверяем контент...');
                 // Пытаемся найти markdown ссылку на всякий случай
                 const urlMatch = message.content.match(/\((https?:\/\/[^\)]+)\)/);
                 if (urlMatch) {
                     return res.json({ imageUrl: urlMatch[1] });
                 }
            }
        }

        console.error('⚠️ Структура ответа не содержит картинку:', JSON.stringify(result));
        res.status(500).json({ error: 'API вернуло ответ без картинки' });

    } catch (error) {
        console.error('❌ ОШИБКА ЗАПРОСА:');
        if (error.response) {
            console.error('Status:', error.response.status);
            // console.error('Data:', JSON.stringify(error.response.data, null, 2)); // Можно раскомментировать для отладки
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