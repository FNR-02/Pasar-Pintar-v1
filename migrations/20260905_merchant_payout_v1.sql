BEGIN;

CREATE TABLE IF NOT EXISTS tbl_merchant_payouts (
    id uuid PRIMARY KEY
        DEFAULT gen_random_uuid(),

    merchant_id uuid NOT NULL
        REFERENCES tbl_merchants(id),

    payout_reference varchar(150) NOT NULL,

    status varchar(20) NOT NULL
        DEFAULT 'COMPLETED',

    gross_entitlement numeric(18,2) NOT NULL,

    adjustment_amount numeric(18,2) NOT NULL
        DEFAULT 0,

    payout_amount numeric(18,2) NOT NULL,

    evidence_reference text NOT NULL,

    payout_at timestamptz NOT NULL,

    confirmed_by uuid NOT NULL
        REFERENCES tbl_users(id),

    confirmed_at timestamptz NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    created_at timestamptz NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    updated_at timestamptz NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT
        tbl_merchant_payouts_reference_unique
        UNIQUE (payout_reference),

    CONSTRAINT
        tbl_merchant_payouts_status_check
        CHECK (
            status = 'COMPLETED'
        ),

    CONSTRAINT
        tbl_merchant_payouts_gross_check
        CHECK (gross_entitlement > 0),

    CONSTRAINT
        tbl_merchant_payouts_adjustment_check
        CHECK (adjustment_amount >= 0),

    CONSTRAINT
        tbl_merchant_payouts_amount_check
        CHECK (payout_amount > 0),

    CONSTRAINT
        tbl_merchant_payouts_math_check
        CHECK (
            payout_amount =
            gross_entitlement -
            adjustment_amount
        )
);

CREATE TABLE IF NOT EXISTS
    tbl_merchant_payout_allocations (
        id uuid PRIMARY KEY
            DEFAULT gen_random_uuid(),

        payout_id uuid NOT NULL
            REFERENCES tbl_merchant_payouts(id)
            ON DELETE CASCADE,

        entitlement_id uuid NOT NULL
            REFERENCES tbl_merchant_entitlements(id),

        gross_amount numeric(18,2) NOT NULL,

        adjustment_amount numeric(18,2) NOT NULL
            DEFAULT 0,

        payout_amount numeric(18,2) NOT NULL,

        created_at timestamptz NOT NULL
            DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT
            tbl_merchant_payout_alloc_entitlement_unique
            UNIQUE (entitlement_id),

        CONSTRAINT
            tbl_merchant_payout_alloc_gross_check
            CHECK (gross_amount > 0),

        CONSTRAINT
            tbl_merchant_payout_alloc_adjustment_check
            CHECK (adjustment_amount >= 0),

        CONSTRAINT
            tbl_merchant_payout_alloc_amount_check
            CHECK (payout_amount > 0),

        CONSTRAINT
            tbl_merchant_payout_alloc_math_check
            CHECK (
                payout_amount =
                gross_amount -
                adjustment_amount
            )
    );

CREATE INDEX IF NOT EXISTS
    idx_merchant_payouts_merchant_status
ON tbl_merchant_payouts (
    merchant_id,
    status
);

CREATE INDEX IF NOT EXISTS
    idx_merchant_payout_allocations_payout
ON tbl_merchant_payout_allocations (
    payout_id
);

COMMIT;
