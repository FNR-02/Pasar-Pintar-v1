class EmptyMessageHandler {
    handle() {
        return {
            status: 'empty_message',
            responseText:
                'Pesan Anda belum berisi teks.\n\n' +
                'Silakan kirim pertanyaan, misalnya "Berapa harga indomie".'
        };
    }
}

module.exports = EmptyMessageHandler;
