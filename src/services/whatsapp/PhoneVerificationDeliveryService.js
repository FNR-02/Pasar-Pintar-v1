class PhoneVerificationDeliveryService {
    constructor() {
        this.mode =
            String(
                process.env.PHONE_VERIFICATION_DELIVERY_MODE || 'disabled'
            )
                .trim()
                .toLowerCase();
    }

    async sendCode({ phone, code }) {
        if (!phone || !code) {
            throw new Error(
                'phone dan code wajib tersedia untuk pengiriman OTP'
            );
        }

        if (this.mode === 'disabled') {
            const err = new Error(
                'Transport WhatsApp untuk OTP belum tersedia'
            );
            err.code = 'OTP_DELIVERY_UNAVAILABLE';
            throw err;
        }

        if (this.mode !== 'evolution') {
            const err = new Error(
                `Mode delivery OTP tidak didukung: ${this.mode}`
            );
            err.code = 'OTP_DELIVERY_UNAVAILABLE';
            throw err;
        }

        const baseUrl =
            String(process.env.EVOLUTION_API_URL || '')
                .trim()
                .replace(/\/+$/, '');

        const instance =
            String(process.env.EVOLUTION_INSTANCE || '').trim();

        const apiKey =
            String(process.env.EVOLUTION_API_KEY || '').trim();

        if (!baseUrl || !instance || !apiKey) {
            const err = new Error(
                'Konfigurasi Evolution API untuk OTP belum lengkap'
            );
            err.code = 'OTP_DELIVERY_UNAVAILABLE';
            throw err;
        }

        const url =
            `${baseUrl}/message/sendText/${encodeURIComponent(instance)}`;

        const message =
            `Kode verifikasi Pasar Pintar Anda: ${code}\n\n` +
            `Kode berlaku selama 10 menit. ` +
            `Jangan berikan kode ini kepada siapa pun.`;

        let response;

        try {
            response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    apikey: apiKey
                },
                body: JSON.stringify({
                    number: String(phone),
                    text: message
                })
            });
        } catch (err) {
            const deliveryErr = new Error(
                'Tidak dapat terhubung ke layanan WhatsApp'
            );
            deliveryErr.code = 'OTP_DELIVERY_FAILED';
            deliveryErr.cause = err;
            throw deliveryErr;
        }

        if (!response.ok) {
            const deliveryErr = new Error(
                `Evolution API gagal mengirim OTP (HTTP ${response.status})`
            );
            deliveryErr.code = 'OTP_DELIVERY_FAILED';
            deliveryErr.httpStatus = response.status;
            throw deliveryErr;
        }

        return {
            status: 'sent',
            channel: 'whatsapp'
        };
    }
}

module.exports = new PhoneVerificationDeliveryService();
