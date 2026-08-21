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
    WITH revenue_per_order AS (
     SELECT
      transaction_reference,
      SUM(credit) AS revenue
     FROM tbl_general_ledger
     WHERE account_code='4000'
     GROUP BY transaction_reference
    )
    SELECT
     COUNT(o.id)::int AS paid_orders,
     COALESCE(SUM(r.revenue),0) AS revenue,
     ROUND(
      COALESCE(SUM(r.revenue),0) /
      NULLIF(COUNT(o.id),0),
      2
     ) AS average_order
    FROM tbl_orders_v2 o
    JOIN revenue_per_order r
     ON r.transaction_reference=
        'ORD-'||o.id::text
    WHERE o.merchant_id=$1
   `,[merchant.id]);

   const units=await pool.query(`
    SELECT
     COALESCE(SUM(oi.quantity),0)::int AS units_sold
    FROM tbl_orders_v2 o
    JOIN tbl_order_items oi
     ON oi.order_id=o.id
    WHERE o.merchant_id=$1
      AND EXISTS(
       SELECT 1
       FROM tbl_general_ledger gl
       WHERE gl.transaction_reference=
             'ORD-'||o.id::text
         AND gl.account_code='4000'
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
      AND EXISTS(
       SELECT 1
       FROM tbl_general_ledger gl
       WHERE gl.transaction_reference=
             'ORD-'||o.id::text
         AND gl.account_code='4000'
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
