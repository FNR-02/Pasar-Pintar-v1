const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const merchantMediaDirectory = path.join(
 __dirname,
 '../../public/uploads/merchants'
);

fs.mkdirSync(
 merchantMediaDirectory,
 { recursive:true }
);

const allowedMerchantMediaMimeTypes = new Set([
 'image/jpeg',
 'image/png',
 'image/webp'
]);

const merchantMediaStorage = multer.diskStorage({
 destination:(req,file,cb)=>{
  cb(null,merchantMediaDirectory);
 },
 filename:(req,file,cb)=>{
  const extensionByMime={
   'image/jpeg':'.jpg',
   'image/png':'.png',
   'image/webp':'.webp'
  };

  const extension=
   extensionByMime[file.mimetype] || '';

  cb(
   null,
   `merchant-${crypto.randomUUID()}${extension}`
  );
 }
});

const merchantMediaUpload = multer({
 storage:merchantMediaStorage,
 limits:{
  fileSize:5 * 1024 * 1024,
  files:1
 },
 fileFilter:(req,file,cb)=>{
  if(
   !allowedMerchantMediaMimeTypes.has(
    file.mimetype
   )
  ){
   const err=new Error(
    'Format gambar harus JPG, PNG, atau WebP'
   );
   err.code='INVALID_MERCHANT_MEDIA_TYPE';
   return cb(err);
  }

  return cb(null,true);
 }
});

function detectMerchantMediaType(filePath){
 let fd;

 try{
  fd=fs.openSync(filePath,'r');

  const buffer=Buffer.alloc(16);
  const bytesRead=fs.readSync(
   fd,
   buffer,
   0,
   buffer.length,
   0
  );

  const data=buffer.subarray(0,bytesRead);

  if(
   data.length >= 8 &&
   data[0] === 0x89 &&
   data[1] === 0x50 &&
   data[2] === 0x4e &&
   data[3] === 0x47 &&
   data[4] === 0x0d &&
   data[5] === 0x0a &&
   data[6] === 0x1a &&
   data[7] === 0x0a
  ){
   return { mime:'image/png' };
  }

  if(
   data.length >= 3 &&
   data[0] === 0xff &&
   data[1] === 0xd8 &&
   data[2] === 0xff
  ){
   return { mime:'image/jpeg' };
  }

  if(
   data.length >= 12 &&
   data.subarray(0,4).toString('ascii') ===
    'RIFF' &&
   data.subarray(8,12).toString('ascii') ===
    'WEBP'
  ){
   return { mime:'image/webp' };
  }

  return null;

 }catch(err){
  console.error(
   '[MERCHANT MEDIA SIGNATURE]',
   err.message
  );
  return null;

 }finally{
  if(fd !== undefined){
   try{
    fs.closeSync(fd);
   }catch(_){}
  }
 }
}

function deleteMerchantMediaFile(imageUrl){
 if(
  !imageUrl ||
  typeof imageUrl !== 'string'
 ){
  return;
 }

 const prefix='/uploads/merchants/';

 if(!imageUrl.startsWith(prefix)){
  return;
 }

 const fileName=path.basename(imageUrl);
 const filePath=path.join(
  merchantMediaDirectory,
  fileName
 );

 try{
  if(fs.existsSync(filePath)){
   fs.unlinkSync(filePath);
  }
 }catch(err){
  console.error(
   '[MERCHANT MEDIA CLEANUP]',
   err.message
  );
 }
}
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
     m.address_line,
     m.village,
     m.district,
     m.city,
     m.province,
     m.postal_code,
     m.landmark,
     m.place_id,
     m.latitude,
     m.longitude,
     m.phone,
     m.logo_url,
     m.banner_url,
     m.description,
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
 "/merchant/account-v2",
 verifyToken,
 requireRole(2),
 async (req,res)=>{
  const storeName =
   String(req.body.store_name || "").trim();

  const address =
   String(req.body.address || "").trim();

  const description =
   String(req.body.description || "").trim();

  const hasField=field=>
   Object.prototype.hasOwnProperty.call(
    req.body,
    field
   );

  const structuredText=field=>{
   if(!hasField(field)){
    return undefined;
   }

   const value=req.body[field];

   if(value === null){
    return null;
   }

   const text=String(value).trim();
   return text || null;
  };

  const addressLine=
   structuredText("address_line");
  const village=
   structuredText("village");
  const district=
   structuredText("district");
  const city=
   structuredText("city");
  const province=
   structuredText("province");
  const postalCode=
   structuredText("postal_code");
  const landmark=
   structuredText("landmark");
  const placeId=
   structuredText("place_id");

  const hasLatitudeField=
   hasField("latitude");
  const hasLongitudeField=
   hasField("longitude");

  if(
   hasLatitudeField !==
   hasLongitudeField
  ){
   return res.status(400).json({
    error:
     "Latitude dan longitude outlet harus dikirim bersamaan"
   });
  }

  let latitude;
  let longitude;

  if(hasLatitudeField){
   const latitudeRaw=req.body.latitude;
   const longitudeRaw=req.body.longitude;

   const latitudeBlank=
    latitudeRaw === null ||
    String(latitudeRaw).trim() === "";

   const longitudeBlank=
    longitudeRaw === null ||
    String(longitudeRaw).trim() === "";

   if(
    latitudeBlank !==
    longitudeBlank
   ){
    return res.status(400).json({
     error:
      "Latitude dan longitude outlet harus diisi bersamaan"
    });
   }

   if(
    latitudeBlank &&
    longitudeBlank
   ){
    latitude=null;
    longitude=null;
   }else{
    latitude=Number(latitudeRaw);
    longitude=Number(longitudeRaw);

    if(
     !Number.isFinite(latitude) ||
     !Number.isFinite(longitude) ||
     latitude < -90 ||
     latitude > 90 ||
     longitude < -180 ||
     longitude > 180
    ){
     return res.status(400).json({
      error:"Koordinat outlet tidak valid"
     });
    }
   }
  }

  let phone =
   String(req.body.phone || "")
    .trim()
    .replace(/[^0-9]/g,"");

  if(phone.startsWith("0")){
   phone="62"+phone.slice(1);
  }else if(phone.startsWith("8")){
   phone="62"+phone;
  }

  if(
   !/^62[0-9]{8,13}$/.test(phone)
  ){
   return res.status(400).json({
    error:
     "Nomor WhatsApp tidak valid. Gunakan nomor Indonesia, contoh 081234567890"
   });
  }

  if(!storeName){
   return res.status(400).json({
    error:"Nama outlet wajib diisi"
   });
  }

  if(storeName.length > 150){
   return res.status(400).json({
    error:"Nama outlet terlalu panjang"
   });
  }

  if(!address){
   return res.status(400).json({
    error:"Alamat outlet wajib diisi"
   });
  }

  if(address.length > 1000){
   return res.status(400).json({
    error:"Alamat outlet terlalu panjang"
   });
  }

  if(description.length > 1000){
   return res.status(400).json({
    error:"Deskripsi lapak maksimal 1000 karakter"
   });
  }

  const structuredLimits=[
   ["Baris alamat",addressLine,500],
   ["Kelurahan",village,120],
   ["Kecamatan",district,120],
   ["Kota/Kabupaten",city,120],
   ["Provinsi",province,120],
   ["Kode pos",postalCode,12],
   ["Patokan",landmark,500],
   ["Place ID",placeId,255]
  ];

  for(const [label,value,max] of structuredLimits){
   if(
    value !== undefined &&
    value !== null &&
    value.length > max
   ){
    return res.status(400).json({
     error:`${label} maksimal ${max} karakter`
    });
   }
  }

  try{
   const result=await pool.query(
    `UPDATE tbl_merchants
     SET
      store_name=$1,
      address=$2,
      description=$3,
      phone=$4,

      address_line=
       CASE WHEN $5
        THEN $6
        ELSE address_line
       END,

      village=
       CASE WHEN $7
        THEN $8
        ELSE village
       END,

      district=
       CASE WHEN $9
        THEN $10
        ELSE district
       END,

      city=
       CASE WHEN $11
        THEN $12
        ELSE city
       END,

      province=
       CASE WHEN $13
        THEN $14
        ELSE province
       END,

      postal_code=
       CASE WHEN $15
        THEN $16
        ELSE postal_code
       END,

      landmark=
       CASE WHEN $17
        THEN $18
        ELSE landmark
       END,

      place_id=
       CASE WHEN $19
        THEN $20
        ELSE place_id
       END,

      latitude=
       CASE WHEN $21
        THEN $22
        ELSE latitude
       END,

      longitude=
       CASE WHEN $21
        THEN $23
        ELSE longitude
       END

     WHERE user_id=$24
       AND status=$25

     RETURNING
      id AS merchant_id,
      store_name,
      address,
      address_line,
      village,
      district,
      city,
      province,
      postal_code,
      landmark,
      place_id,
      latitude,
      longitude,
      phone,
      logo_url,
      banner_url,
      description,
      status AS merchant_status,
      created_at AS merchant_since`,
    [
     storeName,
     address,
     description,
     phone,

     hasField("address_line"),
     addressLine ?? null,

     hasField("village"),
     village ?? null,

     hasField("district"),
     district ?? null,

     hasField("city"),
     city ?? null,

     hasField("province"),
     province ?? null,

     hasField("postal_code"),
     postalCode ?? null,

     hasField("landmark"),
     landmark ?? null,

     hasField("place_id"),
     placeId ?? null,

     hasLatitudeField,
     latitude ?? null,
     longitude ?? null,

     req.user.id,
     "ACTIVE"
    ]
   );
   if(!result.rowCount){
    return res.status(404).json({
     error:"Merchant aktif tidak ditemukan"
    });
   }

   return res.json({
    status:"success",
    message:"Profil outlet berhasil diperbarui",
    account:result.rows[0]
   });

  }catch(err){
   console.error(
    "[MERCHANT ACCOUNT UPDATE V2]",
    err.message
   );

   return res.status(500).json({
    error:err.message
   });
  }
 }
);

function merchantMediaMiddleware(
 req,
 res,
 next
){
 merchantMediaUpload.single('photo')(
  req,
  res,
  err=>{
   if(!err){
    return next();
   }

   if(err instanceof multer.MulterError){
    if(err.code === 'LIMIT_FILE_SIZE'){
     return res.status(413).json({
      error:'Ukuran gambar maksimal 5 MB'
     });
    }

    return res.status(400).json({
     error:
      'Upload gambar gagal: ' +
      err.message
    });
   }

   if(
    err.code ===
    'INVALID_MERCHANT_MEDIA_TYPE'
   ){
    return res.status(415).json({
     error:err.message
    });
   }

   return res.status(400).json({
    error:
     err.message ||
     'Upload gambar gagal'
   });
  }
 );
}

function registerMerchantMediaRoute(
 routePath,
 columnName,
 mediaLabel
){
 const allowedColumns=
  new Set([
   'logo_url',
   'banner_url'
  ]);

 if(!allowedColumns.has(columnName)){
  throw new Error(
   'Kolom media merchant tidak valid'
  );
 }

 router.post(
  routePath,
  verifyToken,
  requireRole(2),
  merchantMediaMiddleware,
  async (req,res)=>{
   if(!req.file){
    return res.status(400).json({
     error:
      'File gambar wajib dikirim dengan field photo'
    });
   }

   const newImageUrl=
    `/uploads/merchants/${req.file.filename}`;

   const detected=
    detectMerchantMediaType(
     req.file.path
    );

   if(!detected){
    deleteMerchantMediaFile(
     newImageUrl
    );

    return res.status(415).json({
     error:
      'Isi file bukan gambar JPG, PNG, atau WebP yang valid'
    });
   }

   if(
    detected.mime !==
    req.file.mimetype
   ){
    deleteMerchantMediaFile(
     newImageUrl
    );

    return res.status(415).json({
     error:
      'Format isi gambar tidak sesuai dengan tipe file yang dikirim'
    });
   }

   let client;
   let oldImageUrl=null;

   try{
    client=await pool.connect();

    await client.query('BEGIN');

    const merchantResult=
     await client.query(
      `
      SELECT
       id,
       ${columnName} AS old_image_url
      FROM tbl_merchants
      WHERE user_id=$1
        AND status='ACTIVE'
      LIMIT 1
      FOR UPDATE
      `,
      [req.user.id]
     );

    if(!merchantResult.rowCount){
     await client.query('ROLLBACK');

     deleteMerchantMediaFile(
      newImageUrl
     );

     return res.status(404).json({
      error:
       'Merchant aktif tidak ditemukan'
     });
    }

    oldImageUrl=
     merchantResult.rows[0]
      .old_image_url || null;

    const updated=
     await client.query(
      `
      UPDATE tbl_merchants
      SET ${columnName}=$1
      WHERE id=$2
      RETURNING
       id AS merchant_id,
       store_name,
       logo_url,
       banner_url,
       description
      `,
      [
       newImageUrl,
       merchantResult.rows[0].id
      ]
     );

    await client.query('COMMIT');

    if(
     oldImageUrl &&
     oldImageUrl !== newImageUrl
    ){
     deleteMerchantMediaFile(
      oldImageUrl
     );
    }

    return res.json({
     status:'success',
     message:
      `${mediaLabel} berhasil diperbarui`,
     account:updated.rows[0]
    });

   }catch(err){
    if(client){
     try{
      await client.query(
       'ROLLBACK'
      );
     }catch(_){}
    }

    deleteMerchantMediaFile(
     newImageUrl
    );

    console.error(
     '[MERCHANT MEDIA UPLOAD]',
     err.message
    );

    return res.status(500).json({
     error:
      `Gagal memperbarui ${mediaLabel.toLowerCase()}`
    });

   }finally{
    if(client){
     client.release();
    }
   }
  }
 );
}

registerMerchantMediaRoute(
 '/merchant/account-v2/logo',
 'logo_url',
 'Logo lapak'
);

registerMerchantMediaRoute(
 '/merchant/account-v2/banner',
 'banner_url',
 'Banner lapak'
);

module.exports=router;
