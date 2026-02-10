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
const PROMPT_GEN_TEXT = 'Generate an ultra high‑resolution, hyper‑realistic photograph of: "%s". Use natural lighting, realistic skin with visible small pores and subtle wrinkles, individual hair strands, detailed eyes, and fabric with fine texture and tiny imperfections. Do NOT over-smooth the image. Return ONLY the image.';

/** Текст + референс — пользователь прикрепил одно фото и дал инструкции. %s = userPrompt */
const PROMPT_GEN_WITH_IMAGE = 'Analyze this reference image and generate a NEW ultra high‑resolution, hyper‑realistic photograph based on these instructions: "%s". Preserve natural skin with small pores and light wrinkles, realistic facial features, detailed hair, and clothing with small imperfections (folds, threads). Do NOT over-smooth the image. Return ONLY the image.';

// ========== ПРОМПТЫ ФОТОСЕССИИ / ПОЗ / ДВА РЕФЕРЕНСА ==========
// Используются в «Фотосессия с продуктом», «Случайные позы» и «Фото по референсу (2 фото)».

/** Фотосессия: продукт + описание окружения/фона. %s = userPrompt */
const PROMPT_PRODUCT = 'Place this product photo into a professional, hyper‑realistic product photography scene. Environment and style: "%s". Keep the product clearly visible and well-lit, with sharp details, realistic reflections and shadows, visible surface texture and tiny imperfections (micro-scratches, fingerprints, fabric fibers). Do NOT over-smooth or cartoonize. Return ONLY the image.';

/** Случайные позы: одно фото человека + пожелания. %s = userPrompt (включая количество поз и стили). */
const PROMPT_POSES = 'Using this person photo as identity reference, generate a NEW pose according to these wishes: "%s". Keep the same person, facial features, skin tone, clothing style and overall look. Make the result an ultra high‑resolution, hyper‑realistic photograph with natural lighting, subtle skin wrinkles and pores, realistic hair strands and fabric folds with small imperfections. Do NOT over-smooth or stylize like illustration. Return ONLY the image.';

/** Два фото: первое — референс (стиль/ракурс), второе — основное (человек/объект). %s = userPrompt */
const PROMPT_REF_PAIR = 'You are given TWO images. The FIRST image is a style, composition and pose reference. The SECOND image contains the main subject (person or object) whose identity must be preserved. Following these instructions: "%s", transform the SECOND image so that it matches the camera angle, pose, lighting, color palette and overall mood of the FIRST image, while strictly preserving the face, body proportions and recognizable details of the subject from the SECOND image. The final result must look like an ultra high‑resolution, hyper‑realistic photograph with natural skin (small pores, light wrinkles), realistic hair and detailed clothing with tiny imperfections (folds, seams, threads). Do NOT over-smooth, do NOT make plastic or cartoon faces. Return ONLY the final image.';

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