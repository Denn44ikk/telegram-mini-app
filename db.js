const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'db.sqlite');

let db;

function initDb() {
    if (db) return db;
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');

    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            telegram_user_id TEXT UNIQUE,
            chat_id TEXT,
            username TEXT,
            first_name TEXT,
            last_name TEXT,
            balance INTEGER DEFAULT 0,
            ref_code TEXT UNIQUE,
            referred_by TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS referrals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            referrer_user_id TEXT NOT NULL,
            referred_user_id TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
    `);

    return db;
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

function getOrCreateUser(initData, chatIdFromMessage) {
    const db = initDb();
    const { user, startParam } = parseInitData(initData);
    if (!user) return null;

    const telegramUserId = String(user.id);
    const chatId = chatIdFromMessage || String(user.id);

    const selectStmt = db.prepare('SELECT * FROM users WHERE telegram_user_id = ?');
    let row = selectStmt.get(telegramUserId);

    let refCode;
    if (!row) {
        refCode = generateRefCode(telegramUserId);
        const referredBy = startParam || null;
        const insertStmt = db.prepare(`
            INSERT INTO users (telegram_user_id, chat_id, username, first_name, last_name, balance, ref_code, referred_by)
            VALUES (@telegram_user_id, @chat_id, @username, @first_name, @last_name, @balance, @ref_code, @referred_by)
        `);
        insertStmt.run({
            telegram_user_id: telegramUserId,
            chat_id: chatId,
            username: user.username || null,
            first_name: user.first_name || null,
            last_name: user.last_name || null,
            balance: 0,
            ref_code: refCode,
            referred_by: referredBy
        });
        row = selectStmt.get(telegramUserId);

        // Реферальный бонус при первом входе
        if (referredBy) {
            const referrer = db.prepare('SELECT * FROM users WHERE ref_code = ?').get(referredBy);
            if (referrer) {
                const BONUS_REFERRER = 10;
                const BONUS_NEW = 5;
                db.prepare('UPDATE users SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_user_id = ?')
                    .run(BONUS_REFERRER, referrer.telegram_user_id);
                db.prepare('UPDATE users SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_user_id = ?')
                    .run(BONUS_NEW, telegramUserId);
                db.prepare('INSERT INTO referrals (referrer_user_id, referred_user_id) VALUES (?, ?)')
                    .run(referrer.telegram_user_id, telegramUserId);
            }
        }
    } else {
        // Обновляем chat_id/имена на всякий случай
        db.prepare(`
            UPDATE users
            SET chat_id = @chat_id,
                username = @username,
                first_name = @first_name,
                last_name = @last_name,
                updated_at = CURRENT_TIMESTAMP
            WHERE telegram_user_id = @telegram_user_id
        `).run({
            telegram_user_id: telegramUserId,
            chat_id: chatId,
            username: user.username || null,
            first_name: user.first_name || null,
            last_name: user.last_name || null
        });
        row = selectStmt.get(telegramUserId);
    }

    return row;
}

function getUserByTelegramId(telegramUserId) {
    const db = initDb();
    return db.prepare('SELECT * FROM users WHERE telegram_user_id = ?').get(String(telegramUserId));
}

function getBalance(telegramUserId) {
    const user = getUserByTelegramId(telegramUserId);
    return user ? user.balance : 0;
}

function getReferralStats(telegramUserId) {
    const db = initDb();
    const user = getUserByTelegramId(telegramUserId);
    if (!user) return { refCode: null, referredCount: 0 };
    const countRow = db.prepare('SELECT COUNT(*) as cnt FROM referrals WHERE referrer_user_id = ?').get(String(telegramUserId));
    return {
        refCode: user.ref_code,
        referredCount: countRow.cnt || 0
    };
}

function listUsersWithRefs() {
    const db = initDb();
    const rows = db.prepare(`
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
    `).all();
    return rows;
}

function setUserBalance(telegramUserId, newBalance) {
    const db = initDb();
    const stmt = db.prepare('UPDATE users SET balance = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_user_id = ?');
    const info = stmt.run(newBalance, String(telegramUserId));
    return info.changes > 0;
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

