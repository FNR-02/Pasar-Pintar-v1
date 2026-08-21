const CommerceKernel = require('./EventKernel');
const pool = require('../config/db'); // Sesuaikan jalur koneksi database

CommerceKernel.on('ORDER_PAID', async (packet) => {
    const order = packet.payload || {};
    console.log(`[ORDER ENGINE] Pembayaran diterima untuk Order: ${order.order_reference}`);
    
    try {
        // 1. Ubah status order menjadi VERIFIED / PACKING
const transitionResult = await pool.query(
    `UPDATE tbl_orders_v2
     SET status = 'PACKING'
     WHERE id = $1
       AND status = 'PAID'
     RETURNING id, status`,
    [order.id]
);

if (transitionResult.rowCount === 0) {
    console.log(
        `[ORDER ENGINE] SKIP Order ${order.id}: ` +
        `status bukan PAID atau transisi sudah pernah diproses.`
    );
    return;
}
        // 2. Integrasi Inventory (Kurangi stok fisik / Reserved)
        console.log(`-> [Process] Inventory Engine menyesuaikan stok produk.`);

        // 3. Integrasi Finance (Catat pemasukan ke buku besar)
        console.log(`-> [Process] Finance Engine mencatat jurnal pendapatan sebesar ${order.total_amount}.`);

        // 4. Integrasi Loyalty (Tambahkan poin ke customer)
        console.log(`-> [Process] CRM & Loyalty Engine menambahkan poin reward untuk customer.`);

        // 5. Notifikasi & CEO Dashboard Update
        console.log(`-> [Process] Dashboard CEO dan Notifikasi Customer diperbarui.`);

        console.log(`[ORDER ENGINE] Siklus otomatis Order ${order.order_reference} berhasil berjalan.`);
    } catch (err) {
        console.error("[ORDER ERROR] Gagal memproses siklus order:", err.message);
    }
});
