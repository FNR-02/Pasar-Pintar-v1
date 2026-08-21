class XenditAdapter {
    static async createPaymentIntent(payload) {
        return {
            provider: 'XENDIT',
            mode: 'MOCK',
            payment_method: payload.payment_method,
            channel: payload.channel || null,
            amount: Number(payload.amount),
            external_transaction_id: null,
            expires_at: null,
            gateway_response: {
                status: 'NOT_CONNECTED',
                message: 'Xendit adapter belum terhubung ke API vendor'
            }
        };
    }
}

module.exports = XenditAdapter;
