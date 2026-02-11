const { adjustUserBalance } = require('../../db');
const { debugLog } = require('../utils/logger');

const MODEL_PRICES = {
    'google/gemini-2.5-flash-image': 10,
    'google/gemini-3-pro-image-preview': 25
};

function getPriceForModel(modelId) {
    return MODEL_PRICES[modelId] || 0;
}

async function chargeUserForModel(telegramUserId, modelId, context) {
    const price = getPriceForModel(modelId);
    if (!telegramUserId || price <= 0) return { charged: false, price };
    try {
        const result = await adjustUserBalance(telegramUserId, -price);
        debugLog('BILLING CHARGE', {
            telegramUserId,
            modelId,
            price,
            newBalance: result?.balance,
            context
        });
        return { charged: true, price, balance: result?.balance };
    } catch (e) {
        debugLog('BILLING CHARGE ERROR', { message: e.message, telegramUserId, modelId, price, context });
        return { charged: false, price };
    }
}

module.exports = { chargeUserForModel, getPriceForModel };
