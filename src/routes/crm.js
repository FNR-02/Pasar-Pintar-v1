const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');

async function resolveCustomer(req, requestedCustomerId) {
    if (Number(req.user.role_id) === 1) {
        const result = await pool.query(
            `SELECT id, user_id
             FROM tbl_customers
             WHERE user_id = $1
             LIMIT 1`,
            [req.user.id]
        );

        return result.rows[0] || null;
    }

    const result = await pool.query(
        `SELECT id, user_id
         FROM tbl_customers
         WHERE id = $1
         LIMIT 1`,
        [requestedCustomerId]
    );

    return result.rows[0] || null;
}

// Loyalty Customer
router.get(
    '/crm/loyalty/:customer_id',
    verifyToken,
    requireRole(1, 4),
    async (req, res) => {
        try {
            const customer = await resolveCustomer(
                req,
                req.params.customer_id
            );

            if (!customer) {
                return res.status(404).json({
                    error: 'Customer tidak ditemukan'
                });
            }

            const result = await pool.query(
                `SELECT
                    customer_id,
                    total_points,
                    member_tier,
                    total_spent,
                    updated_at
                 FROM tbl_customer_loyalty_v2
                 WHERE customer_id = $1`,
                [customer.id]
            );

            if (result.rowCount === 0) {
                return res.status(404).json({
                    message: 'Data loyalty customer belum tersedia'
                });
            }

            return res.json({
                status: 'success',
                loyalty: result.rows[0]
            });
        } catch (err) {
            console.error('[CRM LOYALTY ERROR]', err.message);

            return res.status(500).json({
                error: err.message
            });
        }
    }
);

// Notifikasi Customer
router.get(
    '/crm/notifications/:customer_id',
    verifyToken,
    requireRole(1, 4),
    async (req, res) => {
        try {
            const customer = await resolveCustomer(
                req,
                req.params.customer_id
            );

            if (!customer) {
                return res.status(404).json({
                    error: 'Customer tidak ditemukan'
                });
            }

            const result = await pool.query(
                `SELECT
                    id,
                    title,
                    message,
                    is_read,
                    created_at
                 FROM tbl_notifications
                 WHERE user_id = $1
                 ORDER BY created_at DESC`,
                [customer.user_id]
            );

            return res.json({
                status: 'success',
                notifications: result.rows
            });
        } catch (err) {
            console.error('[CRM NOTIFICATION ERROR]', err.message);

            return res.status(500).json({
                error: err.message
            });
        }
    }
);

module.exports = router;
