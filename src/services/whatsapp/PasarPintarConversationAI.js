const OpenAI = require('openai');
const {
    schema
} = require('./PasarPintarConversationSchema');

class PasarPintarConversationAI {
    constructor(options = {}) {
        this.enabled =
            String(
                options.enabled ??
                process.env.PASAR_PINTAR_AI_ENABLED ??
                'false'
            ).toLowerCase() === 'true';

        this.model =
            options.model ||
            process.env.PASAR_PINTAR_AI_MODEL ||
            'gpt-5.6-terra';

        this.timeoutMs =
            Number(
                options.timeoutMs ??
                process.env.PASAR_PINTAR_AI_TIMEOUT_MS ??
                12000
            );

        this.maxRetries =
            Number(
                options.maxRetries ??
                process.env.PASAR_PINTAR_AI_MAX_RETRIES ??
                1
            );

        this.apiKey =
            options.apiKey ||
            process.env.OPENAI_API_KEY ||
            null;

        this.client = null;

        if (this.apiKey) {
            this.client = new OpenAI({
                apiKey: this.apiKey,
                timeout: this.timeoutMs,
                maxRetries: this.maxRetries
            });
        }
    }

    isReady() {
        return Boolean(
            this.enabled &&
            this.client &&
            this.apiKey
        );
    }

    buildSystemPrompt() {
        return `
Kamu adalah lapisan pemahaman percakapan untuk Pasar Pintar.

Tugasmu BUKAN melakukan transaksi.
Tugasmu hanya memahami maksud pelanggan dan
menghasilkan data terstruktur sesuai schema.

Konteks bisnis:
- Pasar Pintar adalah marketplace pasar tradisional.
- Pelanggan berbicara lewat WhatsApp.
- Bahasa pelanggan bisa santai, typo, singkatan,
  campuran Indonesia sehari-hari dan sedikit Sunda.
- Pelanggan tidak harus menggunakan format tertentu.
- Pesan pendek sering merujuk pesan sebelumnya.

Aturan keras:
1. Jangan mengarang nama produk.
2. Jangan mengarang harga.
3. Jangan mengarang stok.
4. Jangan mengarang kategori.
5. Jangan mengarang status order.
6. Jangan mengarang metode pembayaran.
7. Jangan menganggap transaksi berhasil.
8. Jangan mengubah data apa pun.
9. Jika informasi produk tidak disebutkan,
   jangan menebaknya dari pengetahuan umum.
10. Gunakan konteks percakapan hanya untuk memahami
    referensi seperti "yang tadi", "yang gede",
    "nomor dua", "dua aja", dan koreksi pelanggan.

Interpretasi intent:
- PRODUCT_SEARCH:
  pelanggan mencari atau menanyakan produk.
- CATEGORY_SEARCH:
  pelanggan ingin melihat produk dalam kategori.
- PRODUCT_RECOMMENDATION:
  pelanggan meminta saran berdasarkan kebutuhan,
  budget, rasa, kegunaan, atau preferensi.
- PRODUCT_DETAIL:
  pelanggan meminta detail produk tertentu.
- PRODUCT_IMAGE:
  pelanggan meminta foto/gambar produk.
- ADD_TO_CART:
  pelanggan bermaksud membeli/menambahkan produk.
- UPDATE_QUANTITY:
  pelanggan mengubah jumlah produk/draft sebelumnya.
- REMOVE_FROM_CART:
  pelanggan ingin menghapus barang.
- VIEW_CART:
  pelanggan ingin melihat pesanan sementara.
- ORDER_CONFIRMATION:
  pelanggan secara jelas mengonfirmasi pesanan.
- ORDER_CANCEL:
  pelanggan secara jelas membatalkan.
- ORDER_STATUS:
  pelanggan bertanya status pesanan.
- FULFILLMENT_SELECTION:
  pelanggan memilih antar atau pickup.
- PAYMENT_SELECTION:
  pelanggan memilih cara pembayaran.
- PAYMENT_REQUEST:
  pelanggan ingin melanjutkan pembayaran.
- ADDRESS_UPDATE:
  pelanggan memberikan atau mengubah alamat.
- FAQ:
  pertanyaan kebijakan/layanan Pasar Pintar.
- HUMAN_HELP:
  pelanggan meminta bantuan manusia/admin.
- GENERAL_CHAT:
  sapaan atau percakapan umum.
- UNKNOWN:
  maksud tidak cukup jelas.

Aturan konteks:
- "yang kedua" biasanya selectionNumber=2 dan
  referenceToPrevious=true.
- "yang gede" atau "yang kecil" adalah variant yang
  merujuk pilihan sebelumnya.
- "dua aja" dapat berarti quantity=2 bila konteks
  sebelumnya sedang membahas produk/order.
- "eh satu aja" adalah koreksi quantity:
  customerCorrection=true,
  referenceToPrevious=true,
  intent=UPDATE_QUANTITY.
- "jadi berapa semuanya?" biasanya VIEW_CART,
  bukan menebak total sendiri.
- "ambil sendiri aja" berarti
  FULFILLMENT_SELECTION + PICKUP.
- "antar aja" berarti
  FULFILLMENT_SELECTION + DELIVERY.
- "bayar pas ambil" berarti
  PAYMENT_SELECTION + OUTLET.
- Jangan mengisi field yang tidak diketahui.
  Gunakan null.

Confidence:
- 0.90-1.00: maksud sangat jelas.
- 0.70-0.89: cukup jelas.
- 0.50-0.69: ambigu ringan.
- <0.50: sebaiknya klarifikasi.

needsClarification=true hanya jika backend tidak mungkin
menentukan tindakan aman tanpa bertanya lagi.

clarificationQuestion harus singkat, natural,
dan dalam Bahasa Indonesia.
`.trim();
    }

    normalizeContext(context) {
        if (!context) {
            return {};
        }

        if (typeof context !== 'object') {
            return {};
        }

        return context;
    }

    async understand({
        text,
        context = null
    } = {}) {
        const value =
            String(text || '').trim();

        if (!value) {
            return {
                status: 'empty',
                understanding: null
            };
        }

        if (!this.enabled) {
            return {
                status: 'disabled',
                understanding: null
            };
        }

        if (!this.apiKey || !this.client) {
            return {
                status: 'not_configured',
                understanding: null
            };
        }

        const safeContext =
            this.normalizeContext(context);

        try {
            const response =
                await this.client.responses.create({
                    model: this.model,

                    input: [
                        {
                            role: 'system',
                            content:
                                this.buildSystemPrompt()
                        },
                        {
                            role: 'user',
                            content: JSON.stringify({
                                message: value,
                                conversationContext:
                                    safeContext
                            })
                        }
                    ],

                    text: {
                        format: {
                            type: 'json_schema',
                            name:
                                'pasar_pintar_conversation_understanding',
                            strict: true,
                            schema
                        }
                    }
                });

            const raw =
                response.output_text;

            if (!raw) {
                return {
                    status: 'invalid_response',
                    understanding: null
                };
            }

            let parsed;

            try {
                parsed = JSON.parse(raw);
            } catch {
                return {
                    status: 'invalid_json',
                    understanding: null
                };
            }

            return {
                status: 'understood',
                understanding: parsed,
                model: this.model,
                responseId:
                    response.id || null
            };
        } catch (error) {
            return {
                status: 'error',
                understanding: null,
                error: {
                    name:
                        error?.name ||
                        'Error',
                    message:
                        String(
                            error?.message ||
                            'AI request failed'
                        ).slice(0, 500)
                }
            };
        }
    }
}

module.exports =
    PasarPintarConversationAI;
