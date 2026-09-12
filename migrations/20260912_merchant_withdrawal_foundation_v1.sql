BEGIN;

/*
 * ============================================================
 * MERCHANT PAYOUT ACCOUNT V1
 *
 * Satu rekening pencairan aktif per merchant pada pilot V1.
 * Perubahan rekening akan mengembalikan status ke PENDING.
 * ============================================================
 */
CREATE TABLE IF NOT EXISTS
    tbl_merchant_payout_accounts (
        id uuid PRIMARY KEY
            DEFAULT gen_random_uuid(),

        merchant_id uuid NOT NULL
            REFERENCES tbl_merchants(id),

        bank_name varchar(100) NOT NULL,
        account_number varchar(50) NOT NULL,
        account_holder_name varchar(150) NOT NULL,

        status varchar(20) NOT NULL
            DEFAULT 'PENDING',

        verified_by uuid
            REFERENCES tbl_users(id),

        verified_at timestamptz,

        rejection_reason text,

        created_at timestamptz NOT NULL
            DEFAULT CURRENT_TIMESTAMP,

        updated_at timestamptz NOT NULL
            DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT
            tbl_merchant_payout_accounts_merchant_unique
            UNIQUE (merchant_id),

        CONSTRAINT
            tbl_merchant_payout_accounts_status_check
            CHECK (
                status IN (
                    'PENDING',
                    'VERIFIED',
                    'REJECTED'
                )
            ),

        CONSTRAINT
            tbl_merchant_payout_accounts_bank_check
            CHECK (
                length(trim(bank_name)) > 0
            ),

        CONSTRAINT
            tbl_merchant_payout_accounts_number_check
            CHECK (
                length(trim(account_number)) > 0
            ),

        CONSTRAINT
            tbl_merchant_payout_accounts_holder_check
            CHECK (
                length(trim(account_holder_name)) > 0
            )
    );


/*
 * ============================================================
 * MERCHANT WITHDRAWAL REQUEST V1
 *
 * requested_amount selalu dihitung server dari entitlement
 * yang benar-benar dialokasikan.
 *
 * payout_account_snapshot menjaga rekening tujuan historis
 * walaupun merchant mengganti rekening setelah request.
 * ============================================================
 */
CREATE TABLE IF NOT EXISTS
    tbl_merchant_withdrawal_requests (
        id uuid PRIMARY KEY
            DEFAULT gen_random_uuid(),

        merchant_id uuid NOT NULL
            REFERENCES tbl_merchants(id),

        payout_account_id uuid NOT NULL
            REFERENCES tbl_merchant_payout_accounts(id),

        requested_amount numeric(18,2) NOT NULL,

        payout_account_snapshot jsonb NOT NULL,

        status varchar(20) NOT NULL
            DEFAULT 'REQUESTED',

        idempotency_key varchar(100) NOT NULL,

        payout_id uuid
            REFERENCES tbl_merchant_payouts(id),

        requested_at timestamptz NOT NULL
            DEFAULT CURRENT_TIMESTAMP,

        reviewed_by uuid
            REFERENCES tbl_users(id),

        reviewed_at timestamptz,

        rejection_reason text,

        completed_at timestamptz,

        created_at timestamptz NOT NULL
            DEFAULT CURRENT_TIMESTAMP,

        updated_at timestamptz NOT NULL
            DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT
            tbl_merchant_withdrawal_requests_amount_check
            CHECK (
                requested_amount > 0
            ),

        CONSTRAINT
            tbl_merchant_withdrawal_requests_status_check
            CHECK (
                status IN (
                    'REQUESTED',
                    'REJECTED',
                    'CANCELLED',
                    'COMPLETED'
                )
            ),

        CONSTRAINT
            tbl_merchant_withdrawal_requests_idempotency_unique
            UNIQUE (
                merchant_id,
                idempotency_key
            ),

        CONSTRAINT
            tbl_merchant_withdrawal_requests_payout_unique
            UNIQUE (payout_id)
    );


/*
 * ============================================================
 * WITHDRAWAL ENTITLEMENT ALLOCATION V1
 *
 * RESERVED = hak merchant sedang berada dalam request aktif.
 * RELEASED = request batal / ditolak.
 * SETTLED  = payout benar-benar selesai.
 *
 * Partial unique index di bawah mencegah entitlement yang sama
 * berada pada dua withdrawal aktif sekaligus.
 * ============================================================
 */
CREATE TABLE IF NOT EXISTS
    tbl_merchant_withdrawal_allocations (
        id uuid PRIMARY KEY
            DEFAULT gen_random_uuid(),

        withdrawal_request_id uuid NOT NULL
            REFERENCES tbl_merchant_withdrawal_requests(id)
            ON DELETE CASCADE,

        entitlement_id uuid NOT NULL
            REFERENCES tbl_merchant_entitlements(id),

        gross_amount numeric(18,2) NOT NULL,

        adjustment_amount numeric(18,2) NOT NULL
            DEFAULT 0,

        payout_amount numeric(18,2) NOT NULL,

        status varchar(20) NOT NULL
            DEFAULT 'RESERVED',

        created_at timestamptz NOT NULL
            DEFAULT CURRENT_TIMESTAMP,

        updated_at timestamptz NOT NULL
            DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT
            tbl_merchant_withdrawal_alloc_request_ent_unique
            UNIQUE (
                withdrawal_request_id,
                entitlement_id
            ),

        CONSTRAINT
            tbl_merchant_withdrawal_alloc_status_check
            CHECK (
                status IN (
                    'RESERVED',
                    'RELEASED',
                    'SETTLED'
                )
            ),

        CONSTRAINT
            tbl_merchant_withdrawal_alloc_gross_check
            CHECK (
                gross_amount > 0
            ),

        CONSTRAINT
            tbl_merchant_withdrawal_alloc_adjustment_check
            CHECK (
                adjustment_amount >= 0
            ),

        CONSTRAINT
            tbl_merchant_withdrawal_alloc_payout_check
            CHECK (
                payout_amount > 0
            ),

        CONSTRAINT
            tbl_merchant_withdrawal_alloc_math_check
            CHECK (
                payout_amount =
                gross_amount -
                adjustment_amount
            )
    );


CREATE UNIQUE INDEX IF NOT EXISTS
    idx_merchant_withdrawal_reserved_entitlement
ON tbl_merchant_withdrawal_allocations (
    entitlement_id
)
WHERE status = 'RESERVED';


CREATE INDEX IF NOT EXISTS
    idx_merchant_withdrawal_requests_merchant_status
ON tbl_merchant_withdrawal_requests (
    merchant_id,
    status,
    requested_at DESC
);


CREATE INDEX IF NOT EXISTS
    idx_merchant_withdrawal_requests_status
ON tbl_merchant_withdrawal_requests (
    status,
    requested_at
);


CREATE INDEX IF NOT EXISTS
    idx_merchant_withdrawal_alloc_request
ON tbl_merchant_withdrawal_allocations (
    withdrawal_request_id,
    status
);


COMMIT;
