// prompts.js

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

// Экспортируем функцию, чтобы её видел server.js
module.exports = { buildMessages };