const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const { apiRouter } = require('./routes/api');

function createApp() {
    const app = express();
    const publicPath = path.join(__dirname, '..', 'public');
    const indexPath = path.join(publicPath, 'index.html');

    app.use(cors());
    app.use(bodyParser.json({ limit: '50mb' }));
    app.use(express.static(publicPath));

    app.use('/api', apiRouter);
    app.get('/', (req, res) => res.sendFile(indexPath));

    const botUsername = (process.env.BOT_USERNAME || '').replace(/^@/, '');
    const botLink = botUsername ? `https://t.me/${botUsername}` : '';

    app.get('/pay-success', (req, res) => {
        res.set('Content-Type', 'text/html; charset=utf-8');
        res.send(`
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Оплата прошла</title></head>
<body style="font-family:system-ui,sans-serif;background:#0a0a1a;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;margin:0;padding:24px;text-align:center;box-sizing:border-box;">
<div style="max-width:360px;">
  <h1 style="color:#22c55e;font-size:28px;margin:0 0 12px;">✓ Оплата прошла</h1>
  <p style="color:rgba(255,255,255,.8);margin:0 0 24px;line-height:1.5;">Баланс пополнен. Вернитесь в приложение — обновление отобразится автоматически.</p>
  ${botLink ? `<a href="${botLink}" style="display:inline-block;padding:14px 28px;background:linear-gradient(135deg,#8b5cf6,#7c3aed);color:#fff;text-decoration:none;border-radius:12px;font-weight:600;">Вернуться в приложение</a>` : '<p style="color:rgba(255,255,255,.5);font-size:14px;">Закройте вкладку и откройте бота в Telegram.</p>'}
</div>
</body></html>`);
    });
    app.get('/pay-fail', (req, res) => {
        res.set('Content-Type', 'text/html; charset=utf-8');
        res.send(`
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Оплата не прошла</title></head>
<body style="font-family:system-ui,sans-serif;background:#0a0a1a;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;margin:0;padding:24px;text-align:center;box-sizing:border-box;">
<div style="max-width:360px;">
  <h1 style="color:#ef4444;font-size:28px;margin:0 0 12px;">Оплата не прошла</h1>
  <p style="color:rgba(255,255,255,.8);margin:0 0 24px;line-height:1.5;">Операция отменена или произошла ошибка. Попробуйте пополнить снова в приложении.</p>
  ${botLink ? `<a href="${botLink}" style="display:inline-block;padding:14px 28px;background:rgba(255,255,255,.12);color:#fff;text-decoration:none;border-radius:12px;font-weight:600;border:1px solid rgba(255,255,255,.2);">Вернуться в приложение</a>` : '<p style="color:rgba(255,255,255,.5);font-size:14px;">Откройте бота в Telegram и попробуйте снова.</p>'}
</div>
</body></html>`);
    });

    app.use((err, req, res, next) => {
        console.error('Unhandled error:', err);
        res.status(500).json({ error: 'Ошибка сервера', details: err.message });
    });

    return app;
}

module.exports = { createApp };
