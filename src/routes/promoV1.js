const express = require('express');
const pool = require('../config/db');
const {
  verifyToken,
  requireRole
} = require('../middleware/auth');

const router = express.Router();

async function getMerchantByUser(client, userId) {
  const result = await client.query(
    `
    SELECT id, store_name, status
    FROM tbl_merchants
    WHERE user_id = $1
      AND status = 'ACTIVE'
    LIMIT 1
    `,
    [userId]
  );

  return result.rows[0] || null;
}

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    .test(String(value || ''));
}

router.get(
  '/merchant/promos/v1/membership',
  verifyToken,
  requireRole(2),
  async (req, res) => {
    try {
      const merchant =
        await getMerchantByUser(
          pool,
          req.user.id
        );

      if (!merchant) {
        return res.status(403).json({
          error: 'Merchant aktif tidak ditemukan'
        });
      }

      const result = await pool.query(
        `
        SELECT
          id,
          merchant_id,
          status,
          applied_at,
          approved_at,
          rejected_at,
          rejection_reason,
          suspended_at,
          suspension_reason,
          updated_at
        FROM tbl_merchant_promo_memberships
        WHERE merchant_id = $1
        LIMIT 1
        `,
        [merchant.id]
      );

      return res.json({
        status: 'success',
        merchant,
        registered: result.rowCount > 0,
        membership: result.rows[0] || null
      });
    } catch (err) {
      console.error(
        '[PROMO MEMBERSHIP GET]',
        err
      );

      return res.status(500).json({
        error:
          'Gagal mengambil status Program Promo'
      });
    }
  }
);

router.post(
  '/merchant/promos/v1/membership/apply',
  verifyToken,
  requireRole(2),
  async (req, res) => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const merchant =
        await getMerchantByUser(
          client,
          req.user.id
        );

      if (!merchant) {
        await client.query('ROLLBACK');

        return res.status(403).json({
          error: 'Merchant aktif tidak ditemukan'
        });
      }

      const current = await client.query(
        `
        SELECT *
        FROM tbl_merchant_promo_memberships
        WHERE merchant_id = $1
        FOR UPDATE
        `,
        [merchant.id]
      );

      if (!current.rowCount) {
        const created = await client.query(
          `
          INSERT INTO tbl_merchant_promo_memberships
          (
            merchant_id,
            status,
            applied_at,
            updated_at
          )
          VALUES (
            $1,
            'PENDING',
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
          )
          RETURNING *
          `,
          [merchant.id]
        );

        await client.query('COMMIT');

        return res.status(201).json({
          status: 'success',
          message:
            'Pendaftaran Program Promo berhasil dikirim',
          membership: created.rows[0]
        });
      }

      const membership = current.rows[0];

      if (membership.status === 'REJECTED') {
        const updated = await client.query(
          `
          UPDATE tbl_merchant_promo_memberships
          SET
            status = 'PENDING',
            applied_at = CURRENT_TIMESTAMP,
            rejected_at = NULL,
            rejection_reason = NULL,
            approved_at = NULL,
            approved_by = NULL,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
          RETURNING *
          `,
          [membership.id]
        );

        await client.query('COMMIT');

        return res.json({
          status: 'success',
          message:
            'Pendaftaran ulang Program Promo berhasil dikirim',
          membership: updated.rows[0]
        });
      }

      if (membership.status === 'SUSPENDED') {
        await client.query('ROLLBACK');

        return res.status(409).json({
          error:
            'Keikutsertaan Program Promo sedang ditangguhkan'
        });
      }

      await client.query('COMMIT');

      return res.json({
        status: 'success',
        message:
          membership.status === 'APPROVED'
            ? 'Merchant sudah mengikuti Program Promo'
            : 'Pendaftaran Program Promo sedang ditinjau',
        membership
      });
    } catch (err) {
      await client
        .query('ROLLBACK')
        .catch(() => {});

      console.error(
        '[PROMO MEMBERSHIP APPLY]',
        err
      );

      return res.status(500).json({
        error:
          'Gagal mendaftar Program Promo'
      });
    } finally {
      client.release();
    }
  }
);

router.get(
  '/admin/promos/v1/memberships',
  verifyToken,
  requireRole(4),
  async (req, res) => {
    try {
      const result = await pool.query(
        `
        SELECT
          pm.*,
          m.store_name,
          m.status AS merchant_status
        FROM tbl_merchant_promo_memberships pm
        JOIN tbl_merchants m
          ON m.id = pm.merchant_id
        ORDER BY
          CASE
            WHEN pm.status = 'PENDING'
            THEN 0
            ELSE 1
          END,
          pm.applied_at DESC
        `
      );

      return res.json({
        status: 'success',
        count: result.rowCount,
        data: result.rows
      });
    } catch (err) {
      console.error(
        '[PROMO ADMIN MEMBERSHIPS]',
        err
      );

      return res.status(500).json({
        error:
          'Gagal mengambil pendaftaran Program Promo'
      });
    }
  }
);

router.post(
  '/admin/promos/v1/memberships/:id/approve',
  verifyToken,
  requireRole(4),
  async (req, res) => {
    if (!validUuid(req.params.id)) {
      return res.status(400).json({
        error: 'ID membership tidak valid'
      });
    }

    try {
      const result = await pool.query(
        `
        UPDATE tbl_merchant_promo_memberships
        SET
          status = 'APPROVED',
          approved_at = CURRENT_TIMESTAMP,
          approved_by = $2,
          rejected_at = NULL,
          rejection_reason = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
          AND status = 'PENDING'
        RETURNING *
        `,
        [
          req.params.id,
          req.user.id
        ]
      );

      if (!result.rowCount) {
        return res.status(409).json({
          error:
            'Membership tidak ditemukan atau bukan PENDING'
        });
      }

      return res.json({
        status: 'success',
        message:
          'Merchant disetujui mengikuti Program Promo',
        membership: result.rows[0]
      });
    } catch (err) {
      console.error(
        '[PROMO ADMIN APPROVE]',
        err
      );

      return res.status(500).json({
        error:
          'Gagal menyetujui Program Promo'
      });
    }
  }
);

router.post(
  '/admin/promos/v1/memberships/:id/reject',
  verifyToken,
  requireRole(4),
  async (req, res) => {
    if (!validUuid(req.params.id)) {
      return res.status(400).json({
        error: 'ID membership tidak valid'
      });
    }

    const reason =
      String(req.body?.reason || '').trim();

    if (!reason) {
      return res.status(400).json({
        error:
          'Alasan penolakan wajib diisi'
      });
    }

    try {
      const result = await pool.query(
        `
        UPDATE tbl_merchant_promo_memberships
        SET
          status = 'REJECTED',
          rejected_at = CURRENT_TIMESTAMP,
          rejection_reason = $2,
          approved_at = NULL,
          approved_by = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
          AND status = 'PENDING'
        RETURNING *
        `,
        [
          req.params.id,
          reason
        ]
      );

      if (!result.rowCount) {
        return res.status(409).json({
          error:
            'Membership tidak ditemukan atau bukan PENDING'
        });
      }

      return res.json({
        status: 'success',
        message:
          'Pendaftaran Program Promo ditolak',
        membership: result.rows[0]
      });
    } catch (err) {
      console.error(
        '[PROMO ADMIN REJECT]',
        err
      );

      return res.status(500).json({
        error:
          'Gagal menolak Program Promo'
      });
    }
  }
);


// PROMO PRODUCT V1 START

async function requireApprovedPromoMerchant(
  client,
  userId
) {
  const merchant =
    await getMerchantByUser(
      client,
      userId
    );

  if (!merchant) {
    return {
      ok: false,
      status: 403,
      error:
        'Merchant aktif tidak ditemukan'
    };
  }

  const membership =
    await client.query(
      `
      SELECT id, status
      FROM tbl_merchant_promo_memberships
      WHERE merchant_id = $1
      LIMIT 1
      `,
      [merchant.id]
    );

  if (
    !membership.rowCount ||
    membership.rows[0].status !== 'APPROVED'
  ) {
    return {
      ok: false,
      status: 403,
      error:
        'Merchant belum disetujui mengikuti Program Promo'
    };
  }

  return {
    ok: true,
    merchant,
    membership:
      membership.rows[0]
  };
}

function validPromoDate(value) {
  const date = new Date(value);
  return !Number.isNaN(date.getTime());
}

router.get(
  '/merchant/promos/v1/products',
  verifyToken,
  requireRole(2),
  async (req, res) => {
    try {
      const access =
        await requireApprovedPromoMerchant(
          pool,
          req.user.id
        );

      if (!access.ok) {
        return res
          .status(access.status)
          .json({
            error: access.error
          });
      }

      const result =
        await pool.query(
          `
          SELECT
            p.id,
            p.sku,
            p.name,
            p.image_url,
            p.selling_unit,
            p.customer_visible,
            COALESCE(price.amount, 0)
              AS retail_price,
            COALESCE(inv.stock, 0)
              AS stock
          FROM tbl_products p

          LEFT JOIN LATERAL (
            SELECT pp.amount
            FROM tbl_product_prices pp
            WHERE pp.product_id = p.id
              AND pp.price_type = 'RETAIL'
            ORDER BY pp.effective_date DESC
            LIMIT 1
          ) price ON TRUE

          LEFT JOIN LATERAL (
            SELECT
              SUM(i.quantity_on_hand)::int
                AS stock
            FROM tbl_inventory i
            WHERE i.product_id = p.id
          ) inv ON TRUE

          WHERE p.merchant_id = $1
            AND p.status = 'ACTIVE'
            AND p.customer_visible = TRUE

          ORDER BY p.name ASC
          `,
          [access.merchant.id]
        );

      return res.json({
        status: 'success',
        merchant:
          access.merchant,
        count:
          result.rowCount,
        data:
          result.rows
      });
    } catch (err) {
      console.error(
        '[PROMO MERCHANT PRODUCTS]',
        err
      );

      return res.status(500).json({
        error:
          'Gagal mengambil produk promo'
      });
    }
  }
);

router.get(
  '/merchant/promos/v1',
  verifyToken,
  requireRole(2),
  async (req, res) => {
    try {
      const access =
        await requireApprovedPromoMerchant(
          pool,
          req.user.id
        );

      if (!access.ok) {
        return res
          .status(access.status)
          .json({
            error: access.error
          });
      }

      const result =
        await pool.query(
          `
          SELECT
            pr.*,
            COUNT(pp.product_id)::int
              AS product_count
          FROM tbl_promotions pr

          LEFT JOIN tbl_promotion_products pp
            ON pp.promotion_id = pr.id

          WHERE pr.owner_type = 'MERCHANT'
            AND pr.merchant_id = $1

          GROUP BY pr.id
          ORDER BY pr.created_at DESC
          `,
          [access.merchant.id]
        );

      return res.json({
        status: 'success',
        merchant:
          access.merchant,
        count:
          result.rowCount,
        data:
          result.rows
      });
    } catch (err) {
      console.error(
        '[PROMO MERCHANT LIST]',
        err
      );

      return res.status(500).json({
        error:
          'Gagal mengambil daftar promo'
      });
    }
  }
);

router.post(
  '/merchant/promos/v1',
  verifyToken,
  requireRole(2),
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      const {
        name,
        description,
        promotion_type,
        discount_value,
        starts_at,
        ends_at,
        product_ids
      } = req.body || {};

      const promoName =
        String(name || '').trim();

      const promoType =
        String(
          promotion_type || ''
        ).trim().toUpperCase();

      const discount =
        Number(discount_value);

      const uniqueProductIds =
        [
          ...new Set(
            Array.isArray(product_ids)
              ? product_ids.map(
                  id => String(id).trim()
                ).filter(Boolean)
              : []
          )
        ];

      if (!promoName) {
        return res.status(400).json({
          error:
            'Nama promo wajib diisi'
        });
      }

      if (
        ![
          'PERCENT',
          'FIXED'
        ].includes(promoType)
      ) {
        return res.status(400).json({
          error:
            'Promo merchant hanya mendukung PERCENT atau FIXED'
        });
      }

      if (
        !Number.isFinite(discount) ||
        discount <= 0
      ) {
        return res.status(400).json({
          error:
            'Nilai diskon harus lebih dari 0'
        });
      }

      if (
        promoType === 'PERCENT' &&
        discount >= 100
      ) {
        return res.status(400).json({
          error:
            'Diskon persen harus kurang dari 100%'
        });
      }

      if (
        !validPromoDate(starts_at) ||
        !validPromoDate(ends_at)
      ) {
        return res.status(400).json({
          error:
            'Periode promo tidak valid'
        });
      }

      if (
        new Date(ends_at) <=
        new Date(starts_at)
      ) {
        return res.status(400).json({
          error:
            'Waktu selesai harus setelah waktu mulai'
        });
      }

      if (!uniqueProductIds.length) {
        return res.status(400).json({
          error:
            'Minimal pilih satu produk'
        });
      }

      await client.query('BEGIN');

      const access =
        await requireApprovedPromoMerchant(
          client,
          req.user.id
        );

      if (!access.ok) {
        await client.query('ROLLBACK');

        return res
          .status(access.status)
          .json({
            error: access.error
          });
      }

      const products =
        await client.query(
          `
          SELECT
            p.id,
            p.name,
            price.amount
              AS retail_price
          FROM tbl_products p

          LEFT JOIN LATERAL (
            SELECT pp.amount
            FROM tbl_product_prices pp
            WHERE pp.product_id = p.id
              AND pp.price_type = 'RETAIL'
            ORDER BY pp.effective_date DESC
            LIMIT 1
          ) price ON TRUE

          WHERE p.id =
            ANY($1::uuid[])
            AND p.merchant_id = $2
            AND p.status = 'ACTIVE'
            AND p.customer_visible = TRUE
          `,
          [
            uniqueProductIds,
            access.merchant.id
          ]
        );

      if (
        products.rowCount !==
        uniqueProductIds.length
      ) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          error:
            'Ada produk yang tidak valid atau bukan milik merchant'
        });
      }

      for (
        const product of products.rows
      ) {
        const retail =
          Number(product.retail_price);

        if (
          !Number.isFinite(retail) ||
          retail <= 0
        ) {
          await client.query(
            'ROLLBACK'
          );

          return res.status(400).json({
            error:
              `Harga RETAIL belum valid untuk ${product.name}`
          });
        }

        if (
          promoType === 'FIXED' &&
          discount >= retail
        ) {
          await client.query(
            'ROLLBACK'
          );

          return res.status(400).json({
            error:
              `Diskon nominal harus lebih kecil dari harga RETAIL ${product.name}`
          });
        }
      }

      const created =
        await client.query(
          `
          INSERT INTO tbl_promotions
          (
            owner_type,
            merchant_id,
            name,
            description,
            promotion_type,
            discount_value,
            minimum_spend,
            starts_at,
            ends_at,
            status,
            created_by,
            created_at,
            updated_at
          )
          VALUES
          (
            'MERCHANT',
            $1,
            $2,
            $3,
            $4,
            $5,
            0,
            $6,
            $7,
            'DRAFT',
            $8,
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
          )
          RETURNING *
          `,
          [
            access.merchant.id,
            promoName,
            String(
              description || ''
            ).trim() || null,
            promoType,
            discount,
            starts_at,
            ends_at,
            req.user.id
          ]
        );

      const promotion =
        created.rows[0];

      for (
        const productId of
          uniqueProductIds
      ) {
        await client.query(
          `
          INSERT INTO
            tbl_promotion_products
          (
            promotion_id,
            product_id
          )
          VALUES ($1, $2)
          `,
          [
            promotion.id,
            productId
          ]
        );
      }

      await client.query('COMMIT');

      return res.status(201).json({
        status: 'success',
        message:
          'Draft promo berhasil dibuat',
        promotion,
        products:
          products.rows
      });
    } catch (err) {
      await client
        .query('ROLLBACK')
        .catch(() => {});

      console.error(
        '[PROMO MERCHANT CREATE]',
        err
      );

      return res.status(500).json({
        error:
          'Gagal membuat promo'
      });
    } finally {
      client.release();
    }
  }
);

router.post(
  '/merchant/promos/v1/:id/submit',
  verifyToken,
  requireRole(2),
  async (req, res) => {
    if (!validUuid(req.params.id)) {
      return res.status(400).json({
        error: 'ID promo tidak valid'
      });
    }

    const client =
      await pool.connect();

    try {
      await client.query('BEGIN');

      const access =
        await requireApprovedPromoMerchant(
          client,
          req.user.id
        );

      if (!access.ok) {
        await client.query('ROLLBACK');

        return res
          .status(access.status)
          .json({
            error: access.error
          });
      }

      const current =
        await client.query(
          `
          SELECT *
          FROM tbl_promotions
          WHERE id = $1
            AND owner_type = 'MERCHANT'
            AND merchant_id = $2
          FOR UPDATE
          `,
          [
            req.params.id,
            access.merchant.id
          ]
        );

      if (!current.rowCount) {
        await client.query('ROLLBACK');

        return res.status(404).json({
          error:
            'Promo tidak ditemukan'
        });
      }

      const promotion =
        current.rows[0];

      if (
        ![
          'DRAFT',
          'REJECTED'
        ].includes(promotion.status)
      ) {
        await client.query('ROLLBACK');

        return res.status(409).json({
          error:
            'Hanya promo DRAFT atau REJECTED yang dapat dikirim'
        });
      }

      const productCount =
        await client.query(
          `
          SELECT COUNT(*)::int
            AS count
          FROM tbl_promotion_products
          WHERE promotion_id = $1
          `,
          [promotion.id]
        );

      if (
        Number(
          productCount.rows[0].count
        ) < 1
      ) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          error:
            'Promo belum memiliki produk'
        });
      }

      const updated =
        await client.query(
          `
          UPDATE tbl_promotions
          SET
            status = 'SUBMITTED',
            submitted_at =
              CURRENT_TIMESTAMP,
            rejected_by = NULL,
            rejected_at = NULL,
            rejection_reason = NULL,
            updated_at =
              CURRENT_TIMESTAMP
          WHERE id = $1
          RETURNING *
          `,
          [promotion.id]
        );

      await client.query('COMMIT');

      return res.json({
        status: 'success',
        message:
          'Promo berhasil dikirim ke Admin',
        promotion:
          updated.rows[0]
      });
    } catch (err) {
      await client
        .query('ROLLBACK')
        .catch(() => {});

      console.error(
        '[PROMO MERCHANT SUBMIT]',
        err
      );

      return res.status(500).json({
        error:
          'Gagal mengirim promo'
      });
    } finally {
      client.release();
    }
  }
);

router.get(
  '/admin/promos/v1/promotions',
  verifyToken,
  requireRole(4),
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `
          SELECT
            pr.*,
            m.store_name,
            COUNT(pp.product_id)::int
              AS product_count,
            COALESCE(
              ARRAY_AGG(
                DISTINCT p.name
              ) FILTER (
                WHERE p.name IS NOT NULL
              ),
              ARRAY[]::text[]
            ) AS product_names
          FROM tbl_promotions pr
          LEFT JOIN tbl_merchants m
            ON m.id = pr.merchant_id
          LEFT JOIN tbl_promotion_products pp
            ON pp.promotion_id = pr.id
          LEFT JOIN tbl_products p
            ON p.id = pp.product_id
          WHERE pr.owner_type = 'MERCHANT'

          GROUP BY
            pr.id,
            m.store_name

          ORDER BY
            CASE
              WHEN pr.status =
                'SUBMITTED'
              THEN 0
              ELSE 1
            END,
            pr.created_at DESC
          `
        );

      return res.json({
        status: 'success',
        count:
          result.rowCount,
        data:
          result.rows
      });
    } catch (err) {
      console.error(
        '[PROMO ADMIN LIST]',
        err
      );

      return res.status(500).json({
        error:
          'Gagal mengambil pengajuan promo'
      });
    }
  }
);

router.post(
  '/admin/promos/v1/promotions/:id/approve',
  verifyToken,
  requireRole(4),
  async (req, res) => {
    if (!validUuid(req.params.id)) {
      return res.status(400).json({
        error: 'ID promo tidak valid'
      });
    }

    const client =
      await pool.connect();

    try {
      await client.query('BEGIN');

      const current =
        await client.query(
          `
          SELECT
            pr.*,
            m.status AS merchant_status,
            pm.status AS membership_status
          FROM tbl_promotions pr

          JOIN tbl_merchants m
            ON m.id = pr.merchant_id

          LEFT JOIN
            tbl_merchant_promo_memberships pm
            ON pm.merchant_id =
              pr.merchant_id

          WHERE pr.id = $1
            AND pr.owner_type =
              'MERCHANT'

          FOR UPDATE OF pr
          `,
          [req.params.id]
        );

      if (!current.rowCount) {
        await client.query('ROLLBACK');

        return res.status(404).json({
          error:
            'Promo tidak ditemukan'
        });
      }

      const promotion =
        current.rows[0];

      if (
        promotion.status ===
        'APPROVED'
      ) {
        await client.query('COMMIT');

        return res.json({
          status: 'success',
          message:
            'Promo sudah disetujui',
          promotion
        });
      }

      if (
        promotion.status !==
        'SUBMITTED'
      ) {
        await client.query('ROLLBACK');

        return res.status(409).json({
          error:
            'Hanya promo SUBMITTED yang dapat disetujui'
        });
      }

      const promotionEndsAt =
        new Date(promotion.ends_at);

      if (
        Number.isNaN(
          promotionEndsAt.getTime()
        ) ||
        promotionEndsAt.getTime() <= Date.now()
      ) {
        await client.query('ROLLBACK');

        return res.status(409).json({
          error:
            'Periode promo sudah berakhir dan tidak dapat disetujui'
        });
      }

      if (
        promotion.merchant_status !==
          'ACTIVE' ||
        promotion.membership_status !==
          'APPROVED'
      ) {
        await client.query('ROLLBACK');

        return res.status(409).json({
          error:
            'Merchant atau membership promo tidak aktif'
        });
      }

      const updated =
        await client.query(
          `
          UPDATE tbl_promotions
          SET
            status = 'APPROVED',
            approved_at =
              CURRENT_TIMESTAMP,
            approved_by = $2,
            rejected_by = NULL,
            rejected_at = NULL,
            rejection_reason = NULL,
            updated_at =
              CURRENT_TIMESTAMP
          WHERE id = $1
          RETURNING *
          `,
          [
            req.params.id,
            req.user.id
          ]
        );

      await client.query('COMMIT');

      return res.json({
        status: 'success',
        message:
          'Promo merchant disetujui',
        promotion:
          updated.rows[0]
      });
    } catch (err) {
      await client
        .query('ROLLBACK')
        .catch(() => {});

      console.error(
        '[PROMO ADMIN APPROVE PROMOTION]',
        err
      );

      return res.status(500).json({
        error:
          'Gagal menyetujui promo'
      });
    } finally {
      client.release();
    }
  }
);

router.post(
  '/admin/promos/v1/promotions/:id/reject',
  verifyToken,
  requireRole(4),
  async (req, res) => {
    if (!validUuid(req.params.id)) {
      return res.status(400).json({
        error: 'ID promo tidak valid'
      });
    }

    const reason =
      String(
        req.body?.reason || ''
      ).trim();

    if (!reason) {
      return res.status(400).json({
        error:
          'Alasan penolakan wajib diisi'
      });
    }

    try {
      const result =
        await pool.query(
          `
          UPDATE tbl_promotions
          SET
            status = 'REJECTED',
            rejected_by = $2,
            rejected_at =
              CURRENT_TIMESTAMP,
            rejection_reason = $3,
            approved_by = NULL,
            approved_at = NULL,
            updated_at =
              CURRENT_TIMESTAMP
          WHERE id = $1
            AND owner_type =
              'MERCHANT'
            AND status =
              'SUBMITTED'
          RETURNING *
          `,
          [
            req.params.id,
            req.user.id,
            reason
          ]
        );

      if (!result.rowCount) {
        return res.status(409).json({
          error:
            'Promo tidak ditemukan atau bukan SUBMITTED'
        });
      }

      return res.json({
        status: 'success',
        message:
          'Promo merchant ditolak',
        promotion:
          result.rows[0]
      });
    } catch (err) {
      console.error(
        '[PROMO ADMIN REJECT PROMOTION]',
        err
      );

      return res.status(500).json({
        error:
          'Gagal menolak promo'
      });
    }
  }
);

// PROMO PRODUCT V1 END

module.exports = router;
