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

        if (value === 'konfirmasi') {
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

        if (
            /\b(cek|status|dimana|sampai mana)\b.*\b(pesanan|order)\b/.test(value) ||
            /\b(pesanan|order)\b.*\b(status|dimana)\b/.test(value)
        ) {
            return {
                intent: 'ORDER_STATUS',
                confidence: 0.9
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
            /\b(harga|berapa|stok|tersedia|ada)\b/.test(value)
        ) {
            return {
                intent: 'PRODUCT_INQUIRY',
                confidence: 0.8
            };
        }

        return {
            intent: 'UNKNOWN',
            confidence: 0.3
        };
    }
}

module.exports = WhatsAppIntentClassifier;
