class MultiCommandHandler {
    handle() {
        return {
            status: 'multiple_commands',
            responseText:
                'Kayaknya ada lebih dari satu permintaan dalam pesan kamu.\n\n' +
                'Biar pesanannya nggak salah diproses, kirim satu permintaan dulu ya.\n\n' +
                'Contoh:\n' +
                '1. "Berapa harga indomie"\n' +
                '2. Setelah aku balas, kirim "Beli indomie goreng 1"'
        };
    }
}

module.exports = MultiCommandHandler;
