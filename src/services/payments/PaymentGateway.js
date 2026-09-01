const MidtransAdapter = require('./adapters/MidtransAdapter');
const XenditAdapter = require('./adapters/XenditAdapter');

class PaymentGateway {
    static getAdapter(provider) {
        const normalizedProvider =
            String(provider || '').trim().toUpperCase();

        switch (normalizedProvider) {
            case 'MIDTRANS':
                return MidtransAdapter;

            case 'XENDIT':
                return XenditAdapter;

            default:
                throw new Error(
                    `Payment provider tidak didukung: ${normalizedProvider}`
                );
        }
    }

    static async createPaymentIntent(payload) {
        const adapter = this.getAdapter(payload.provider);

        return adapter.createPaymentIntent(payload);
    }


    static async getTransactionStatus(payload) {
        const adapter =
            this.getAdapter(payload.provider);

        if (
            typeof adapter.getTransactionStatus !==
            'function'
        ) {
            throw new Error(
                `Status provider belum didukung: ${String(
                    payload.provider || ''
                ).toUpperCase()}`
            );
        }

        return adapter.getTransactionStatus(payload);
    }


}

module.exports = PaymentGateway;
