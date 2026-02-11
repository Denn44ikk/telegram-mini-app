const axios = require('axios');
const { buildMessages, getModelId } = require('../../prompts');
const { debugLog } = require('../utils/logger');

const AI_REQUEST_TIMEOUT_MS = 180000;

async function callAIWithMessages(messages) {
    const modelId = getModelId();
    try {
        const safeMessages = messages.map((m, idx) => {
            const entry = { role: m.role, idx };
            if (Array.isArray(m.content)) {
                entry.parts = m.content.map((c) => ({
                    type: c.type || (typeof c === 'string' ? 'text' : 'unknown'),
                    hasImageUrl: !!(c.image_url && c.image_url.url),
                    textSnippet: c.text ? String(c.text).substring(0, 60) : undefined
                }));
            } else if (typeof m.content === 'string') {
                entry.textSnippet = m.content.substring(0, 80);
            }
            return entry;
        });
        debugLog('AI CALL PREPARE', { modelId, messagesCount: messages.length, messages: safeMessages });
    } catch (e) {
        debugLog('AI CALL PREPARE ERROR', e.message);
    }

    const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        { model: modelId, messages },
        {
            timeout: AI_REQUEST_TIMEOUT_MS,
            headers: {
                'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://banana-gen.app',
            }
        }
    );

    const choice = response.data.choices?.[0]?.message;
    const content = choice?.content || "";
    debugLog('AI RAW RESPONSE META', {
        hasContent: !!content,
        contentSnippet: typeof content === 'string' ? content.substring(0, 120) : '[non-string]',
        hasImagesArray: Array.isArray(choice?.images) && choice.images.length > 0
    });

    const base64Match = content.match(/(data:image\/[a-zA-Z]*;base64,[^\s"\)]+)/);
    const urlMatch = content.match(/(https?:\/\/[^\s\)]+)/);
    if (base64Match) {
        debugLog('AI PARSE', { type: 'base64', length: base64Match[1].length });
        return base64Match[1];
    }
    if (urlMatch) {
        debugLog('AI PARSE', { type: 'url', urlSnippet: urlMatch[1].substring(0, 120) });
        return urlMatch[1];
    }
    if (choice?.images?.length) {
        const img = choice.images[0];
        if (img.url) {
            debugLog('AI PARSE', { type: 'images[0].url', urlSnippet: img.url.substring(0, 120) });
            return img.url;
        }
        if (img.image_url?.url) {
            debugLog('AI PARSE', { type: 'images[0].image_url.url', urlSnippet: img.image_url.url.substring(0, 120) });
            return img.image_url.url;
        }
    }
    debugLog('AI PARSE ERROR', 'AI не вернул распознаваемый url/base64');
    throw new Error('AI не вернул картинку (пустой ответ).');
}

async function callAI(prompt, imageBase64, mode) {
    const messages = buildMessages(prompt, imageBase64, mode || 'gen');
    return callAIWithMessages(messages);
}

module.exports = { callAIWithMessages, callAI };
