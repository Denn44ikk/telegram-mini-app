function telegramWebhookGuard(req, res, next) {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!secret) return next();
    const token = req.headers['x-telegram-bot-api-secret-token'];
    if (token !== secret) {
        return res.status(401).json({ ok: false, error: 'Invalid webhook secret' });
    }
    next();
}

module.exports = { telegramWebhookGuard };
