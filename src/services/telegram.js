const axios = require('axios');
const FormData = require('form-data');
const { debugLog } = require('../utils/logger');
const { fixBase64 } = require('../utils/telegram');

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function sendText(chatId, text) {
    try {
        if (!TG_TOKEN) {
            debugLog('SEND_TEXT ERROR', 'TELEGRAM_BOT_TOKEN not set in .env');
            return false;
        }
        debugLog('SEND_TEXT', { chatId, textLength: text.length, textSnippet: text.substring(0, 100) });
        const response = await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
            chat_id: chatId,
            text: text
        });
        debugLog('SEND_TEXT SUCCESS', { messageId: response.data?.result?.message_id });
        return true;
    } catch (e) {
        debugLog('SEND_TEXT ERROR', {
            error: e.message,
            response: e.response?.data,
            chatId,
            hasToken: !!TG_TOKEN
        });
        return false;
    }
}

/** Отправить сообщение с inline-кнопкой (reply_markup.inline_keyboard) */
async function sendTextWithKeyboard(chatId, text, inlineKeyboard) {
    try {
        if (!TG_TOKEN) {
            debugLog('SEND_TEXT_KEYBOARD ERROR', 'TELEGRAM_BOT_TOKEN not set in .env');
            return false;
        }
        const response = await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
            chat_id: chatId,
            text: text,
            reply_markup: { inline_keyboard: inlineKeyboard }
        });
        debugLog('SEND_TEXT_KEYBOARD SUCCESS', { messageId: response.data?.result?.message_id });
        return true;
    } catch (e) {
        debugLog('SEND_TEXT_KEYBOARD ERROR', { error: e.message, chatId });
        return false;
    }
}

/** Ответ на callback_query (обязательно вызвать, иначе кнопка «висит») */
async function answerCallbackQuery(callbackQueryId, text) {
    try {
        if (!TG_TOKEN) return false;
        await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/answerCallbackQuery`, {
            callback_query_id: callbackQueryId,
            text: text || 'Принято'
        });
        return true;
    } catch (e) {
        debugLog('ANSWER_CALLBACK ERROR', e.message);
        return false;
    }
}

/** Установить команды бота (меню справа от поля ввода). Вызывается при старте сервера — после изменений перезапустите сервер. */
async function setBotCommands() {
    try {
        if (!TG_TOKEN) return false;
        await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/setMyCommands`, {
            commands: [
                { command: 'start', description: 'Запуск бота' },
                { command: 'info', description: 'Информация и контакты для вопросов' }
            ]
        });
        debugLog('SET_BOT_COMMANDS', 'ok');
        return true;
    } catch (e) {
        debugLog('SET_BOT_COMMANDS ERROR', e.message);
        return false;
    }
}

async function sendMediaGroupToTelegram(chatId, imageUrls, caption) {
    try {
        if (!TG_TOKEN) {
            debugLog('TELEGRAM MEDIAGROUP ERROR', 'TELEGRAM_BOT_TOKEN not set in .env');
            return false;
        }
        const hasDataUrls = imageUrls.some(u => u.startsWith('data:'));
        const captionText = `🎨 Фотосессия: "${(caption || '').substring(0, 900)}"`;

        if (hasDataUrls) {
            const form = new FormData();
            form.append('chat_id', chatId);
            const media = [];
            for (let i = 0; i < imageUrls.length; i++) {
                const url = imageUrls[i];
                const key = `file${i}`;
                media.push({ type: 'document', media: `attach://${key}`, caption: i === 0 ? captionText : undefined });
                if (url.startsWith('data:')) {
                    const base64 = url.split(';base64,').pop();
                    form.append(key, Buffer.from(fixBase64(base64), 'base64'), { filename: 'gen.png' });
                } else {
                    const stream = await axios.get(url, { responseType: 'stream', timeout: 20000 });
                    form.append(key, stream.data, { filename: 'gen.png' });
                }
            }
            form.append('media', JSON.stringify(media));
            await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMediaGroup`, form, { headers: form.getHeaders() });
        } else {
            const media = imageUrls.map((url, i) => ({
                type: 'document',
                media: url,
                caption: i === 0 ? captionText : undefined
            }));
            await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMediaGroup`, { chat_id: chatId, media });
        }
        debugLog('TELEGRAM', `✅ Отправлен альбом из ${imageUrls.length} фото`);
        return true;
    } catch (e) {
        debugLog('TELEGRAM MEDIAGROUP ERROR', e.response?.data || e.message);
        return false;
    }
}

async function sendToTelegram(chatId, resource, caption, isDocument) {
    try {
        if (!TG_TOKEN) {
            debugLog('TELEGRAM ERROR', 'TELEGRAM_BOT_TOKEN not set in .env');
            return false;
        }
        const form = new FormData();
        form.append('chat_id', chatId);

        const finalCaption = caption
            ? `🎨 Ваш арт: "${caption}"`
            : '🎨 Ваш арт';
        form.append('caption', finalCaption.substring(0, 1000));

        const isUrl = resource.startsWith('http');
        const isData = resource.startsWith('data:');

        if (isUrl) {
            debugLog('TELEGRAM', `Скачиваю: ${resource.substring(0, 30)}...`);
            try {
                const stream = await axios.get(resource, {
                    responseType: 'stream',
                    timeout: 20000,
                    headers: { 'User-Agent': 'Mozilla/5.0' }
                });
                form.append(isDocument ? 'document' : 'photo', stream.data, { filename: 'gen.png' });
            } catch (e) {
                debugLog('DOWNLOAD ERROR', e.message);
                throw new Error('Не удалось скачать файл');
            }
        }
        else if (isData) {
            debugLog('TELEGRAM', 'Обрабатываю Base64...');
            let base64Data = resource.split(';base64,').pop();
            base64Data = fixBase64(base64Data);
            const buffer = Buffer.from(base64Data, 'base64');
            form.append(isDocument ? 'document' : 'photo', buffer, { filename: 'gen.png' });
        }

        const method = isDocument ? 'sendDocument' : 'sendPhoto';
        await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, form, { headers: form.getHeaders() });
        debugLog('TELEGRAM', '✅ Отправлено!');
        return true;
    } catch (e) {
        debugLog('TELEGRAM ERROR', e.response?.data || e.message);
        return false;
    }
}

module.exports = { sendText, sendTextWithKeyboard, answerCallbackQuery, setBotCommands, sendMediaGroupToTelegram, sendToTelegram };
