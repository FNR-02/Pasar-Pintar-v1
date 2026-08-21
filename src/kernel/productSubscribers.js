const CommerceKernel = require('./EventKernel');

CommerceKernel.on('PRODUCT_CREATED', async (packet) => {
    const product = packet.payload || {};

    console.log(
        `[PRODUCT ENGINE] Memproses produk: ${product.nama_produk || product.name || product.id || 'UNKNOWN'}`
    );

    /*
     * Database enrichment sementara dinonaktifkan.
     *
     * Event listener tetap aktif sehingga arsitektur event dapat
     * berjalan tanpa circular dependency dengan server.js.
     */
});
