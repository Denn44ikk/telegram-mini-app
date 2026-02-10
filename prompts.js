// prompts.js
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');

/** Доступные модели для генерации изображений (OpenRouter) */
const AVAILABLE_MODELS = [
    { id: 'google/gemini-3-pro-image-preview', name: 'Nano Banana Pro' },
    { id: 'google/gemini-2.5-flash-image', name: 'Nano Banana' },
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

/** Текст + референс — пользователь прикрепил одно фото и дал инструкции. %s = userPrompt */
const PROMPT_GEN_WITH_IMAGE = 'Analyze this reference image and generate a NEW high-quality image based on these instructions: "%s". Return ONLY the image.';

// ========== ПРОМПТЫ ФОТОСЕССИИ / ПОЗ / ДВА РЕФЕРЕНСА ==========
// Используются в «Фотосессия с продуктом», «Случайные позы» и «Фото по референсу (2 фото)».

/** Фотосессия: продукт + описание окружения/фона. %s = userPrompt */
const PROMPT_PRODUCT = 'Place this product photo into a professional product photography scene. Environment and style: "%s". Keep the product clearly visible and well-lit. Return ONLY the image.';

/** Случайные позы: одно фото человека + пожелания. %s = userPrompt (включая количество поз и стили). */
const PROMPT_POSES = 'Using this person photo as identity reference, generate a NEW pose according to these wishes: "%s". Keep the same person, clothing style and overall look. Return ONLY the image.';

/** Два фото: первое — референс (стиль/ракурс), второе — основное (человек/объект). %s = userPrompt */
const PROMPT_REF_PAIR = 'You are given TWO images. The FIRST image is a style/composition reference. The SECOND image contains the main subject. Following these instructions: "%s", transform the SECOND image to match the style/angle/mood of the FIRST one, while preserving the identity of the person/object from the SECOND image. Return ONLY the final image.';

/**
 * Подставляет userPrompt в шаблон (поддержка одной подстановки %s).
 */
function applyPrompt(template, userPrompt) {
    return template.replace('%s', userPrompt);
}

/**
 * Собирает сообщения для API. mode: 'gen' | 'product' | 'poses'.
 * gen — экран «Фото по промту» (с картинкой или без).
 * product — экран «Фотосессия с продуктом» (всегда с картинкой продукта).
 */
function buildMessages(userPrompt, imageBase64, mode) {
    mode = mode || 'gen';
    const messages = [
        { role: "system", content: SYSTEM_PROMPT }
    ];

    if (imageBase64) {
        let textTemplate;
        if (mode === 'product') textTemplate = PROMPT_PRODUCT;
        else if (mode === 'poses') textTemplate = PROMPT_POSES;
        else textTemplate = PROMPT_GEN_WITH_IMAGE;

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

/**
 * Собирает сообщения для режима «Фото по референсу (2 фото)».
 * Первое изображение — референс (стиль), второе — основа (человек/объект).
 */
function buildRefPairMessages(userPrompt, refImageBase64, targetImageBase64) {
    const messages = [
        { role: "system", content: SYSTEM_PROMPT }
    ];

    const text = applyPrompt(PROMPT_REF_PAIR, userPrompt);
    messages.push({
        role: "user",
        content: [
            { type: "text", text },
            { type: "image_url", image_url: { url: refImageBase64 } },
            { type: "image_url", image_url: { url: targetImageBase64 } },
        ]
    });

    return messages;
}

module.exports = {
    buildMessages,
    buildRefPairMessages,
    getModelId,
    setModelId,
    getAvailableModels,
};