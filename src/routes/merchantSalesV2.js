const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');

router.get(
 '/merchant/sales-v2',
 verifyToken,
 requireRole(2),
 async (req,res)=>{
  try{
   const merchantResult=await pool.query(
    `SELECT id,store_name
     FROM tbl_merchants
     WHERE user_id=$1
       AND status='ACTIVE'
     LIMIT 1`,
    [req.user.id]
   );

   if(!merchantResult.rowCount){
    return res.status(403).json({
     error:'Merchant aktif tidak ditemukan'
    });
   }

   const merchant=merchantResult.rows[0];

   const summary=await pool.query(`
    WITH valid_paid_orders AS (
     SELECT
      o.id,
      o.total_amount,
      o.market_order_id
     FROM tbl_orders_v2 o
     JOIN tbl_payments p
      ON p.order_id=o.id
     WHERE o.merchant_id=$1
       AND p.payment_status='PAID'
       AND p.amount=o.total_amount
       AND (
        (
         p.provider='MIDTRANS'
         AND p.payment_method IN (
          'QRIS',
          'VIRTUAL_ACCOUNT'
         )
        )
        OR
        (
         p.provider='OUTLET'
         AND p.payment_method='PAY_AT_OUTLET'
        )
       )
       AND (
        SELECT COUNT(*)
        FROM tbl_payments px
        WHERE px.order_id=o.id
          AND px.payment_status='PAID'
       )=1
    ),
    marketplace_refunds AS (
     SELECT
      a.order_id,
      SUM(a.amount) AS refund_amount
     FROM tbl_market_refund_allocations a
     JOIN tbl_market_payment_refunds r
      ON r.id=a.refund_id
     WHERE r.status='COMPLETED'
     GROUP BY a.order_id
    ),
    direct_refunds AS (
     SELECT
      r.order_id,
      SUM(r.amount) AS refund_amount
     FROM tbl_order_refunds r
     WHERE r.status='COMPLETED'
     GROUP BY r.order_id
    ),
    sales_per_order AS (
     SELECT
      v.id,
      v.total_amount,
      CASE
       WHEN v.market_order_id IS NOT NULL
        THEN COALESCE(mr.refund_amount,0)
       ELSE COALESCE(dr.refund_amount,0)
      END AS refund_amount
     FROM valid_paid_orders v
     LEFT JOIN marketplace_refunds mr
      ON mr.order_id=v.id
     LEFT JOIN direct_refunds dr
      ON dr.order_id=v.id
    )
    SELECT
     COUNT(*)::int AS paid_orders,
     COALESCE(
      SUM(
       GREATEST(
        total_amount-refund_amount,
        0
       )
      ),
      0
     ) AS revenue,
     ROUND(
      COALESCE(
       SUM(
        GREATEST(
         total_amount-refund_amount,
         0
        )
       ),
       0
      ) /
      NULLIF(COUNT(*),0),
      2
     ) AS average_order
    FROM sales_per_order
   `,[merchant.id]);

   const units=await pool.query(`
    SELECT
     COALESCE(
      SUM(oi.quantity),
      0
     )::int AS units_sold
    FROM tbl_orders_v2 o
    JOIN tbl_order_items oi
     ON oi.order_id=o.id
    WHERE o.merchant_id=$1
      AND EXISTS (
       SELECT 1
       FROM tbl_payments p
       WHERE p.order_id=o.id
         AND p.payment_status='PAID'
         AND p.amount=o.total_amount
         AND (
          (
           p.provider='MIDTRANS'
           AND p.payment_method IN (
            'QRIS',
            'VIRTUAL_ACCOUNT'
           )
          )
          OR
          (
           p.provider='OUTLET'
           AND p.payment_method=
               'PAY_AT_OUTLET'
          )
         )
         AND (
          SELECT COUNT(*)
          FROM tbl_payments px
          WHERE px.order_id=o.id
            AND px.payment_status='PAID'
         )=1
      )
   `,[merchant.id]);

   const products=await pool.query(`
    SELECT
     p.sku,
     p.name,
     SUM(oi.quantity)::int AS units_sold,
     SUM(
      oi.quantity * oi.unit_price
     ) AS gross_sales
    FROM tbl_orders_v2 o
    JOIN tbl_order_items oi
     ON oi.order_id=o.id
    JOIN tbl_products p
     ON p.id=oi.product_id
    WHERE o.merchant_id=$1
      AND EXISTS (
       SELECT 1
       FROM tbl_payments pay
       WHERE pay.order_id=o.id
         AND pay.payment_status='PAID'
         AND pay.amount=o.total_amount
         AND (
          (
           pay.provider='MIDTRANS'
           AND pay.payment_method IN (
            'QRIS',
            'VIRTUAL_ACCOUNT'
           )
          )
          OR
          (
           pay.provider='OUTLET'
           AND pay.payment_method=
               'PAY_AT_OUTLET'
          )
         )
         AND (
          SELECT COUNT(*)
          FROM tbl_payments px
          WHERE px.order_id=o.id
            AND px.payment_status='PAID'
         )=1
      )
    GROUP BY p.id,p.sku,p.name
    ORDER BY gross_sales DESC
   `,[merchant.id]);

   return res.json({
    status:'success',
    merchant,
    summary:{
     paid_orders:summary.rows[0].paid_orders,
     revenue:Number(summary.rows[0].revenue||0),
     average_order:Number(summary.rows[0].average_order||0),
     units_sold:units.rows[0].units_sold
    },
    products:products.rows
   });

  }catch(err){
   console.error('[MERCHANT SALES V2]',err.message);
   return res.status(500).json({
    error:err.message
   });
  }
 }
);

module.exports=router;
