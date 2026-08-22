class MultiCommandHandler {
    handle() {
        return {
            status: 'multiple_commands',
            responseText:
                'Saya menerima lebih dari satu perintah dalam satu pesan.\n\n' +
                'Agar pesanan tidak salah diproses, kirim satu permintaan per pesan.\n\n' +
                'Contoh:\n' +
                '1. "Berapa harga indomie"\n' +
                '2. Setelah saya balas, kirim "Beli indomie goreng 1"'
        };
    }
}

module.exports = MultiCommandHandler;
