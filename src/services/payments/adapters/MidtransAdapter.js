const midtransClient = require('midtrans-client');

class MidtransAdapter {
    static getClient() {
        const serverKey = process.env.MIDTRANS_SERVER_KEY;

        if (!serverKey) {
            throw new Error('MIDTRANS_SERVER_KEY belum dikonfigurasi');
        }

        return new midtransClient.CoreApi({
            isProduction:
                String(process.env.MIDTRANS_IS_PRODUCTION).toLowerCase()
                    === 'true',
            serverKey,
            clientKey: process.env.MIDTRANS_CLIENT_KEY || ''
        });
    }

    static async createPaymentIntent(payload) {
        const method =
            String(payload.payment_method || '').toUpperCase();

        const channel =
            payload.channel
                ? String(payload.channel).toUpperCase()
                : null;

        if (method === 'VIRTUAL_ACCOUNT') {
            return this.createVirtualAccount(payload, channel);
        }

        if (method === 'BANK_TRANSFER') {
            return this.createVirtualAccount(payload, channel);
        }

        if (method === 'QRIS') {
            return this.createQris(payload);
        }

        throw new Error(
            `Metode Midtrans belum didukung: ${method}`
        );
    }

    static async createQris(payload) {
        const coreApi = this.getClient();

        const parameter = {
            payment_type: 'qris',

            transaction_details: {
                order_id: payload.order_id,
                gross_amount: Number(payload.amount)
            }
        };

        const response =
            await coreApi.charge(parameter);

        const actions =
            Array.isArray(response.actions)
                ? response.actions
                : [];

        const generateQrAction =
            actions.find(
                action =>
                    action &&
                    action.name === 'generate-qr-code'
            ) || null;

        return {
            provider: 'MIDTRANS',

            mode:
                String(process.env.MIDTRANS_IS_PRODUCTION).toLowerCase()
                    === 'true'
                    ? 'PRODUCTION'
                    : 'SANDBOX',

            payment_method: 'QRIS',
            channel: null,

            amount: Number(payload.amount),

            external_transaction_id:
                response.transaction_id || null,

            expires_at:
                response.expiry_time || null,

            gateway_response: {
                transaction_status:
                    response.transaction_status || null,

                status_code:
                    response.status_code || null,

                status_message:
                    response.status_message || null,

                order_id:
                    response.order_id || payload.order_id,

                qr_string:
                    response.qr_string || null,

                qr_code_url:
                    generateQrAction
                        ? generateQrAction.url || null
                        : null,

                actions,

                raw: response
            }
        };
    }

    static async createVirtualAccount(payload, channel) {
        if (!channel) {
            throw new Error(
                'Channel bank wajib untuk Midtrans Virtual Account'
            );
        }

        const supportedBanks = [
            'BCA',
            'BNI',
            'BRI',
            'PERMATA'
        ];

        if (!supportedBanks.includes(channel)) {
            throw new Error(
                `Channel Midtrans VA belum didukung: ${channel}`
            );
        }

        const coreApi = this.getClient();

        const parameter = {
            payment_type: 'bank_transfer',

            transaction_details: {
                order_id: payload.order_id,
                gross_amount: Number(payload.amount)
            },

            bank_transfer: {
                bank: channel.toLowerCase()
            }
        };

        const response =
            await coreApi.charge(parameter);

        const vaNumber =
            Array.isArray(response.va_numbers) &&
            response.va_numbers.length > 0
                ? response.va_numbers[0].va_number
                : response.permata_va_number || null;

        return {
            provider: 'MIDTRANS',
            mode:
                String(process.env.MIDTRANS_IS_PRODUCTION).toLowerCase()
                    === 'true'
                    ? 'PRODUCTION'
                    : 'SANDBOX',

            payment_method: 'VIRTUAL_ACCOUNT',
            channel,

            amount: Number(payload.amount),

            external_transaction_id:
                response.transaction_id || null,

            expires_at: null,

            gateway_response: {
                transaction_status:
                    response.transaction_status || null,

                status_code:
                    response.status_code || null,

                status_message:
                    response.status_message || null,

                order_id:
                    response.order_id || payload.order_id,

                va_number: vaNumber,

                bank: channel,

                raw: response
            }
        };
    }


    static async getTransactionStatus(payload) {
        const transactionId =
            String(
                payload.transaction_id || ''
            ).trim();

        if (!transactionId) {
            throw new Error(
                'Midtrans transaction_id wajib untuk status'
            );
        }

        const coreApi =
            this.getClient();

        const response =
            await coreApi.transaction.status(
                transactionId
            );

        return {
            provider: 'MIDTRANS',

            transaction_id:
                response.transaction_id ||
                transactionId,

            order_id:
                response.order_id || null,

            transaction_status:
                response.transaction_status || null,

            status_code:
                response.status_code || null,

            gross_amount:
                response.gross_amount || null,

            fraud_status:
                response.fraud_status || null,

            settlement_time:
                response.settlement_time || null,

            refund_amount:
                response.refund_amount || null,

            raw: response
        };
    }


}

module.exports = MidtransAdapter;
