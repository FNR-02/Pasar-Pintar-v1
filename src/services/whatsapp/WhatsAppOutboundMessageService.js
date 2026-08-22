class WhatsAppOutboundMessageService {
    constructor() {
        this.baseUrl =
            String(
                process.env.EVOLUTION_API_URL || ''
            )
                .trim()
                .replace(/\/+$/, '');

        this.instance =
            String(
                process.env.EVOLUTION_INSTANCE || ''
            ).trim();

        this.apiKey =
            String(
                process.env.EVOLUTION_API_KEY || ''
            ).trim();
    }

    normalizePhone(value) {
        let phone =
            String(value || '')
                .trim()
                .split('@')[0]
                .replace(/\D/g, '');

        if (phone.startsWith('0')) {
            phone = '62' + phone.slice(1);
        }

        if (!/^62\d{8,13}$/.test(phone)) {
            return null;
        }

        return phone;
    }

    assertConfigured() {
        if (
            !this.baseUrl ||
            !this.instance ||
            !this.apiKey
        ) {
            const err = new Error(
                'Konfigurasi Evolution API untuk outbound WhatsApp belum lengkap'
            );

            err.code = 'WHATSAPP_OUTBOUND_UNAVAILABLE';

            throw err;
        }
    }

    async sendText({ phone, text }) {
        this.assertConfigured();

        const normalizedPhone =
            this.normalizePhone(phone);

        const message =
            String(text || '').trim();

        if (!normalizedPhone) {
            const err = new Error(
                'Nomor WhatsApp tujuan tidak valid'
            );

            err.code = 'WHATSAPP_INVALID_PHONE';

            throw err;
        }

        if (!message) {
            const err = new Error(
                'Pesan WhatsApp tidak boleh kosong'
            );

            err.code = 'WHATSAPP_EMPTY_MESSAGE';

            throw err;
        }

        const url =
            `${this.baseUrl}/message/sendText/` +
            encodeURIComponent(this.instance);

        let response;

        try {
            response = await fetch(
                url,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type':
                            'application/json',
                        apikey:
                            this.apiKey
                    },
                    body: JSON.stringify({
                        number:
                            normalizedPhone,
                        text:
                            message
                    })
                }
            );
        } catch (err) {
            const deliveryErr = new Error(
                'Tidak dapat terhubung ke layanan WhatsApp'
            );

            deliveryErr.code =
                'WHATSAPP_OUTBOUND_FAILED';

            throw deliveryErr;
        }

        let body = null;

        try {
            body = await response.json();
        } catch {
            body = null;
        }

        if (!response.ok) {
            const deliveryErr = new Error(
                `Evolution API gagal mengirim pesan (HTTP ${response.status})`
            );

            deliveryErr.code =
                'WHATSAPP_OUTBOUND_FAILED';

            throw deliveryErr;
        }

        return {
            status: 'sent',
            channel: 'whatsapp',
            phone: normalizedPhone,
            messageId:
                body?.key?.id ||
                body?.id ||
                null
        };
    }
}

module.exports = WhatsAppOutboundMessageService;
