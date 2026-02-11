const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;

function adminGuard(req, res, next) {
    if (!ADMIN_TOKEN) {
        return res.status(403).send('ADMIN_TOKEN не задан в .env');
    }
    const token = req.query.token || req.headers['x-admin-token'];
    if (token !== ADMIN_TOKEN) {
        return res.status(401).send('Недостаточно прав');
    }
    next();
}

module.exports = { adminGuard };
