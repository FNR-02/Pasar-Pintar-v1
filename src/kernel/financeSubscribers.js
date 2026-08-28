const CommerceKernel = require('./EventKernel');
const pool = require('../config/db');

CommerceKernel.on('ORDER_PAID', async (packet) => {
    const order = packet.payload || {};

    console.log(
        `[FINANCE ENGINE] Mencatat jurnal akuntansi untuk Order: ` +
        `${order.order_reference}`
    );

    const amount = parseFloat(order.total_amount) || 0;
    const ref = `ORD-${order.id}`;
    let client;

    try {
        client = await pool.connect();
        await client.query('BEGIN');

        await client.query(
            `INSERT INTO tbl_general_ledger (
                transaction_reference,
                account_code,
                account_name,
                debit,
                credit,
                description
             )
             VALUES ($1, '1100', 'Kas & Bank', $2, 0, $3)
             ON CONFLICT (transaction_reference, account_code)
             DO NOTHING`,
            [
                ref,
                amount,
                `Penerimaan kas dari pesanan ${ref}`
            ]
        );

        await client.query(
            `INSERT INTO tbl_general_ledger (
                transaction_reference,
                account_code,
                account_name,
                debit,
                credit,
                description
             )
             VALUES ($1, '4000', 'Pendapatan Penjualan', 0, $2, $3)
             ON CONFLICT (transaction_reference, account_code)
             DO NOTHING`,
            [
                ref,
                amount,
                `Pendapatan dari pesanan ${ref}`
            ]
        );

        await client.query('COMMIT');

        console.log(
            `[FINANCE ENGINE] Jurnal otomatis untuk ${ref} ` +
            `berhasil dipastikan idempotent.`
        );
    } catch (err) {
        if (client) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackErr) {}
        }

        console.error(
            '[FINANCE ERROR] Gagal mencatat jurnal akuntansi:',
            err.message
        );
    } finally {
        if (client) {
            client.release();
        }
    }
});
