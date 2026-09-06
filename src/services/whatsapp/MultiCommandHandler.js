class MultiCommandHandler {
    handle() {
        return {
            status: 'multiple_commands',
            responseText:
                'Kayaknya ada beberapa permintaan dalam satu pesan kak. ' +
                'Biar nggak salah diproses, kirim satu permintaan dulu ya.'
        };
    }
}

module.exports = MultiCommandHandler;
