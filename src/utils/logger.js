function debugLog(stepName, data) {
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
