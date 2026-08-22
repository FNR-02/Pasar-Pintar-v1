class FallbackHandler {
    handle() {
        return {
            status: 'unsupported_intent',
            responseText:
                'Maaf, saya belum memahami permintaan tersebut.\n\n' +
                'Anda bisa mencoba:\n' +
                '- "Berapa harga indomie"\n' +
                '- "Beli indomie goreng 1"\n' +
                '- "Cek status pesanan saya"\n' +
                '- "Bayar"'
        };
    }
}

module.exports = FallbackHandler;
