const { initDb, getOrCreateUser } = require('../../db');
const { debugLog } = require('../utils/logger');
const { sendText } = require('../services/telegram');

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

        if (update.message) {
            const chatId = update.message.chat.id;
            const text = update.message.text || '';
            const user = update.message.from;

            if (text.startsWith('/start')) {
                const startParam = text.split(' ')[1] || null;
                debugLog('TELEGRAM /start', { chatId, userId: user.id, startParam });

                try {
                    const fakeInitData = startParam
                        ? `user=${encodeURIComponent(JSON.stringify(user))}&start_param=${startParam}`
                        : `user=${encodeURIComponent(JSON.stringify(user))}`;

                    await initDb();
                    await getOrCreateUser(fakeInitData, chatId);
                } catch (e) {
                    debugLog('TELEGRAM /start DB ERROR', e.message);
                }

                const welcomeText = `👋 Привет, ${user.first_name || 'друг'}!\n\n` +
                    `Добро пожаловать в наш бот для генерации изображений! 🎨\n\n` +
                    `Чтобы воспользоваться всеми возможностями бота, откройте мини-приложение через кнопку ниже 👇`;

                await sendText(chatId, welcomeText);
                await sendText(chatId, 'Чтобы воспользоваться нашим ботом — откройте мини-приложение! 🚀');
            }
            else if (text.trim()) {
                debugLog('TELEGRAM MESSAGE', { chatId, userId: user.id, text: text.substring(0, 50) });
                await sendText(chatId, 'Чтобы воспользоваться нашим ботом — откройте мини-приложение! 🚀');
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
