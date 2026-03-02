const ENABLE_DEBUG_LOG = (process.env.DEBUG_LOG || '1') !== '0';

function debugLog(stepName, data) {
    if (!ENABLE_DEBUG_LOG) return;
    const time = new Date().toLocaleTimeString('ru-RU');
    console.log(`\n🔻🔻🔻 [${time}] --- STEP: ${stepName} --- 🔻🔻🔻`);
    if (typeof data === 'string') {
        console.log(data);
    } else {
        try {
            console.log(JSON.stringify(data, null, 2));
        } catch (e) {
            console.log('[JSON Error]', data);
        }
    }
    console.log(`🔺🔺🔺 ----------------------------------------- 🔺🔺🔺\n`);
}

module.exports = { debugLog };
