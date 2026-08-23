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


// Merchant memperbarui profil outlet miliknya sendiri.
// Status merchant tidak dapat diubah melalui endpoint ini.
router.patch(
 '/merchant/account-v2',
 verifyToken,
 requireRole(2),
 async (req,res)=>{
  const storeName =
   String(req.body.store_name || '').trim();

  const address =
   String(req.body.address || '').trim();

  if(!storeName){
   return res.status(400).json({
    error:'Nama outlet wajib diisi'
   });
  }

  if(storeName.length > 150){
   return res.status(400).json({
    error:'Nama outlet terlalu panjang'
   });
  }

  if(!address){
   return res.status(400).json({
    error:'Alamat outlet wajib diisi'
   });
  }

  if(address.length > 1000){
   return res.status(400).json({
    error:'Alamat outlet terlalu panjang'
   });
  }

  try{
   const result=await pool.query(
    `UPDATE tbl_merchants
     SET
      store_name=$1,
      address=$2
     WHERE user_id=$3
       AND status='ACTIVE'
     RETURNING
      id AS merchant_id,
      store_name,
      address,
      status AS merchant_status,
      created_at AS merchant_since`,
    [
     storeName,
     address,
     req.user.id
    ]
   );

   if(!result.rowCount){
    return res.status(404).json({
     error:'Merchant aktif tidak ditemukan'
    });
   }

   return res.json({
    status:'success',
    message:'Profil outlet berhasil diperbarui',
    account:result.rows[0]
   });

  }catch(err){
   console.error(
    '[MERCHANT ACCOUNT UPDATE V2]',
    err.message
   );

   return res.status(500).json({
    error:err.message
   });
  }
 }
);

module.exports=router;
