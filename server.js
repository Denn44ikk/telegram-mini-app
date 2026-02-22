require('dotenv').config();
const { createApp } = require('./src/app');
const { getModelId } = require('./prompts');
const { setBotCommands } = require('./src/services/telegram');

const PORT = process.env.PORT || 4000;
const app = createApp();

app.listen(PORT, async () => {
    const keyOk = !!process.env.OPENROUTER_API_KEY;
    console.log(`🚀 SERVER READY: ${getModelId()}`);
    if (!keyOk) console.warn('⚠️  OPENROUTER_API_KEY не задан в .env — генерация не будет работать!');
    setBotCommands().catch(() => {});
});