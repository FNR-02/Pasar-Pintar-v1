class GreetingHandler {
    handle({ customer }) {
        const name =
            String(
                customer?.full_name || ''
            ).trim();

        const greeting =
            name
                ? `Halo ${name} 👋`
                : 'Halo 👋';

        return {
            status: 'ready',
            responseText:
                `${greeting}\n\n` +
                'Selamat datang di Pasar Pintar.\n' +
                'Kamu bisa tanya harga dan stok produk, misalnya:\n' +
                '"berapa harga indomie"'
        };
    }
}

module.exports = GreetingHandler;
