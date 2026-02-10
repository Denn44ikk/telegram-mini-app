const mysql = require('mysql2/promise');

let pool;

async function initDb() {
    if (pool) return pool;

    pool = mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    });

    // Инициализируем схему, если её ещё нет
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            telegram_user_id VARCHAR(64) UNIQUE,
            chat_id VARCHAR(64),
            username VARCHAR(255),
            first_name VARCHAR(255),
            last_name VARCHAR(255),
            balance INT DEFAULT 0,
            ref_code VARCHAR(64) UNIQUE,
            referred_by VARCHAR(64),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            KEY idx_users_telegram_id (telegram_user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS referrals (
            id INT AUTO_INCREMENT PRIMARY KEY,
            referrer_user_id VARCHAR(64) NOT NULL,
            referred_user_id VARCHAR(64) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_referrals_referrer (referrer_user_id),
            KEY idx_referrals_referred (referred_user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    return pool;
}

function generateRefCode(telegramUserId) {
    const base = String(telegramUserId || '');
    const hash = [...base].reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) >>> 0, 0);
    return 'NB' + hash.toString(36).toUpperCase();
}

function parseInitData(initData) {
    try {
        const params = new URLSearchParams(initData || '');
        const userJson = params.get('user');
        const user = userJson ? JSON.parse(userJson) : null;
        const startParam = params.get('start_param') || params.get('startapp') || null;
        return { user, startParam };
    } catch (e) {
        return { user: null, startParam: null };
    }
}

async function getOrCreateUser(initData, chatIdFromMessage) {
    const db = await initDb();
    const { user, startParam } = parseInitData(initData);
    if (!user) return null;

    const telegramUserId = String(user.id);
    const chatId = chatIdFromMessage || String(user.id);

    const [rows] = await db.execute('SELECT * FROM users WHERE telegram_user_id = ?', [telegramUserId]);
    let row = rows[0];

    let refCode;
    if (!row) {
        refCode = generateRefCode(telegramUserId);
        const referredBy = startParam || null;
        await db.execute(
            `INSERT INTO users (telegram_user_id, chat_id, username, first_name, last_name, balance, ref_code, referred_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                telegramUserId,
                chatId,
                user.username || null,
                user.first_name || null,
                user.last_name || null,
                0,
                refCode,
                referredBy
            ]
        );

        const [rowsAfterInsert] = await db.execute('SELECT * FROM users WHERE telegram_user_id = ?', [telegramUserId]);
        row = rowsAfterInsert[0];

        // Реферальный бонус при первом входе
        if (referredBy) {
            const [refRows] = await db.execute('SELECT * FROM users WHERE ref_code = ?', [referredBy]);
            const referrer = refRows[0];
            if (referrer) {
                const BONUS_REFERRER = 10;
                const BONUS_NEW = 5;
                await db.execute(
                    'UPDATE users SET balance = balance + ? WHERE telegram_user_id = ?',
                    [BONUS_REFERRER, referrer.telegram_user_id]
                );
                await db.execute(
                    'UPDATE users SET balance = balance + ? WHERE telegram_user_id = ?',
                    [BONUS_NEW, telegramUserId]
                );
                await db.execute(
                    'INSERT INTO referrals (referrer_user_id, referred_user_id) VALUES (?, ?)',
                    [referrer.telegram_user_id, telegramUserId]
                );
            }
        }
    } else {
        // Обновляем chat_id/имена на всякий случай
        await db.execute(
            `UPDATE users
             SET chat_id = ?, username = ?, first_name = ?, last_name = ?
             WHERE telegram_user_id = ?`,
            [
                chatId,
                user.username || null,
                user.first_name || null,
                user.last_name || null,
                telegramUserId
            ]
        );
        const [rowsAfterUpdate] = await db.execute('SELECT * FROM users WHERE telegram_user_id = ?', [telegramUserId]);
        row = rowsAfterUpdate[0];
    }

    return row;
}

async function getUserByTelegramId(telegramUserId) {
    const db = await initDb();
    const [rows] = await db.execute('SELECT * FROM users WHERE telegram_user_id = ?', [String(telegramUserId)]);
    return rows[0] || null;
}

async function getBalance(telegramUserId) {
    const user = await getUserByTelegramId(telegramUserId);
    return user ? user.balance : 0;
}

async function getReferralStats(telegramUserId) {
    const db = await initDb();
    const user = await getUserByTelegramId(telegramUserId);
    if (!user) return { refCode: null, referredCount: 0 };
    const [rows] = await db.execute(
        'SELECT COUNT(*) as cnt FROM referrals WHERE referrer_user_id = ?',
        [String(telegramUserId)]
    );
    const countRow = rows[0] || { cnt: 0 };
    return {
        refCode: user.ref_code,
        referredCount: countRow.cnt || 0
    };
}

async function listUsersWithRefs() {
    const db = await initDb();
    const [rows] = await db.query(`
        SELECT 
            u.id,
            u.telegram_user_id,
            u.chat_id,
            u.username,
            u.first_name,
            u.last_name,
            u.balance,
            u.ref_code,
            u.referred_by,
            u.created_at,
            u.updated_at,
            COALESCE(r.cnt, 0) AS referred_count
        FROM users u
        LEFT JOIN (
            SELECT referrer_user_id, COUNT(*) AS cnt
            FROM referrals
            GROUP BY referrer_user_id
        ) r ON r.referrer_user_id = u.telegram_user_id
        ORDER BY u.created_at DESC
    `);
    return rows;
}

async function setUserBalance(telegramUserId, newBalance) {
    const db = await initDb();
    const [result] = await db.execute(
        'UPDATE users SET balance = ? WHERE telegram_user_id = ?',
        [newBalance, String(telegramUserId)]
    );
    return result.affectedRows > 0;
}

module.exports = {
    initDb,
    getOrCreateUser,
    getUserByTelegramId,
    getBalance,
    getReferralStats,
    listUsersWithRefs,
    setUserBalance
};

