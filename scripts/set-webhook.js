/**
 * Регистрация webhook для Telegram бота.
 * Запускайте после смены TELEGRAM_BOT_TOKEN или BASE_URL:
 *   node scripts/set-webhook.js
 *
 * В .env должны быть: TELEGRAM_BOT_TOKEN, BASE_URL (например https://app.n8n-oues.ru)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const https = require('https');
const http = require('http');

const token = process.env.TELEGRAM_BOT_TOKEN;
let baseUrl = (process.env.BASE_URL || '').replace(/\/$/, '');
if (!baseUrl && process.env.PORT) {
    console.warn('BASE_URL не задан. Укажите в .env полный URL сервера (HTTPS), например: BASE_URL=https://yourdomain.com');
}
if (!baseUrl) {
    console.error('Ошибка: задайте BASE_URL в .env (HTTPS-адрес вашего сервера).');
    process.exit(1);
}
if (!token) {
    console.error('Ошибка: задайте TELEGRAM_BOT_TOKEN в .env');
    process.exit(1);
}

const webhookUrl = baseUrl + '/api/telegram-webhook';
const secret = process.env.TELEGRAM_WEBHOOK_SECRET || '';

const body = JSON.stringify({
    url: webhookUrl,
    ...(secret ? { secret_token: secret } : {})
});

const url = new URL(`https://api.telegram.org/bot${token}/setWebhook`);
const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
    let data = '';
    res.on('data', (ch) => { data += ch; });
    res.on('end', () => {
        try {
            const j = JSON.parse(data);
            if (j.ok) {
                console.log('Webhook зарегистрирован:', webhookUrl);
            } else {
                console.error('Ответ Telegram:', j.description || data);
            }
        } catch (e) {
            console.error('Ответ:', data);
        }
    });
});
req.on('error', (e) => console.error('Ошибка запроса:', e.message));
req.write(body);
req.end();
