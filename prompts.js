// prompts.js
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');

/** Доступные модели для генерации изображений (OpenRouter) */
const AVAILABLE_MODELS = [
    { id: 'google/gemini-3-pro-image-preview', name: 'Nano Banana Pro' },
    { id: 'google/gemini-2.0-flash-001', name: 'Gemini 2.0 Flash' },
    { id: 'google/gemini-2.0-flash-exp', name: 'Gemini 2.0 Flash Exp' },
    { id: 'google/gemini-flash-1.5', name: 'Gemini 1.5 Flash' },
    { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
];

function loadConfig() {
    try {
        const data = fs.readFileSync(CONFIG_PATH, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        return { modelId: 'google/gemini-3-pro-image-preview' };
    }
}

function saveConfig(config) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

function getModelId() {
    return loadConfig().modelId || 'google/gemini-3-pro-image-preview';
}

function setModelId(modelId) {
    const config = loadConfig();
    config.modelId = modelId;
    saveConfig(config);
}

function getAvailableModels() {
    return AVAILABLE_MODELS;
}

/**
 * СИСТЕМНЫЙ ПРОМПТ
 * Объясняем AI, что он только генерирует картинки, без болтовни.
 */
const SYSTEM_PROMPT = `
You are a strict Image Generation API. 
You are NOT a chat assistant. You DO NOT converse.
If you cannot generate an image, output "ERROR: Cannot generate".
`;

// ========== ПРОМПТЫ (удобно редактировать) ==========
// Используются в «Фото по промту» (генерация по тексту и опционально по референсу).

/** Только текст — пользователь описал, что нарисовать. %s = userPrompt */
const PROMPT_GEN_TEXT = 'Generate a high-quality image of: "%s".';

/** Текст + референс — пользователь прикрепил фото и дал инструкции. %s = userPrompt */
const PROMPT_GEN_WITH_IMAGE = 'Analyze this reference image and generate a NEW high-quality image based on these instructions: "%s". Return ONLY the image.';

// ========== ПРОМПТЫ ФОТОСЕССИИ ==========
// Используются в «Фотосессия с продуктом» — объект на фото помещается в описанную сцену.

/** Фотосессия: продукт + описание окружения/фона. %s = userPrompt */
const PROMPT_PRODUCT = 'Place this product photo into a professional product photography scene. Environment and style: "%s". Keep the product clearly visible and well-lit. Return ONLY the image.';

/**
 * Подставляет userPrompt в шаблон (поддержка одной подстановки %s).
 */
function applyPrompt(template, userPrompt) {
    return template.replace('%s', userPrompt);
}

/**
 * Собирает сообщения для API. mode: 'gen' | 'product'.
 * gen — экран «Фото по промту» (с картинкой или без).
 * product — экран «Фотосессия с продуктом» (всегда с картинкой продукта).
 */
function buildMessages(userPrompt, imageBase64, mode) {
    mode = mode || 'gen';
    const messages = [
        { role: "system", content: SYSTEM_PROMPT }
    ];

    if (imageBase64) {
        const textTemplate = mode === 'product' ? PROMPT_PRODUCT : PROMPT_GEN_WITH_IMAGE;
        const text = applyPrompt(textTemplate, userPrompt);
        messages.push({
            role: "user",
            content: [
                { type: "text", text },
                { type: "image_url", image_url: { url: imageBase64 } }
            ]
        });
    } else {
        // Только для mode === 'gen' (фото по промту без референса)
        const text = applyPrompt(PROMPT_GEN_TEXT, userPrompt);
        messages.push({ role: "user", content: text });
    }

    return messages;
}

module.exports = {
    buildMessages,
    getModelId,
    setModelId,
    getAvailableModels,
};