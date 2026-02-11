function getChatId(initData) {
    try {
        const urlParams = new URLSearchParams(initData);
        const user = JSON.parse(urlParams.get('user'));
        return user.id;
    } catch (e) {
        return null;
    }
}

function fixBase64(str) {
    let fixed = str.replace(/\s/g, '');
    while (fixed.length % 4 !== 0) fixed += '=';
    return fixed;
}

module.exports = { getChatId, fixBase64 };
