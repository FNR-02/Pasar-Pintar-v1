const CommerceKernel = require('./EventKernel');
const pool = require('../config/db');
const MarketplaceLedgerService =
    require('../services/finance/MarketplaceLedgerService');

CommerceKernel.on('ORDER_PAID', async (packet) => {
    const order = packet.payload || {};
    const orderId =
        order.id || order.orderId;

    if (!orderId) {
        console.error(
            '[FINANCE ERROR] ORDER_PAID tanpa order_id'
        );
        return;
    }

    const ref = `ORD-${orderId}`;
    let client;

    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const marketplaceLedger =
            new MarketplaceLedgerService(client);

        const classification =
            await marketplaceLedger
                .classifyOrderPaid(order);

        if (
            classification.type ===
            'ORDER_NOT_FOUND'
        ) {
            await client.query('ROLLBACK');

            console.error(
                `[FINANCE ERROR] Order tidak ditemukan: ${orderId}`
            );

            return;
        }

        if (
            classification.type ===
            'MARKETPLACE_PAYMENT_NOT_PAID' ||
            classification.type ===
            'MARKETPLACE_PAYMENT_UNSUPPORTED'
        ) {
            throw new Error(
                `Finance marketplace ditolak: ${classification.type} ${ref}`
            );
        }

        if (
            classification.type ===
            'MARKETPLACE_DIRECT_TO_MERCHANT'
        ) {
            await client.query('COMMIT');

            console.log(
                `[FINANCE ENGINE V2] ${ref} DIRECT_TO_MERCHANT no PP ledger`
            );

            return;
        }

        if (
            classification.type ===
            'MARKETPLACE_PLATFORM_CUSTODY'
        ) {
            const result =
                await marketplaceLedger
                    .recordOrderPaid(order);

            if (result.status !== 'recorded') {
                throw new Error(
                    `Finance marketplace gagal dicatat: ${result.type} ${result.status}`
                );
            }

            await client.query('COMMIT');

            console.log(
                `[FINANCE ENGINE V2] ${ref} ${result.type} ${result.status}`
            );

            return;
        }

        if (
            classification.type !==
            'NON_MARKETPLACE'
        ) {
            throw new Error(
                `Klasifikasi finance tidak dikenal: ${classification.type}`
            );
        }

        const amount =
            Number(classification.order.total_amount);

        if (
            !Number.isFinite(amount) ||
            amount < 0
        ) {
            throw new Error(
                'total_amount tidak valid'
            );
        }

        await client.query(
            `INSERT INTO tbl_general_ledger (
                transaction_reference,
                account_code,
                account_name,
                debit,
                credit,
                description
             )
             VALUES (
                $1,
                '1100',
                'Kas & Bank',
                $2,
                0,
                $3
             )
             ON CONFLICT (
                transaction_reference,
                account_code
             )
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
             VALUES (
                $1,
                '4000',
                'Pendapatan Penjualan',
                0,
                $2,
                $3
             )
             ON CONFLICT (
                transaction_reference,
                account_code
             )
             DO NOTHING`,
            [
                ref,
                amount,
                `Pendapatan dari pesanan ${ref}`
            ]
        );

        await client.query('COMMIT');

        console.log(
            `[FINANCE ENGINE LEGACY] ${ref} berhasil dipastikan idempotent.`
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
