const {
    GoogleGenAI
} = require('@google/genai');

const {
    schema
} = require('./PasarPintarConversationSchema');

class PasarPintarGeminiConversationAI {
    constructor(options = {}) {
        this.enabled =
            String(
                options.enabled ??
                process.env.PASAR_PINTAR_AI_ENABLED ??
                'false'
            ).toLowerCase() === 'true';

        this.apiKey =
            options.apiKey ||
            process.env.GEMINI_API_KEY ||
            null;

        this.model =
            options.model ||
            process.env.PASAR_PINTAR_GEMINI_MODEL ||
            'gemini-2.5-flash';

        const configuredTimeout =
            Number(
                process.env
                    .PASAR_PINTAR_AI_TIMEOUT_MS
            );

        this.timeoutMs =
            Number.isFinite(configuredTimeout) &&
            configuredTimeout >= 1000
                ? Math.min(
                    configuredTimeout,
                    15000
                )
                : 12000;


        this.client =
            this.apiKey
                ? new GoogleGenAI({
                    apiKey: this.apiKey
                })
                : null;
    }

    isReady() {
        return Boolean(
            this.enabled &&
            this.apiKey &&
            this.client
        );
    }

    buildSystemPrompt() {
        return `
Kamu adalah mesin pemahaman percakapan
Pasar Pintar.

Pelanggan berbicara lewat WhatsApp dengan bahasa
Indonesia sehari-hari. Bisa santai, typo, singkatan,
atau sedikit bahasa Sunda.

Tugasmu hanya MEMAHAMI pesan pelanggan.
Kamu tidak menjalankan transaksi.

Output WAJIB mengikuti schema JSON.

PENTING:
Satu pesan pelanggan boleh memiliki lebih dari
satu tindakan.

Gunakan:
- primaryIntent untuk maksud utama.
- actions untuk semua tindakan yang terkandung
  dalam pesan.

Aturan keras:
- Jangan mengarang produk.
- Jangan mengarang harga.
- Jangan mengarang stok.
- Jangan mengarang kategori.
- Jangan mengarang status pesanan.
- Jangan menyatakan transaksi berhasil.
- Gunakan null jika informasi tidak diketahui.
- Jangan menganggap angka ukuran sebagai jumlah
  jika konteks menunjukkan angka itu adalah varian.
- Gunakan konteks pembicaraan sebelumnya.

Jika pelanggan mengubah keputusan sebelumnya:
customerCorrection = true.

Jika pesan merujuk pembicaraan sebelumnya:
referenceToPrevious = true.

Gunakan action berikut:
SELECT_PRODUCT
SELECT_VARIANT
SET_QUANTITY
ADD_PRODUCT
REMOVE_PRODUCT
SHOW_PRODUCT
SHOW_IMAGE
SHOW_CART
SET_FULFILLMENT
SET_PAYMENT
SET_ADDRESS
CONFIRM_ORDER
CANCEL_ORDER

Contoh:

"yang 500 dua aja"

primaryIntent = PRODUCT_SELECTION

actions:
1. SELECT_VARIANT
   variant = "500"
2. SET_QUANTITY
   quantity = 2

referenceToPrevious = true.

"yang kecil aja dua"

primaryIntent = PRODUCT_SELECTION

actions:
1. SELECT_VARIANT
   variant = "kecil"
2. SET_QUANTITY
   quantity = 2

"eh bukan itu, yang 200 aja"

primaryIntent = PRODUCT_SELECTION

actions:
1. SELECT_VARIANT
   variant = "200"

customerCorrection = true.
referenceToPrevious = true.

Angka 200 pada konteks ukuran 200gr/500gr
adalah varian, bukan quantity.

"eh satu aja"

primaryIntent = UPDATE_QUANTITY

actions:
1. SET_QUANTITY
   quantity = 1

customerCorrection = true.
referenceToPrevious = true.

"yang nomor dua aja"

primaryIntent = PRODUCT_SELECTION

actions:
1. SELECT_PRODUCT
   selectionNumber = 2

referenceToPrevious = true.

"ambil sendiri"

primaryIntent = FULFILLMENT_SELECTION

actions:
1. SET_FULFILLMENT
   fulfillment = PICKUP

"bayar pas ambil"

primaryIntent = PAYMENT_SELECTION

actions:
1. SET_PAYMENT
   paymentPreference = OUTLET

"ambil sendiri, bayar pas ambil"

primaryIntent = FULFILLMENT_SELECTION

actions:
1. SET_FULFILLMENT
   fulfillment = PICKUP
2. SET_PAYMENT
   paymentPreference = OUTLET

"foto yang tadi dong"

primaryIntent = PRODUCT_IMAGE

actions:
1. SHOW_IMAGE

referenceToPrevious = true.

"jadi berapa semuanya?"

primaryIntent = VIEW_CART

actions:
1. SHOW_CART

Jika pesan ambigu dan konteks tidak cukup:
needsClarification = true.

clarificationQuestion harus singkat,
natural, dan tidak mengarang data.

confidence harus mencerminkan
keyakinan sebenarnya.

ATURAN PENTING UNTUK productQuery:
productQuery adalah istilah pencarian katalog inti,
BUKAN salinan kalimat pelanggan.

Isi productQuery hanya dengan nama, jenis, merek,
atau ciri produk yang kemungkinan memang terdapat
pada nama produk di katalog.

Jangan masukkan kata percakapan, sapaan, atau
preferensi yang sudah mempunyai field tersendiri.

Contoh:
"ada baso yang murah?" ->
productQuery = "baso"
sortPreference = "CHEAPEST"

"sosis paling mahal" ->
productQuery = "sosis"
sortPreference = "MOST_EXPENSIVE"

"nugget di bawah 30000" ->
productQuery = "nugget"
budgetMax = 30000

"ada dumpling gak kang?" ->
productQuery = "dumpling"

Jangan menghasilkan:
productQuery = "baso murah"
productQuery = "nugget di bawah 30000"
productQuery = "ada dumpling"

conversationStyle wajib selalu diisi.

conversationStyle.language:
identifikasi bahasa/gaya utama pelanggan.
Contoh: "id", "su", "id-su", "en".

conversationStyle.catalogIntro:
satu kalimat pendek dan natural untuk membuka
daftar produk yang SUDAH ditemukan backend.

conversationStyle.catalogOutro:
satu kalimat pendek dan natural untuk meminta
pelanggan memilih nama atau nomor produk.

conversationStyle.notFoundText:
satu atau dua kalimat natural jika backend
tidak menemukan produk yang cocok.

conversationStyle.generalReply:
jawaban singkat dan natural HANYA jika
primaryIntent = GENERAL_CHAT.
Jika primaryIntent bukan GENERAL_CHAT,
isi dengan string kosong.

generalReply hanya untuk percakapan ringan.
JANGAN menyatakan harga, stok, nama produk
tertentu, total, status pesanan, pembayaran,
pengiriman, saldo, promo, atau fakta bisnis
yang belum berasal dari backend.

Ikuti bahasa pelanggan secara natural.
Indonesia balas Indonesia.
Sunda balas Sunda.
Campuran boleh mengikuti campuran.
Bahasa lain ikuti jika mampu.

PENTING:
conversationStyle hanya gaya bahasa.
JANGAN masukkan nama produk, harga, stok,
nomor pilihan, total, status transaksi,
atau fakta dagang apa pun ke field style.
Fakta tersebut hanya boleh berasal dari backend.

Berikan hanya JSON yang sesuai schema.
`.trim();
    }

    async withTimeout(promise, timeoutMs) {
        let timer = null;

        try {
            return await Promise.race([
                promise,
                new Promise((_, reject) => {
                    timer = setTimeout(
                        () => reject(
                            new Error(
                                'PASAR_PINTAR_AI_TIMEOUT'
                            )
                        ),
                        timeoutMs
                    );
                })
            ]);
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    }

    async understand({
        text,
        context = {}
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

        if (!this.client) {
            return {
                status: 'not_configured',
                understanding: null
            };
        }

        try {
            const response =
                await this.withTimeout(
                    this.client.models.generateContent({
                    model: this.model,

                    contents: JSON.stringify({
                        customerMessage: value,
                        conversationContext:
                            context &&
                            typeof context === 'object'
                                ? context
                                : {}
                    }),

                    config: {
                        systemInstruction:
                            this.buildSystemPrompt(),

                        responseMimeType:
                            'application/json',

                        responseJsonSchema:
                            schema,

                        temperature: 0.1
                    }
                }),
                    this.timeoutMs
                );

            const raw =
                String(
                    response.text || ''
                ).trim();

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
                model: this.model
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
                            'Gemini request failed'
                        ).slice(0, 700)
                }
            };
        }
    }
}

module.exports =
    PasarPintarGeminiConversationAI;
