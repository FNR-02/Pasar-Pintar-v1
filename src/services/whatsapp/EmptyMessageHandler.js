class EmptyMessageHandler {
    handle() {
        return {
            status: 'empty_message',
            responseText:
                'Pesannya masih kosong nih.\n\n' +
                'Coba kirim pertanyaan, misalnya "Berapa harga indomie".'
        };
    }
}

module.exports = EmptyMessageHandler;
