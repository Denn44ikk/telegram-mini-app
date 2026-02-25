const mysql = require('mysql2/promise');

let pool;

function dbLog(operation, data) {
    const time = new Date().toLocaleTimeString('ru-RU');
    console.log(`\n🗄️  [${time}] DB ${operation}`);
    if (data !== undefined) {
        try {
            console.log(JSON.stringify(data, null, 2));
        } catch (e) {
            console.log('[DB Log Error]', data);
        }
    }
}

async function initDb() {
    if (pool) {
        dbLog('INIT', 'Pool already exists, reusing');
        return pool;
    }

    dbLog('INIT', {
        host: process.env.DB_HOST || 'localhost',
        port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
        user: process.env.DB_USER,
        database: process.env.DB_NAME,
        hasPassword: !!process.env.DB_PASSWORD
    });

    try {
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

        dbLog('INIT', '✅ Connection pool created');

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
                terms_accepted_at DATETIME NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                KEY idx_users_telegram_id (telegram_user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        dbLog('INIT', '✅ Table users created/verified');

        await pool.query(`
            ALTER TABLE users ADD COLUMN terms_accepted_at DATETIME NULL
        `).catch(() => {});

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

        dbLog('INIT', '✅ Table referrals created/verified');

        return pool;
    } catch (error) {
        dbLog('INIT ERROR', { message: error.message, code: error.code });
        throw error;
    }
}

function generateRefCode(telegramUserId) {
    const base = String(telegramUserId || '');
    const hash = [...base].reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) >>> 0, 0);
    return 'NB' + hash.toString(36).toUpperCase();
}

function parseInitData(initData) {
    try {
        dbLog('PARSE_INIT_DATA', { 
            hasInitData: !!initData,
            initDataLength: initData ? initData.length : 0,
            initDataSnippet: initData ? initData.substring(0, 100) : null
        });
        const params = new URLSearchParams(initData || '');
        const userJson = params.get('user');
        const user = userJson ? JSON.parse(userJson) : null;
        const startParam = params.get('start_param') || params.get('startapp') || null;
        dbLog('PARSE_INIT_DATA RESULT', { 
            hasUser: !!user,
            userId: user?.id,
            username: user?.username,
            startParam
        });
        return { user, startParam };
    } catch (e) {
        dbLog('PARSE_INIT_DATA ERROR', { error: e.message });
        return { user: null, startParam: null };
    }
}

async function getOrCreateUser(initData, chatIdFromMessage) {
    try {
        dbLog('GET_OR_CREATE_USER', { 
            hasInitData: !!initData,
            chatIdFromMessage,
            initDataSnippet: initData ? initData.substring(0, 150) : null
        });

        const db = await initDb();
        const { user, startParam } = parseInitData(initData);
        
        if (!user) {
            dbLog('GET_OR_CREATE_USER', '❌ No user in initData, returning null');
            return null;
        }

        const telegramUserId = String(user.id);
        const chatId = chatIdFromMessage || String(user.id);

        dbLog('GET_OR_CREATE_USER', { telegramUserId, chatId, username: user.username });

        const [rows] = await db.execute('SELECT * FROM users WHERE telegram_user_id = ?', [telegramUserId]);
        let row = rows[0];

        let refCode;
        if (!row) {
            dbLog('GET_OR_CREATE_USER', '🆕 Creating new user');
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
                    30,
                    refCode,
                    referredBy
                ]
            );

            dbLog('GET_OR_CREATE_USER', { 
                action: 'INSERT',
                telegramUserId,
                refCode,
                referredBy
            });

            const [rowsAfterInsert] = await db.execute('SELECT * FROM users WHERE telegram_user_id = ?', [telegramUserId]);
            row = rowsAfterInsert[0];

            dbLog('GET_OR_CREATE_USER', { 
                action: 'INSERT_SUCCESS',
                userId: row?.id,
                refCode: row?.ref_code
            });

            // Реферальный бонус при первом входе
            if (referredBy) {
                dbLog('GET_OR_CREATE_USER', { action: 'CHECKING_REFERRAL', referredBy });
                const [refRows] = await db.execute('SELECT * FROM users WHERE ref_code = ?', [referredBy]);
                const referrer = refRows[0];
                if (referrer) {
                    dbLog('GET_OR_CREATE_USER', { 
                        action: 'APPLYING_REFERRAL_BONUS',
                        referrerId: referrer.telegram_user_id,
                        newUserId: telegramUserId
                    });
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
                    dbLog('GET_OR_CREATE_USER', '✅ Referral bonus applied');
                } else {
                    dbLog('GET_OR_CREATE_USER', '⚠️ Referrer not found for code: ' + referredBy);
                }
            }
        } else {
            dbLog('GET_OR_CREATE_USER', { 
                action: 'UPDATE_EXISTING',
                userId: row.id,
                existingRefCode: row.ref_code
            });
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
            dbLog('GET_OR_CREATE_USER', '✅ User updated');
        }

        return row;
    } catch (error) {
        dbLog('GET_OR_CREATE_USER ERROR', { 
            message: error.message,
            code: error.code,
            stack: error.stack
        });
        throw error;
    }
}

async function getUserByTelegramId(telegramUserId) {
    try {
        dbLog('GET_USER_BY_TELEGRAM_ID', { telegramUserId });
        const db = await initDb();
        const [rows] = await db.execute('SELECT * FROM users WHERE telegram_user_id = ?', [String(telegramUserId)]);
        const user = rows[0] || null;
        dbLog('GET_USER_BY_TELEGRAM_ID', { found: !!user, userId: user?.id });
        return user;
    } catch (error) {
        dbLog('GET_USER_BY_TELEGRAM_ID ERROR', { error: error.message });
        throw error;
    }
}

async function getBalance(telegramUserId) {
    try {
        dbLog('GET_BALANCE', { telegramUserId });
        const user = await getUserByTelegramId(telegramUserId);
        const balance = user ? user.balance : 0;
        dbLog('GET_BALANCE', { telegramUserId, balance });
        return balance;
    } catch (error) {
        dbLog('GET_BALANCE ERROR', { error: error.message });
        throw error;
    }
}

async function getReferralStats(telegramUserId) {
    try {
        dbLog('GET_REFERRAL_STATS', { telegramUserId });
        const db = await initDb();
        const user = await getUserByTelegramId(telegramUserId);
        if (!user) {
            dbLog('GET_REFERRAL_STATS', 'User not found');
            return { refCode: null, referredCount: 0 };
        }
        const [rows] = await db.execute(
            'SELECT COUNT(*) as cnt FROM referrals WHERE referrer_user_id = ?',
            [String(telegramUserId)]
        );
        const countRow = rows[0] || { cnt: 0 };
        const result = {
            refCode: user.ref_code,
            referredCount: countRow.cnt || 0
        };
        dbLog('GET_REFERRAL_STATS', result);
        return result;
    } catch (error) {
        dbLog('GET_REFERRAL_STATS ERROR', { error: error.message });
        throw error;
    }
}

async function listUsersWithRefs() {
    try {
        dbLog('LIST_USERS_WITH_REFS', 'Fetching all users');
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
        dbLog('LIST_USERS_WITH_REFS', { count: rows.length });
        return rows;
    } catch (error) {
        dbLog('LIST_USERS_WITH_REFS ERROR', { error: error.message });
        throw error;
    }
}

async function acceptTerms(telegramUserId) {
    try {
        const db = await initDb();
        const [result] = await db.execute(
            'UPDATE users SET terms_accepted_at = NOW() WHERE telegram_user_id = ?',
            [String(telegramUserId)]
        );
        return result.affectedRows > 0;
    } catch (error) {
        dbLog('ACCEPT_TERMS ERROR', { error: error.message });
        throw error;
    }
}

async function setUserBalance(telegramUserId, newBalance) {
    try {
        dbLog('SET_USER_BALANCE', { telegramUserId, newBalance });
        const db = await initDb();
        const [result] = await db.execute(
            'UPDATE users SET balance = ? WHERE telegram_user_id = ?',
            [newBalance, String(telegramUserId)]
        );
        const success = result.affectedRows > 0;
        dbLog('SET_USER_BALANCE', { success, affectedRows: result.affectedRows });
        return success;
    } catch (error) {
        dbLog('SET_USER_BALANCE ERROR', { error: error.message });
        throw error;
    }
}

async function adjustUserBalance(telegramUserId, delta) {
    try {
        dbLog('ADJUST_USER_BALANCE', { telegramUserId, delta });
        const db = await initDb();
        await db.execute(
            'UPDATE users SET balance = balance + ? WHERE telegram_user_id = ?',
            [delta, String(telegramUserId)]
        );
        const user = await getUserByTelegramId(telegramUserId);
        return user;
    } catch (error) {
        dbLog('ADJUST_USER_BALANCE ERROR', { error: error.message });
        throw error;
    }
}

/** Удалить пользователя по telegram_user_id (и связанные записи в referrals) */
async function deleteUserByTelegramId(telegramUserId) {
    try {
        const db = await initDb();
        const tid = String(telegramUserId);
        await db.execute('DELETE FROM referrals WHERE referrer_user_id = ? OR referred_user_id = ?', [tid, tid]);
        const [result] = await db.execute('DELETE FROM users WHERE telegram_user_id = ?', [tid]);
        dbLog('DELETE_USER_BY_TELEGRAM_ID', { telegramUserId: tid, deleted: result.affectedRows > 0 });
        return result.affectedRows > 0;
    } catch (error) {
        dbLog('DELETE_USER_BY_TELEGRAM_ID ERROR', { error: error.message });
        throw error;
    }
}

/** Удалить пользователя по username (без @) */
async function deleteUserByUsername(username) {
    try {
        const db = await initDb();
        const name = String(username).replace(/^@/, '').trim();
        const [rows] = await db.execute('SELECT telegram_user_id FROM users WHERE username = ?', [name]);
        const user = rows[0];
        if (!user) {
            dbLog('DELETE_USER_BY_USERNAME', { username: name, found: false });
            return false;
        }
        return deleteUserByTelegramId(user.telegram_user_id);
    } catch (error) {
        dbLog('DELETE_USER_BY_USERNAME ERROR', { error: error.message });
        throw error;
    }
}

/** Удалить всех пользователей кроме указанного telegram_user_id */
async function deleteAllUsersExcept(telegramUserId) {
    try {
        const db = await initDb();
        const keepId = String(telegramUserId);
        const [users] = await db.execute('SELECT telegram_user_id FROM users WHERE telegram_user_id != ?', [keepId]);
        let deleted = 0;
        for (const u of users) {
            await db.execute('DELETE FROM referrals WHERE referrer_user_id = ? OR referred_user_id = ?', [u.telegram_user_id, u.telegram_user_id]);
            const [r] = await db.execute('DELETE FROM users WHERE telegram_user_id = ?', [u.telegram_user_id]);
            deleted += r.affectedRows;
        }
        dbLog('DELETE_ALL_USERS_EXCEPT', { keepId, deleted });
        return deleted;
    } catch (error) {
        dbLog('DELETE_ALL_USERS_EXCEPT ERROR', { error: error.message });
        throw error;
    }
}

module.exports = {
    initDb,
    getOrCreateUser,
    getUserByTelegramId,
    getBalance,
    getReferralStats,
    listUsersWithRefs,
    setUserBalance,
    adjustUserBalance,
    acceptTerms,
    deleteUserByTelegramId,
    deleteUserByUsername,
    deleteAllUsersExcept
};

