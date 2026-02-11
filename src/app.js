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

    app.use((err, req, res, next) => {
        console.error('Unhandled error:', err);
        res.status(500).json({ error: 'Ошибка сервера', details: err.message });
    });

    return app;
}

module.exports = { createApp };
