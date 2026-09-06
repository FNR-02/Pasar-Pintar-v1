class EmptyMessageHandler {
    handle() {
        return {
            status: 'empty_message',
            responseText:
                'Pesannya masih kosong kak 😊 ' +
                'Ada produk yang mau ditanyakan atau dipesan?'
        };
    }
}

module.exports = EmptyMessageHandler;
