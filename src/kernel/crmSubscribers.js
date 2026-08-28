const CommerceKernel = require('./EventKernel');
const pool = require('../config/db');

CommerceKernel.on('ORDER_PAID', async (packet) => {
    const order = packet.payload || {};
    const customerId = order.customer_id;
    const spent = Number(order.total_amount) || 0;
    const orderId = order.id;

    console.log(
        `[CRM V2] Memproses Customer: ${customerId}`
    );

    if (!customerId) {
        console.error('[CRM V2] customer_id tidak ditemukan');
        return;
    }

    if (!orderId) {
        console.error('[CRM V2] order.id tidak ditemukan');
        return;
    }

    const earnedPoints = Math.floor(spent / 10000);
    const rewardKey = `ORDER_PAID:${orderId}`;

    let client;

    try {
        client = await pool.connect();

        await client.query('BEGIN');

        const reward = await client.query(
            `INSERT INTO tbl_loyalty_points
             (customer_id, points, transaction_type, description)
             VALUES ($1, $2, 'ORDER_PAID', $3)
             ON CONFLICT (customer_id, transaction_type, description)
             DO NOTHING
             RETURNING id`,
            [customerId, earnedPoints, rewardKey]
        );

        if (reward.rowCount) {
            await client.query(
                `INSERT INTO tbl_customer_loyalty_v2
                 (customer_id, total_points, total_spent, member_tier)
                 VALUES ($1, $2, $3, 'Silver')
                 ON CONFLICT (customer_id)
                 DO UPDATE SET
                     total_points =
                         tbl_customer_loyalty_v2.total_points + $2,
                     total_spent =
                         tbl_customer_loyalty_v2.total_spent + $3,
                     member_tier = CASE
                         WHEN tbl_customer_loyalty_v2.total_spent + $3 >= 5000000
                             THEN 'Platinum'
                         WHEN tbl_customer_loyalty_v2.total_spent + $3 >= 2000000
                             THEN 'Gold'
                         ELSE 'Silver'
                     END,
                     updated_at = CURRENT_TIMESTAMP`,
                [customerId, earnedPoints, spent]
            );

            console.log(
                `[CRM V2] Loyalty: +${earnedPoints} poin`
            );
        } else {
            console.log(
                `[CRM V2] SKIP ${rewardKey}: reward sudah diberikan.`
            );
        }

        await client.query('COMMIT');
    } catch (err) {
        if (client) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackErr) {
                console.error(
                    `[CRM V2 ROLLBACK ERROR] ${rollbackErr.message}`
                );
            }
        }

        console.error(
            `[CRM V2 ERROR] ${err.message}`
        );
        return;
    } finally {
        if (client) {
            client.release();
        }
    }

    try {
        const customerResult = await pool.query(
            `SELECT user_id, full_name
             FROM tbl_customers
             WHERE id = $1`,
            [customerId]
        );

        if (!customerResult.rowCount) {
            throw new Error(
                `Customer ${customerId} tidak ditemukan`
            );
        }

        const userId = customerResult.rows[0].user_id;
        const fullName = customerResult.rows[0].full_name;

        if (!userId) {
            console.log(
                `[CRM V2] Customer ${customerId} belum memiliki user_id`
            );
        } else {
            const notification = await pool.query(
                `INSERT INTO tbl_notifications
                 (user_id, title, message, event_key)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (event_key)
                 WHERE event_key IS NOT NULL
                 DO NOTHING
                 RETURNING id`,
                [
                    userId,
                    'Pesanan Berhasil Diproses! 🎉',
                    `Terima kasih ${fullName || ''}! ` +
                    `Pesanan ${order.order_reference || order.id} ` +
                    `senilai Rp${spent} telah dikonfirmasi. ` +
                    `Anda mendapatkan ${earnedPoints} poin loyalitas.`,
                    rewardKey
                ]
            );

            if (notification.rowCount) {
                console.log(
                    `[CRM V2] Notifikasi terkirim ke user ${userId}`
                );
            } else {
                console.log(
                    `[CRM V2] SKIP notifikasi ${rewardKey}: sudah ada.`
                );
            }
        }

        console.log(
            `[CRM V2] Selesai Order ${order.id}`
        );
    } catch (err) {
        console.error(
            `[CRM V2 NOTIFICATION ERROR] ${err.message}`
        );
    }
});
