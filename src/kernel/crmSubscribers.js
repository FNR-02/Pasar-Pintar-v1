const CommerceKernel = require('./EventKernel');
const pool = require('../config/db');

CommerceKernel.on('ORDER_PAID', async (packet) => {
    const order = packet.payload || {};
    const customerId = order.customer_id;
    const spent = Number(order.total_amount) || 0;

    console.log(
        `[CRM V2] Memproses Customer: ${customerId}`
    );

    if (!customerId) {
        console.error('[CRM V2] customer_id tidak ditemukan');
        return;
    }

    try {
        const earnedPoints = Math.floor(spent / 10000);
        const orderId = order.id;
        const rewardKey = `ORDER_PAID:${orderId}`;

        {
            const reward = await pool.query(
                `INSERT INTO tbl_loyalty_points
                 (customer_id, points, transaction_type, description)
                 VALUES ($1, $2, 'ORDER_PAID', $3)
                 ON CONFLICT (customer_id, transaction_type, description)
                 DO NOTHING
                 RETURNING id`,
                [customerId, earnedPoints, rewardKey]
            );

            if (!reward.rowCount) {
                console.log(
                    `[CRM V2] SKIP ${rewardKey}: reward sudah diberikan.`
                );
                return;
            }
        }

        await pool.query(
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
                 updated_at = CURRENT_TIMESTAMP
        `,
            [customerId, earnedPoints, spent]
        );

        console.log(
            `[CRM V2] Loyalty: +${earnedPoints} poin`
        );
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
            await pool.query(
                `INSERT INTO tbl_notifications
                 (user_id, title, message)
                 VALUES ($1, $2, $3)`,
                [
                    userId,
                    'Pesanan Berhasil Diproses! 🎉',
                    `Terima kasih ${fullName || ''}! ` +
                    `Pesanan ${order.order_reference || order.id} ` +
                    `senilai Rp${spent} telah dikonfirmasi. ` +
                    `Anda mendapatkan ${earnedPoints} poin loyalitas.`
                ]
            );

            console.log(
                `[CRM V2] Notifikasi terkirim ke user ${userId}`
            );
        }
        console.log(
            `[CRM V2] Selesai Order ${order.id}`
        );
    } catch (err) {
        console.error(
            `[CRM V2 ERROR] ${err.message}`
        );
    }
});
