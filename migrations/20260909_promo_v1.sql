BEGIN;

-- =========================================================
-- PASAR PINTAR PROMO V1
-- =========================================================

-- 1. PENDAFTARAN MERCHANT KE PROGRAM PROMO
CREATE TABLE IF NOT EXISTS tbl_merchant_promo_memberships (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    merchant_id uuid NOT NULL
        REFERENCES tbl_merchants(id)
        ON DELETE CASCADE,

    status varchar(24) NOT NULL DEFAULT 'PENDING',

    applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

    approved_at timestamptz,
    approved_by uuid,

    rejected_at timestamptz,
    rejection_reason text,

    suspended_at timestamptz,
    suspension_reason text,

    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT uq_merchant_promo_membership
        UNIQUE (merchant_id),

    CONSTRAINT chk_merchant_promo_membership_status
        CHECK (
            status IN (
                'PENDING',
                'APPROVED',
                'REJECTED',
                'SUSPENDED'
            )
        ),

    CONSTRAINT chk_merchant_promo_membership_approval
        CHECK (
            status <> 'APPROVED'
            OR approved_at IS NOT NULL
        ),

    CONSTRAINT chk_merchant_promo_membership_rejection
        CHECK (
            status <> 'REJECTED'
            OR (
                rejected_at IS NOT NULL
                AND rejection_reason IS NOT NULL
                AND btrim(rejection_reason) <> ''
            )
        ),

    CONSTRAINT chk_merchant_promo_membership_suspension
        CHECK (
            status <> 'SUSPENDED'
            OR suspended_at IS NOT NULL
        )
);


-- 2. MASTER PROMO
CREATE TABLE IF NOT EXISTS tbl_promotions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    owner_type varchar(16) NOT NULL,

    merchant_id uuid
        REFERENCES tbl_merchants(id)
        ON DELETE CASCADE,

    market_id uuid
        REFERENCES tbl_markets(id)
        ON DELETE SET NULL,

    name varchar(160) NOT NULL,
    description text,

    promotion_type varchar(24) NOT NULL,

    discount_value numeric(14,2),
    minimum_spend numeric(14,2) NOT NULL DEFAULT 0,
    maximum_discount numeric(14,2),

    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,

    status varchar(24) NOT NULL DEFAULT 'DRAFT',

    created_by uuid,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

    submitted_at timestamptz,

    approved_by uuid,
    approved_at timestamptz,

    rejected_by uuid,
    rejected_at timestamptz,
    rejection_reason text,

    CONSTRAINT chk_promotion_owner_type
        CHECK (
            owner_type IN (
                'PLATFORM',
                'MERCHANT'
            )
        ),

    CONSTRAINT chk_promotion_owner
        CHECK (
            (
                owner_type = 'PLATFORM'
                AND merchant_id IS NULL
            )
            OR
            (
                owner_type = 'MERCHANT'
                AND merchant_id IS NOT NULL
            )
        ),

    CONSTRAINT chk_promotion_type
        CHECK (
            promotion_type IN (
                'PERCENT',
                'FIXED',
                'FREE_SHIPPING'
            )
        ),

    CONSTRAINT chk_promotion_status
        CHECK (
            status IN (
                'DRAFT',
                'SUBMITTED',
                'APPROVED',
                'ACTIVE',
                'ENDED',
                'REJECTED',
                'CANCELLED'
            )
        ),

    CONSTRAINT chk_promotion_period
        CHECK (
            ends_at > starts_at
        ),

    CONSTRAINT chk_promotion_minimum_spend
        CHECK (
            minimum_spend >= 0
        ),

    CONSTRAINT chk_promotion_maximum_discount
        CHECK (
            maximum_discount IS NULL
            OR maximum_discount > 0
        ),

    CONSTRAINT chk_promotion_discount_value
        CHECK (
            (
                promotion_type = 'PERCENT'
                AND discount_value > 0
                AND discount_value <= 100
            )
            OR
            (
                promotion_type = 'FIXED'
                AND discount_value > 0
            )
            OR
            (
                promotion_type = 'FREE_SHIPPING'
                AND discount_value IS NULL
            )
        ),

    CONSTRAINT chk_free_shipping_platform_only
        CHECK (
            promotion_type <> 'FREE_SHIPPING'
            OR owner_type = 'PLATFORM'
        ),

    CONSTRAINT chk_promotion_approved
        CHECK (
            status NOT IN ('APPROVED', 'ACTIVE', 'ENDED')
            OR approved_at IS NOT NULL
        ),

    CONSTRAINT chk_promotion_rejected
        CHECK (
            status <> 'REJECTED'
            OR (
                rejected_at IS NOT NULL
                AND rejection_reason IS NOT NULL
                AND btrim(rejection_reason) <> ''
            )
        )
);


-- 3. PRODUK YANG MENGIKUTI PROMO
CREATE TABLE IF NOT EXISTS tbl_promotion_products (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    promotion_id uuid NOT NULL
        REFERENCES tbl_promotions(id)
        ON DELETE CASCADE,

    product_id uuid NOT NULL
        REFERENCES tbl_products(id)
        ON DELETE CASCADE,

    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT uq_promotion_product
        UNIQUE (
            promotion_id,
            product_id
        )
);


-- =========================================================
-- INDEX
-- =========================================================

CREATE INDEX IF NOT EXISTS
    idx_merchant_promo_memberships_status
ON tbl_merchant_promo_memberships(status);

CREATE INDEX IF NOT EXISTS
    idx_promotions_status_period
ON tbl_promotions(
    status,
    starts_at,
    ends_at
);

CREATE INDEX IF NOT EXISTS
    idx_promotions_owner_merchant
ON tbl_promotions(
    owner_type,
    merchant_id
);

CREATE INDEX IF NOT EXISTS
    idx_promotions_market
ON tbl_promotions(market_id);

CREATE INDEX IF NOT EXISTS
    idx_promotion_products_product
ON tbl_promotion_products(product_id);

CREATE INDEX IF NOT EXISTS
    idx_promotion_products_promotion
ON tbl_promotion_products(promotion_id);

COMMIT;
