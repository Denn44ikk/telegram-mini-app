const { initDb, getOrCreateUser, getUserByTelegramId, getUserByUsername, acceptTerms, deleteUserByTelegramId, deleteUserByUsername, deleteAllUsersExcept, adjustUserBalance } = require('../../db');
const { debugLog } = require('../utils/logger');
const { sendText, sendTextWithKeyboard, answerCallbackQuery, answerPreCheckoutQuery } = require('../services/telegram');

const TERMS_TEXT = `📜 Пользовательское соглашение и Политика конфиденциальности

Используя бота, вы соглашаетесь с условиями использования и политикой конфиденциальности сервиса. Мы обрабатываем данные только для работы сервиса и не передаём их третьим лицам в рекламных целях.

Нажмите кнопку ниже, чтобы принять условия и продолжить.`;

const WELCOME_TEXT = (firstName) =>
    `👋 Привет, ${firstName || 'друг'}!\n\n` +
    `Добро пожаловать в наш бот для генерации изображений! 🎨\n\n` +
    `Чтобы воспользоваться всеми возможностями бота, откройте мини-приложение через кнопку ниже 👇`;

const OPEN_APP_TEXT = 'Чтобы воспользоваться нашим ботом — откройте мини-приложение! 🚀';

// Сообщение по команде /info. Контакт: SUPPORT_CONTACT в .env или по умолчанию @proverkadopakk
function getSupportText() {
    const contact = process.env.SUPPORT_CONTACT || '@proverkadopakk';
    return `ℹ️ Информация\n\nПо всем возникающим вопросам или проблемам пиште нашей поддержке: ${contact}`;
}

const KICK_ALLOWED_USERNAME = 'den_bessonovv';

function isKickAllowed(from) {
    const username = (from?.username || '').trim().toLowerCase();
    return username === KICK_ALLOWED_USERNAME.toLowerCase();
}

async function handleKickCommand(text, senderTelegramId) {
    const parts = text.trim().split(/\s+/);
    if (parts.length < 2) {
        return 'Использование: /kick all | /kick id <telegram_id> | /kick <username>';
    }
    const cmd = parts[1].toLowerCase();
    try {
        await initDb();
        if (cmd === 'all') {
            const deleted = await deleteAllUsersExcept(senderTelegramId);
            return `✅ Удалено пользователей: ${deleted}`;
        }
        if (cmd === 'id') {
            const idArg = parts[2];
            if (!idArg) return 'Укажите id: /kick id <telegram_user_id>';
            if (idArg === senderTelegramId) return '❌ Нельзя удалить себя.';
            const ok = await deleteUserByTelegramId(idArg);
            return ok ? `✅ Пользователь с id ${idArg} удалён.` : `❌ Пользователь с id ${idArg} не найден.`;
        }
        const target = parts[1].replace(/^@/, '');
        if (target.toLowerCase() === KICK_ALLOWED_USERNAME.toLowerCase()) {
            return '❌ Нельзя удалить себя.';
        }
        const ok = await deleteUserByUsername(target);
        return ok ? `✅ Пользователь @${target} удалён.` : `❌ Пользователь @${target} не найден.`;
    } catch (e) {
        debugLog('KICK COMMAND ERROR', e.message);
        return '❌ Ошибка: ' + e.message;
    }
}

/** Команда для админа den_bessonovv: пополнение баланса пользователя без оплаты. /balance username сумма */
async function handleBalanceCommand(text, senderTelegramId) {
    const parts = text.trim().split(/\s+/);
    if (parts.length < 3) {
        return 'Использование: /balance <username> <сумма>\nПример: /balance ivanov 100';
    }
    const username = parts[1].replace(/^@/, '').trim();
    const amount = parseInt(parts[2], 10);
    if (!username || isNaN(amount) || amount <= 0) {
        return 'Укажите username (без @) и целую положительную сумму.';
    }
    try {
        await initDb();
        const user = await getUserByUsername(username);
        if (!user) {
            return `❌ Пользователь @${username} не найден.`;
        }
        await adjustUserBalance(user.telegram_user_id, amount);
        return `✅ Баланс пользователя @${username} пополнен на ${amount} BNB. Текущий баланс: ${(user.balance || 0) + amount} BNB.`;
    } catch (e) {
        debugLog('BALANCE COMMAND ERROR', e.message);
        return '❌ Ошибка: ' + e.message;
    }
}

async function handleTelegramWebhook(req, res) {
    try {
        console.log('\n🔔 WEBHOOK RECEIVED - RAW BODY:', JSON.stringify(req.body, null, 2));
        const update = req.body;

        if (!update) {
            debugLog('TELEGRAM WEBHOOK', '❌ No body received');
            return res.status(400).json({ ok: false, error: 'No body' });
        }

        debugLog('TELEGRAM WEBHOOK', {
            hasMessage: !!update.message,
            hasCallbackQuery: !!update.callback_query,
            messageText: update.message?.text,
            updateId: update.update_id
        });

        if (update.pre_checkout_query) {
            const pq = update.pre_checkout_query;
            const queryId = pq.id;
            const payload = pq.invoice_payload || '{}';
            let ok = true;
            let errorMessage = '';
            try {
                const data = JSON.parse(payload);
                if (!data.telegram_user_id || data.amount == null) {
                    ok = false;
                    errorMessage = 'Неверные данные платежа. Попробуйте снова.';
                }
            } catch (e) {
                ok = false;
                errorMessage = 'Ошибка данных платежа.';
            }
            await answerPreCheckoutQuery(queryId, ok, errorMessage);
            debugLog('TELEGRAM PRE_CHECKOUT', { queryId, ok });
            res.json({ ok: true });
            return;
        }

        if (update.message?.successful_payment) {
            const msg = update.message;
            const payment = msg.successful_payment;
            const payload = payment.invoice_payload || '{}';
            const telegramPaymentChargeId = payment.telegram_payment_charge_id;
            let telegramUserId;
            let amountBnb;
            try {
                const data = JSON.parse(payload);
                telegramUserId = data.telegram_user_id;
                amountBnb = parseInt(data.amount_bnb, 10);
            } catch (e) {
                debugLog('TELEGRAM SUCCESSFUL_PAYMENT PARSE ERROR', { error: e.message, payload });
                res.json({ ok: true });
                return;
            }
            if (telegramUserId && !isNaN(amountBnb) && amountBnb > 0) {
                try {
                    await initDb();
                    await adjustUserBalance(String(telegramUserId), amountBnb);
                    debugLog('TELEGRAM SUCCESSFUL_PAYMENT', { telegramUserId, amountBnb, telegramPaymentChargeId });
                } catch (e) {
                    debugLog('TELEGRAM SUCCESSFUL_PAYMENT BALANCE ERROR', { error: e.message });
                }
            }
            res.json({ ok: true });
            return;
        }

        if (update.callback_query) {
            const cb = update.callback_query;
            const chatId = cb.message?.chat?.id;
            const data = cb.data;
            const userId = cb.from?.id;

            if (data === 'terms_accept' && chatId && userId) {
                await answerCallbackQuery(cb.id, 'Спасибо! Соглашение принято.');
                const ok = await acceptTerms(String(userId));
                if (ok) {
                    await sendText(chatId, WELCOME_TEXT(cb.from?.first_name));
                    await sendText(chatId, OPEN_APP_TEXT);
                }
            }
            res.json({ ok: true });
            return;
        }

        if (update.message) {
            const chatId = update.message.chat.id;
            const text = (update.message.text || '').trim();
            const user = update.message.from;

            if (text.startsWith('/start')) {
                const startParam = text.split(' ')[1] || null;
                debugLog('TELEGRAM /start', { chatId, userId: user.id, startParam });

                let userRow = null;
                try {
                    const fakeInitData = startParam
                        ? `user=${encodeURIComponent(JSON.stringify(user))}&start_param=${startParam}`
                        : `user=${encodeURIComponent(JSON.stringify(user))}`;

                    await initDb();
                    userRow = await getOrCreateUser(fakeInitData, chatId);
                } catch (e) {
                    debugLog('TELEGRAM /start DB ERROR', e.message);
                }

                const termsAccepted = userRow && userRow.terms_accepted_at;
                if (!termsAccepted) {
                    await sendTextWithKeyboard(chatId, TERMS_TEXT, [
                        [{ text: '✅ Принять пользовательское соглашение и политику конфиденциальности', callback_data: 'terms_accept' }]
                    ]);
                } else {
                    await sendText(chatId, WELCOME_TEXT(user.first_name));
                    await sendText(chatId, OPEN_APP_TEXT);
                }
            } else if (text === '/info') {
                await sendText(chatId, getSupportText());
            } else if (isKickAllowed(user) && (text.toLowerCase().startsWith('/kick ') || text.toLowerCase() === '/kick')) {
                const reply = await handleKickCommand(text, String(user.id));
                await sendText(chatId, reply);
            } else if (isKickAllowed(user) && (text.toLowerCase().startsWith('/balance ') || text.toLowerCase() === '/balance')) {
                const reply = await handleBalanceCommand(text, String(user.id));
                await sendText(chatId, reply);
            } else if (text.trim()) {
                debugLog('TELEGRAM MESSAGE', { chatId, userId: user.id, text: text.substring(0, 50) });
                await sendText(chatId, OPEN_APP_TEXT);
            }
        }

        res.json({ ok: true });
    } catch (e) {
        console.error('\n❌ WEBHOOK ERROR:', e);
        debugLog('TELEGRAM WEBHOOK ERROR', {
            message: e.message,
            stack: e.stack,
            body: req.body
        });
        res.status(500).json({ ok: false, error: e.message });
    }
}

module.exports = { handleTelegramWebhook };
