const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const {
 verifyToken,
 requireRole
} = require('../middleware/auth');

router.get(
 '/merchant/account-v2',
 verifyToken,
 requireRole(2),
 async (req,res)=>{
  try{
   const result=await pool.query(`
    SELECT
     m.id AS merchant_id,
     m.store_name,
     m.address,
     m.status AS merchant_status,
     m.created_at AS merchant_since,
     u.id AS user_id,
     u.username,
     u.email,
     u.nama_lengkap,
     u.role_id,
     u.is_active
    FROM tbl_merchants m
    JOIN tbl_users u
     ON u.id=m.user_id
    WHERE m.user_id=$1
    LIMIT 1
   `,[req.user.id]);

   if(!result.rowCount){
    return res.status(404).json({
     error:'Merchant tidak ditemukan'
    });
   }

   return res.json({
    status:'success',
    account:result.rows[0]
   });

  }catch(err){
   console.error(
    '[MERCHANT ACCOUNT V2]',
    err.message
   );

   return res.status(500).json({
    error:err.message
   });
  }
 }
);

module.exports=router;
