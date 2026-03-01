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

    app.get('/pay-success', (req, res) => {
        res.set('Content-Type', 'text/html; charset=utf-8');
        res.send(`
<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Оплата прошла</title></head>
<body style="font-family:system-ui;background:#0a0a1a;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;margin:0;padding:20px;text-align:center;">
<div><h1 style="color:#22c55e;">✓ Оплата прошла</h1><p>Баланс пополнен. Вернитесь в приложение.</p></div>
</body></html>`);
    });
    app.get('/pay-fail', (req, res) => {
        res.set('Content-Type', 'text/html; charset=utf-8');
        res.send(`
<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Оплата не прошла</title></head>
<body style="font-family:system-ui;background:#0a0a1a;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;margin:0;padding:20px;text-align:center;">
<div><h1 style="color:#ef4444;">Оплата не прошла</h1><p>Попробуйте снова или вернитесь в приложение.</p></div>
</body></html>`);
    });

    app.use((err, req, res, next) => {
        console.error('Unhandled error:', err);
        res.status(500).json({ error: 'Ошибка сервера', details: err.message });
    });

    return app;
}

module.exports = { createApp };
