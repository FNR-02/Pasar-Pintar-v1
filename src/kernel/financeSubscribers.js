const CommerceKernel = require('./EventKernel');
const pool = require('../config/db'); // Sesuaikan jalur koneksi pool database

CommerceKernel.on('ORDER_PAID', async (packet) => {
    const order = packet.payload || {};
    console.log(`[FINANCE ENGINE] Mencatat jurnal akuntansi untuk Order: ${order.order_reference}`);
    
    try {
        const amount = parseFloat(order.total_amount) || 0;
        const ref = `ORD-${order.id}`;

        const existing = await pool.query(
            `SELECT COUNT(*) AS count
             FROM tbl_general_ledger
             WHERE transaction_reference = $1`,
            [ref]
        );

        if (Number(existing.rows[0].count) >= 2) {
            console.log(`[FINANCE ENGINE] SKIP ${ref}: jurnal sudah ada.`);
            return;
        }

        // Jurnal Akuntansi Double-Entry:
        // 1. Debit: Kas / Bank (Bertambah)
        await pool.query(
            `INSERT INTO tbl_general_ledger (transaction_reference, account_code, account_name, debit, credit, description) 
             VALUES ($1, '1100', 'Kas & Bank', $2, 0, $3)`,
            [ref, amount, `Penerimaan kas dari pesanan ${ref}`]
        );

        // 2. Kredit: Pendapatan Penjualan (Bertambah)
        await pool.query(
            `INSERT INTO tbl_general_ledger (transaction_reference, account_code, account_name, debit, credit, description) 
             VALUES ($1, '4000', 'Pendapatan Penjualan', 0, $2, $3)`,
            [ref, amount, `Pendapatan dari pesanan ${ref}`]
        );

        console.log(`[FINANCE ENGINE] Jurnal otomatis untuk ${ref} berhasil dicatat ke Ledger.`);
    } catch (err) {
        console.error("[FINANCE ERROR] Gagal mencatat jurnal akuntansi:", err.message);
    }
});
