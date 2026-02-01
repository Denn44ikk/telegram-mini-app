require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios'); // Подключили библиотеку для запросов

const app = express();
const PORT = process.env.PORT || 4000; // Используем порт из .env или 4000

// Пути
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

// === ГЛАВНЫЙ МАРШРУТ ГЕНЕРАЦИИ ===
app.post('/api/generate', async (req, res) => {
    const { prompt } = req.body;
    console.log('📝 Получен промпт:', prompt);

    if (!process.env.OPENROUTER_API_KEY) {
        console.error('❌ Ошибка: Не указан API ключ в .env');
        return res.status(500).json({ error: 'Server API Key missing' });
    }

    try {
        console.log('⏳ Отправляю запрос в OpenRouter...');
        
        // Формируем запрос к OpenRouter (формат OpenAI)
        const response = await axios.post(
            'https://openrouter.ai/api/v1/images/generations', 
            {
                // МОДЕЛЬ: Можешь поменять на 'black-forest-labs/flux-1-schnell' или другую
                model: 'stabilityai/stable-diffusion-xl-base-1.0', 
                prompt: prompt,
                n: 1, // Количество картинок
                size: "1024x1024",
                response_format: "b64_json" // ВАЖНО: Просим вернуть Base64, а не ссылку
            },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://telegram-mini-app.com', // Обязательно для OpenRouter
                    'X-Title': 'BananaGen'
                }
            }
        );

        // Проверяем, пришел ли ответ
        if (response.data && response.data.data && response.data.data.length > 0) {
            console.log('✅ Ответ от OpenRouter получен!');
            
            // Достаем Base64 строку
            const b64 = response.data.data[0].b64_json;
            
            // Превращаем в готовый Data URL для браузера
            const imageUrl = `data:image/png;base64,${b64}`;

            // Отправляем клиенту
            res.json({ imageUrl: imageUrl });
        } else {
            console.error('⚠️ Пустой ответ от API:', response.data);
            res.status(500).json({ error: 'API не вернуло изображение' });
        }

    } catch (error) {
        // Подробный вывод ошибки в консоль
        console.error('❌ ОШИБКА ЗАПРОСА:');
        if (error.response) {
            // Ошибка от самого OpenRouter (например, неверный ключ или модель)
            console.error('Status:', error.response.status);
            console.error('Data:', JSON.stringify(error.response.data, null, 2));
            res.status(500).json({ error: error.response.data.error?.message || 'Ошибка API' });
        } else {
            // Ошибка сети или кода
            console.error(error.message);
            res.status(500).json({ error: 'Ошибка соединения с API' });
        }
    }
});

app.get('/', (req, res) => {
    res.sendFile(indexPath);
});

app.listen(PORT, () => {
    console.log(`🚀 Server started on port ${PORT}`);
});