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
 * Здесь мы объясняем AI, кто он такой.
 * Для Gemini Flash важно жестко запретить болтовню, иначе она пишет "Here is an image...".
 */
const SYSTEM_PROMPT = `
You are a strict Image Generation API. 
You are NOT a chat assistant. You DO NOT converse.
If you cannot generate an image, output "ERROR: Cannot generate".
`;

/**
 * ФУНКЦИЯ СБОРКИ СООБЩЕНИЙ
 * Собирает историю переписки для отправки в нейросеть.
 */
function buildMessages(userPrompt, imageBase64) {
    const messages = [
        {
            role: "system",
            content: SYSTEM_PROMPT
        }
    ];

    if (imageBase64) {
        // --- РЕЖИМ: КАРТИНКА + ТЕКСТ (Vision) ---
        // Используется для "Фотосессии" и "Фото по промту" с референсом
        messages.push({
            role: "user",
            content: [
                { 
                    type: "text", 
                    text: `Analyze this input image and generate a NEW high-quality image based on these instructions: "${userPrompt}". Return ONLY the image URL.` 
                },
                { 
                    type: "image_url", 
                    image_url: { url: imageBase64 } 
                }
            ]
        });
    } else {
        // --- РЕЖИМ: ТОЛЬКО ТЕКСТ ---
        // Используется для обычной генерации
        messages.push({
            role: "user",
            content: `Generate a high-quality image of: "${userPrompt}". Return ONLY the URL.`
        });
    }

    return messages;
}

module.exports = {
    buildMessages,
    getModelId,
    setModelId,
    getAvailableModels,
};