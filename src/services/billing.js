const { adjustUserBalance, getBalance } = require('../../db');
const { debugLog } = require('../utils/logger');

/** Стоимость одного фото: Стандарт 15, Про 30 */
const PRICE_PER_IMAGE = {
    'google/gemini-2.5-flash-image': 15,
    'google/gemini-3-pro-image-preview': 30
};

function getPricePerImage(modelId) {
    return PRICE_PER_IMAGE[modelId] ?? 15;
}

/** Для обратной совместимости (цена за 1 фото) */
function getPriceForModel(modelId) {
    return getPricePerImage(modelId);
}

/**
 * Максимальная стоимость запроса до генерации.
 * mode: 'gen' | 'product' | 'poses' | 'ref'
 * count: для poses — количество поз (1–10)
 */
function getMaxCost(modelId, mode, count = 1) {
    const price = getPricePerImage(modelId);
    if (mode === 'gen' || mode === 'ref') return price;
    if (mode === 'product') return price * 5;
    if (mode === 'poses') return price * Math.min(Math.max(1, parseInt(count, 10) || 1), 10);
    return price;
}

/**
 * Проверяет, может ли пользователь позволить себе запрос (баланс не минус и хватает на макс. стоимость).
 */
async function canAfford(telegramUserId, modelId, mode, count = 1) {
    if (!telegramUserId) return false;
    try {
        const balance = await getBalance(telegramUserId);
        if (balance < 0) return false;
        const maxCost = getMaxCost(modelId, mode, count);
        return balance >= maxCost;
    } catch (e) {
        debugLog('BILLING CAN_AFFORD ERROR', { message: e.message, telegramUserId });
        return false;
    }
}

/**
 * Возвращает данные для проверки баланса: хватает ли средств и сколько не хватает.
 * @returns { Promise<{ allowed: boolean, balance: number, required: number, shortfall: number }> }
 */
async function getBalanceCheck(telegramUserId, modelId, mode, count = 1) {
    const required = getMaxCost(modelId, mode, count);
    if (!telegramUserId) {
        return { allowed: false, balance: 0, required, shortfall: required };
    }
    try {
        const balance = await getBalance(telegramUserId);
        const shortfall = Math.max(0, required - balance);
        const allowed = balance >= 0 && balance >= required;
        return { allowed, balance, required, shortfall };
    } catch (e) {
        debugLog('BILLING GET_BALANCE_CHECK ERROR', { message: e.message, telegramUserId });
        return { allowed: false, balance: 0, required, shortfall: required };
    }
}

/**
 * Списывает с баланса стоимость за фактически отправленные клиенту фото.
 * context: { mode, images } — images = количество отправленных фото.
 * Если баланс недостаточен или отрицательный — списание не выполняется.
 */
async function chargeUserForModel(telegramUserId, modelId, context) {
    const imageCount = Math.max(0, parseInt(context?.images, 10) || 1);
    const pricePerImage = getPricePerImage(modelId);
    const totalCost = imageCount * pricePerImage;

    if (!telegramUserId || totalCost <= 0) return { charged: false, price: totalCost };

    try {
        const balance = await getBalance(telegramUserId);
        if (balance < 0) {
            debugLog('BILLING CHARGE SKIP', { reason: 'negative_balance', telegramUserId, balance });
            return { charged: false, price: totalCost };
        }
        if (balance < totalCost) {
            debugLog('BILLING CHARGE SKIP', { reason: 'insufficient_balance', telegramUserId, balance, totalCost });
            return { charged: false, price: totalCost };
        }

        const result = await adjustUserBalance(telegramUserId, -totalCost);
        debugLog('BILLING CHARGE', {
            telegramUserId,
            modelId,
            imageCount,
            pricePerImage,
            totalCost,
            newBalance: result?.balance,
            context
        });
        return { charged: true, price: totalCost, balance: result?.balance };
    } catch (e) {
        debugLog('BILLING CHARGE ERROR', { message: e.message, telegramUserId, modelId, totalCost, context });
        return { charged: false, price: totalCost };
    }
}

module.exports = {
    chargeUserForModel,
    getPriceForModel,
    getPricePerImage,
    getMaxCost,
    canAfford,
    getBalanceCheck
};
