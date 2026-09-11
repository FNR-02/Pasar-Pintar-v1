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


        const configuredMaxRetries =
            Number(
                options.maxRetries ??
                process.env
                    .PASAR_PINTAR_AI_MAX_RETRIES ??
                1
            );

        this.maxRetries =
            Number.isFinite(
                configuredMaxRetries
            ) &&
            configuredMaxRetries >= 0
                ? Math.min(
                    Math.floor(
                        configuredMaxRetries
                    ),
                    1
                )
                : 1;

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

ATURAN PENTING UNTUK CART MULTI-PRODUK:

Jika pelanggan mengubah jumlah produk tertentu yang
sudah ada di conversationContext.cart, gunakan SATU action:

SET_QUANTITY

dan WAJIB isi:
- productQuery dengan identitas produk yang dimaksud
- quantity dengan jumlah baru

JANGAN menghasilkan pasangan:
SELECT_PRODUCT lalu SET_QUANTITY
untuk perubahan quantity item yang sudah ada di cart.

Contoh:

"yang dumpling ayam jadi dua"
dengan Dumpling Ayam ada di cart ->

primaryIntent = UPDATE_QUANTITY

actions:
1. SET_QUANTITY
   productQuery = "dumpling ayam"
   quantity = 2

"cireng jadi tiga" ->

primaryIntent = UPDATE_QUANTITY

actions:
1. SET_QUANTITY
   productQuery = "cireng"
   quantity = 3

Jika pelanggan meminta menghapus item cart:

"cirengnya hapus aja" ->

primaryIntent = REMOVE_FROM_CART

actions:
1. REMOVE_PRODUCT
   productQuery = "cireng"

Jika pelanggan menambah produk baru ke cart:

"tambah sosis satu" ->

primaryIntent = ADD_TO_CART

actions:
1. ADD_PRODUCT
   productQuery = "sosis"
   quantity = 1

Gunakan SELECT_PRODUCT hanya untuk memilih hasil dari
daftar produk/katalog atau pilihan bernomor, BUKAN untuk
menunjuk item cart sebelum SET_QUANTITY/REMOVE_PRODUCT.

Jika referensi seperti "yang tadi" dapat ditentukan secara
unik dari conversationContext.cart atau productContext,
isi productQuery dengan nama/identitas produk yang relevan.

Jika ada lebih dari satu kemungkinan dan tidak dapat
ditentukan dengan aman, jangan menebak.
Gunakan needsClarification = true.

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
pilih SATU bahasa utama untuk balasan.
Gunakan kode seperti:
"id" untuk Bahasa Indonesia,
"su" untuk Bahasa Sunda,
"en" untuk Bahasa Inggris.

JANGAN gunakan kode bahasa campuran seperti "id-su".

Jika conversationContext.conversationLanguage sudah ada,
WAJIB pertahankan bahasa tersebut.
Jangan mengganti bahasa hanya karena satu kata pendek,
sapaan, atau sisipan bahasa lain.

Jika conversationContext.conversationLanguage BELUM ada,
tentukan bahasa dari bahasa alami pelanggan pada
customerMessage.

PENTING UNTUK DETEKSI BAHASA:
- nama produk TIDAK menentukan bahasa;
- nama merek TIDAK menentukan bahasa;
- SKU TIDAK menentukan bahasa;
- ukuran atau istilah dagang TIDAK menentukan bahasa;
- fokus pada kata kerja, kata ganti, struktur kalimat,
  dan ungkapan percakapan pelanggan;
- jangan menganggap Bahasa Indonesia hanya karena
  nama produk berasal dari katalog Indonesia.

Contoh wajib:
"I'd like one Aladin Cireng Crispy please"
-> conversationStyle.language = "en"

"Please add one Aladin Cireng Crispy to my cart"
-> conversationStyle.language = "en"

"Can I get one Aladin Cireng Crispy?"
-> conversationStyle.language = "en"

"abdi hoyong Aladin Cireng Crispy hiji"
-> conversationStyle.language = "su"

"saya mau Aladin Cireng Crispy satu"
-> conversationStyle.language = "id"

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

conversationStyle.cartAddedText:
kalimat pendek dan natural untuk menyatakan bahwa
operasi ADD_TO_CART / ADD_PRODUCT berhasil.
JANGAN sebut nama produk, jumlah, harga, atau total.

conversationStyle.cartRemovedText:
kalimat pendek dan natural untuk menyatakan bahwa
produk berhasil dihapus dari keranjang.
JANGAN sebut nama produk, jumlah, harga, atau total.

conversationStyle.cartQuantityUpdatedText:
kalimat pendek dan natural untuk menyatakan bahwa
jumlah produk di keranjang berhasil diperbarui.
JANGAN sebut nama produk, jumlah baru, harga, atau total.

conversationStyle.cartViewText:
kalimat pendek dan natural untuk membuka daftar
isi keranjang yang akan diberikan backend.
JANGAN menulis isi keranjang sendiri.

conversationStyle.cartEmptyText:
kalimat pendek dan natural untuk menyampaikan
bahwa backend menyatakan keranjang kosong.

conversationStyle.cartClarificationText:
kalimat pendek dan natural untuk menyampaikan bahwa
sebagian produk masih perlu diperjelas.
JANGAN menebak produk atau data yang belum pasti.

Untuk field cart di atas:
- gunakan bahasa conversationStyle.language;
- boleh menggunakan gaya santai dan natural;
- jangan memasukkan nama produk;
- jangan memasukkan merek;
- jangan memasukkan quantity;
- jangan memasukkan harga;
- jangan memasukkan stok;
- jangan memasukkan total;
- jangan memasukkan nomor pilihan;
- jangan memasukkan fakta transaksi lain.

Jika field cart tidak relevan dengan pesan saat ini,
tetap isi dengan kalimat generik yang aman dalam
bahasa conversationStyle.language.
Backend yang akan menentukan apakah field tersebut
benar-benar digunakan atau tidak.

generalReply hanya untuk percakapan ringan.
JANGAN menyatakan harga, stok, nama produk
tertentu, total, status pesanan, pembayaran,
pengiriman, saldo, promo, atau fakta bisnis
yang belum berasal dari backend.

Pilih satu bahasa balasan yang konsisten.
Indonesia balas seluruhnya dalam Bahasa Indonesia.
Sunda balas seluruhnya dalam Bahasa Sunda.
Bahasa Inggris balas seluruhnya dalam Bahasa Inggris.

Pesan pelanggan boleh bercampur bahasa dan tetap harus
dipahami, tetapi BALASAN BOT JANGAN mencampur bahasa.

Jika pelanggan menggunakan bahasa campuran:
- gunakan conversationContext.conversationLanguage
  jika sudah tersedia;
- jika belum tersedia, pilih bahasa dominan pesan;
- jangan berpindah bahasa hanya karena kata seperti
  "muhun", "punten", "kak", "kang", atau sapaan pendek.

Nama produk, merek, ukuran, dan istilah dagang resmi
boleh tetap ditulis sebagaimana data backend.

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

    isRetryableError(error) {
        const message =
            String(
                error?.message || ''
            ).toLowerCase();

        const status =
            Number(
                error?.status ||
                error?.statusCode ||
                error?.response?.status ||
                0
            );

        if (
            message.includes(
                'pasar_pintar_ai_timeout'
            )
        ) {
            return true;
        }

        if (
            status === 429 ||
            (
                status >= 500 &&
                status <= 599
            )
        ) {
            return true;
        }

        return [
            'timeout',
            'timed out',
            'econnreset',
            'econnrefused',
            'enotfound',
            'etimedout',
            'network',
            'socket hang up',
            'fetch failed'
        ].some(token =>
            message.includes(token)
        );
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

        let lastError = null;

        for (
            let attempt = 0;
            attempt <= this.maxRetries;
            attempt += 1
        ) {
            try {
                const response =
                    await this.withTimeout(
                        this.client.models
                            .generateContent({
                                model:
                                    this.model,
                                contents:
                                    JSON.stringify({
                                        customerMessage:
                                            value,
                                        conversationContext:
                                            context &&
                                            typeof context ===
                                                'object'
                                                ? context
                                                : {}
                                    }),
                                config: {
                                    systemInstruction:
                                        this
                                            .buildSystemPrompt(),
                                    responseMimeType:
                                        'application/json',
                                    responseJsonSchema:
                                        schema,
                                    temperature: 0
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
                        status:
                            'invalid_response',
                        understanding:
                            null
                    };
                }

                let parsed;

                try {
                    parsed =
                        JSON.parse(raw);
                } catch {
                    return {
                        status:
                            'invalid_json',
                        understanding:
                            null
                    };
                }

                return {
                    status:
                        'understood',
                    understanding:
                        parsed,
                    model:
                        this.model
                };
            } catch (error) {
                lastError =
                    error;

                const canRetry =
                    attempt <
                        this.maxRetries &&
                    this.isRetryableError(
                        error
                    );

                if (!canRetry) {
                    break;
                }

                await new Promise(resolve =>
                    setTimeout(
                        resolve,
                        250
                    )
                );
            }
        }

        return {
            status: 'error',
            understanding: null,
            error: {
                name:
                    lastError?.name ||
                    'Error',
                message:
                    String(
                        lastError?.message ||
                        'Gemini request failed'
                    ).slice(0, 700)
            }
        };
    }
}

module.exports =
    PasarPintarGeminiConversationAI;
