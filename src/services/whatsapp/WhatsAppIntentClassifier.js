class WhatsAppIntentClassifier {
    classify(text) {
        const value =
            String(text || '')
                .trim()
                .toLowerCase();

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
            /^(halo|hai|hi|hello|assalamualaikum|pagi|siang|sore|malam)\b/.test(value)
        ) {
            return {
                intent: 'GREETING',
                confidence: 0.95
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
         * - "mie goreng 2 yaa"
         * - "2 mie goreng"
         *
         * Tetap sempit: harus mengandung quantity numerik.
         */
        if (
            /^(?:\d+\s+[a-z][a-z0-9 .,'&/-]*|[a-z][a-z0-9 .,'&/-]*\s+\d+)(?:\s+(?:pcs?|buah|bungkus|pack|ya+|dong|deh|aja|saja))*[?!.]*$/i.test(value)
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
            /\b(alamat|kirim ke|antar ke|lokasi)\b/.test(value)
        ) {
            return {
                intent: 'ADDRESS_UPDATE',
                confidence: 0.8
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
