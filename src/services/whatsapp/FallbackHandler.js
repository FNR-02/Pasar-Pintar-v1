class FallbackHandler {
    handle() {
        return {
            status: 'unsupported_intent',
            responseText:
                'Maaf kak, aku belum paham maksud pesannya. ' +
                'Coba sebut produk atau kebutuhan kakak dengan lebih singkat ya.'
        };
    }
}

module.exports = FallbackHandler;
