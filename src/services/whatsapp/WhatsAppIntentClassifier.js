const WhatsAppTextNormalizer = require('./WhatsAppTextNormalizer');

class WhatsAppIntentClassifier {
    constructor() {
        this.textNormalizer =
            new WhatsAppTextNormalizer();
    }

    classify(text) {
        const value =
            this.textNormalizer.normalize(text);

        if (!value) {
            return {
                intent: 'EMPTY_MESSAGE',
                confidence: 1
            };
        }

        /*
         * Safety boundary:
         * lebih dari satu baris non-kosong dianggap multi-command.
         *
         * Jangan biarkan keyword seperti "beli" pada baris kedua
         * mengubah seluruh payload menjadi aksi transaksi.
         */
        const nonEmptyLines =
            value
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(Boolean);

        if (nonEmptyLines.length > 1) {
            return {
                intent: 'MULTI_COMMAND',
                confidence: 1
            };
        }

        if (
            /^(?:(?:oke|ok|sip|iya)\s+)?konfirmasi(?:\s+ya)?$/i.test(value)
        ) {
            return {
                intent: 'ORDER_CONFIRMATION',
                confidence: 1
            };
        }

        if (value === 'batal') {
            return {
                intent: 'ORDER_CANCEL',
                confidence: 1
            };
        }

        if (value === 'bayar') {
            return {
                intent: 'PAYMENT_REQUEST',
                confidence: 1
            };
        }

        if (
            /^(?:(?:halo|hai|hi|hello)(?:\s+(?:aa|a|akang|kang|teteh|teh|kak|pak|bu))?|assalamualaikum(?:\s+(?:aa|a|akang|kang|teteh|teh|kak|pak|bu))?|(?:selamat\s+)?(?:pagi|siang|sore|malam)(?:\s+(?:aa|a|akang|kang|teteh|teh|kak|pak|bu))?|punten(?:\s+(?:aa|a|akang|kang|teteh|teh|kak|pak|bu))?|permisi(?:\s+(?:aa|a|akang|kang|teteh|teh|kak|pak|bu))?|aa|a|akang|kang|teteh|teh|kak|pak|bu)[?!.]*$/.test(value)
        ) {
            return {
                intent: 'GREETING',
                confidence: 0.95
            };
        }

        if (
            /\b(gambar|foto|photo|fotonya|gambarnya)\b/.test(value)
        ) {
            return {
                intent: 'PRODUCT_IMAGE',
                confidence: 0.95
            };
        }

        if (
            /\b(alamat|kirim ke|antar ke|lokasi)\b/.test(value)
        ) {
            return {
                intent: 'ADDRESS_UPDATE',
                confidence: 0.8
            };
        }

        if (
            /\b(beli|pesan|order|mau|minta)\b/.test(value)
        ) {
            return {
                intent: 'PRODUCT_ORDER',
                confidence: 0.85
            };
        }

        /*
         * Casual product order without transaction keyword:
         * - "mie goreng 2"
         * - "baso brekele satu"
         * - "dua mie goreng"
         *
         * Tetap sempit:
         * harus ada nama/term produk + quantity.
         * Selection seperti "nomor 2" tidak boleh
         * dianggap sebagai order baru.
         */
        if (
            !/\b(harga|berapa|stok|tersedia|ada)\b/i.test(value) &&
            !/^(?:nomor|no)\b/i.test(value) &&
            !/^(?:\d+|satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan|sepuluh)(?:\s+(?:pcs?|buah|bungkus|pack|ya+|dong|deh|aja|saja|a|aa|akang|kang|teteh|teh|kak|pak|bu))*[?!.]*$/i.test(value) &&
            /^(?:(?:\d+|satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan|sepuluh)\s+[a-z][a-z0-9 .,'&/-]*|[a-z][a-z0-9 .,'&/-]*\s+(?:\d+|satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan|sepuluh))(?:\s+(?:pcs?|buah|bungkus|pack|ya+|dong|deh|aja|saja))*[?!.]*$/i.test(value)
        ) {
            return {
                intent: 'PRODUCT_ORDER',
                confidence: 0.82
            };
        }

        if (
            /\b(cek|status|dimana|sampai mana)\b.*\b(pesanan|order)\b/.test(value) ||
            /\b(pesanan|order)\b.*\b(status|dimana)\b/.test(value)
        ) {
            return {
                intent: 'ORDER_STATUS',
                confidence: 0.9
            };
        }

        /*
         * Fulfillment selection.
         *
         * Intent dibuat eksplisit dan sempit agar kata seperti
         * "antar ke <alamat>" tetap ditangani ADDRESS_UPDATE.
         */
        if (
            /^(antar|diantar|kirim|kirim aja|antar aja|delivery)$/i.test(value)
        ) {
            return {
                intent: 'FULFILLMENT_DELIVERY',
                confidence: 0.95
            };
        }

        if (
            /^(?:(?:aku|saya)\s+)?(?:mau\s+)?(?:ambil(?:\s+sendiri)?|pickup|pick up|ambil\s+di\s+(?:toko|outlet))(?:\s+(?:aja|saja|ya|deh))*$/i.test(value)
        ) {
            return {
                intent: 'FULFILLMENT_PICKUP',
                confidence: 0.95
            };
        }

        /*
         * Pickup payment selection.
         */
        if (
            /^(?:(?:aku|saya)\s+)?(?:bayar|bayarnya|cash)(?:\s+(?:di\s+(?:outlet|toko|tempat)|pas\s+(?:ambil|ngambil)|saat\s+(?:ambil|ngambil)))(?:\s+(?:aja|saja|ya|deh))*$/i.test(value)
        ) {
            return {
                intent: 'PICKUP_PAYMENT_OUTLET',
                confidence: 0.95
            };
        }

        if (
            /^(bayar online|online|qris|bayar qris)$/i.test(value)
        ) {
            return {
                intent: 'PICKUP_PAYMENT_ONLINE',
                confidence: 0.95
            };
        }


        if (
            /^(menu|katalog|catalog)$/.test(value) ||
            /\b(harga|berapa|stok|tersedia|ada)\b/.test(value)
        ) {
            return {
                intent: 'PRODUCT_INQUIRY',
                confidence:
                    /^(menu|katalog|catalog)$/.test(value)
                        ? 0.95
                        : 0.8
            };
        }

        /*
         * Sundanese conversational product inquiry:
         * - "cireng aya?"
         * - "aya cireng?"
         *
         * "aya?" sendiri tidak dianggap product inquiry.
         */
        if (
            (
                /^[a-z0-9][a-z0-9 .,'&/-]{1,50}\s+aya\?$/i
                    .test(value) ||
                /^aya\s+[a-z0-9][a-z0-9 .,'&/-]{1,50}\?$/i
                    .test(value)
            )
        ) {
            return {
                intent: 'PRODUCT_INQUIRY',
                confidence: 0.78
            };
        }

        /*
         * Short conversational product inquiry:
         * - "kalau cireng?"
         * - "kalau dumpling?"
         *
         * Harus berupa pertanyaan pendek agar kata "kalau"
         * pada kalimat umum tidak membajak intent.
         */
        if (
            /^kalau\s+[a-z0-9][a-z0-9 .,'&/-]{1,50}\?$/i
                .test(value)
        ) {
            return {
                intent: 'PRODUCT_INQUIRY',
                confidence: 0.78
            };
        }

        /*
         * Casual product inquiry:
         * - "mie goreng ya"
         * - "mie goreng yaa"
         *
         * Sengaja membutuhkan filler akhir agar kalimat umum tidak
         * otomatis dianggap pencarian produk.
         */
        if (
            /^[a-z0-9][a-z0-9 .,'&/-]{1,60}\s+(?:ya+|dong|nih)[?!.]*$/i.test(value)
        ) {
            return {
                intent: 'PRODUCT_INQUIRY',
                confidence: 0.72
            };
        }

        return {
            intent: 'UNKNOWN',
            confidence: 0.3
        };
    }
}

module.exports = WhatsAppIntentClassifier;
