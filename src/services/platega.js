const axios = require('axios');
const { debugLog } = require('../utils/logger');

const PLATEGA_URL = 'https://app.platega.io/transaction/process';

/**
 * Создать платёж в Platega (СБП и др.).
 * @param {Object} opts - amount (число, рубли с копейками, например 100.5), currency, description, returnUrl, failedUrl, payload
 * @param {number} opts.paymentMethod - метод (2 = СБП по примеру из доки)
 * @returns {Promise<{ success: boolean, redirect?: string, transactionId?: string, error?: string }>}
 */
async function createPlategaPayment(opts) {
    const merchantId = process.env.PLATEGA_MERCHANT_ID;
    const secret = process.env.PLATEGA_SECRET;
    if (!merchantId || !secret) {
        debugLog('PLATEGA', 'PLATEGA_MERCHANT_ID или PLATEGA_SECRET не заданы в .env');
        return { success: false, error: 'Платежи Platega не настроены' };
    }
    try {
        const amount = Number(opts.amount);
        if (isNaN(amount) || amount <= 0) {
            return { success: false, error: 'Некорректная сумма' };
        }
        const body = {
            paymentMethod: opts.paymentMethod ?? 2,
            paymentDetails: {
                amount: amount,
                currency: opts.currency || 'RUB'
            },
            description: opts.description || 'Пополнение баланса',
            return: opts.returnUrl || '',
            failedUrl: opts.failedUrl || opts.returnUrl || '',
            payload: opts.payload || ''
        };
        const response = await axios.post(PLATEGA_URL, body, {
            headers: {
                'Content-Type': 'application/json',
                'X-MerchantId': merchantId,
                'X-Secret': secret
            },
            timeout: 15000
        });
        const data = response.data;
        const redirect = data.redirect;
        const transactionId = data.transactionId;
        if (!redirect || !transactionId) {
            debugLog('PLATEGA CREATE', { message: 'No redirect or transactionId', data });
            return { success: false, error: data.message || 'Ошибка создания платежа' };
        }
        debugLog('PLATEGA CREATE', { transactionId, status: data.status });
        return { success: true, redirect, transactionId, status: data.status };
    } catch (e) {
        const msg = e.response?.data?.message || e.response?.data?.error || e.message;
        debugLog('PLATEGA CREATE ERROR', { message: msg, status: e.response?.status });
        return { success: false, error: msg || 'Ошибка запроса к платёжной системе' };
    }
}

/**
 * Проверить статус транзакции вручную (GET).
 * @param {string} transactionId
 * @returns {Promise<Object|null>}
 */
async function getPlategaTransactionStatus(transactionId) {
    const merchantId = process.env.PLATEGA_MERCHANT_ID;
    const secret = process.env.PLATEGA_SECRET;
    if (!merchantId || !secret) return null;
    try {
        const url = `https://app.platega.io/transaction/${transactionId}`;
        const response = await axios.get(url, {
            headers: {
                'Content-Type': 'application/json',
                'X-MerchantId': merchantId,
                'X-Secret': secret
            },
            timeout: 10000
        });
        return response.data || null;
    } catch (e) {
        debugLog('PLATEGA GET STATUS ERROR', { transactionId, message: e.message });
        return null;
    }
}

module.exports = { createPlategaPayment, getPlategaTransactionStatus };
