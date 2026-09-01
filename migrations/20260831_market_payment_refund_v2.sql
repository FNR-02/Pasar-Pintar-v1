BEGIN;

ALTER TABLE tbl_market_payment_refunds
    DROP CONSTRAINT IF EXISTS
        tbl_market_payment_refunds_status_check;

ALTER TABLE tbl_market_payment_refunds
    DROP CONSTRAINT IF EXISTS
        uq_market_payment_refund_payment;

ALTER TABLE tbl_market_payment_refunds
    ALTER COLUMN status
        SET DEFAULT 'REQUESTED';

ALTER TABLE tbl_market_payment_refunds
    ADD COLUMN IF NOT EXISTS
        refund_type varchar(20)
        NOT NULL
        DEFAULT 'FULL';

ALTER TABLE tbl_market_payment_refunds
    ADD COLUMN IF NOT EXISTS
        request_source varchar(20)
        NOT NULL
        DEFAULT 'ADMIN';

ALTER TABLE tbl_market_payment_refunds
    ADD COLUMN IF NOT EXISTS
        customer_note text;

ALTER TABLE tbl_market_payment_refunds
    ADD COLUMN IF NOT EXISTS
        reviewed_by uuid
        REFERENCES tbl_users(id);

ALTER TABLE tbl_market_payment_refunds
    ADD COLUMN IF NOT EXISTS
        reviewed_at timestamptz;

ALTER TABLE tbl_market_payment_refunds
    ADD COLUMN IF NOT EXISTS
        approved_by uuid
        REFERENCES tbl_users(id);

ALTER TABLE tbl_market_payment_refunds
    ADD COLUMN IF NOT EXISTS
        approved_at timestamptz;

ALTER TABLE tbl_market_payment_refunds
    ADD COLUMN IF NOT EXISTS
        rejected_by uuid
        REFERENCES tbl_users(id);

ALTER TABLE tbl_market_payment_refunds
    ADD COLUMN IF NOT EXISTS
        rejected_at timestamptz;

ALTER TABLE tbl_market_payment_refunds
    ADD COLUMN IF NOT EXISTS
        rejection_reason text;

ALTER TABLE tbl_market_payment_refunds
    ADD COLUMN IF NOT EXISTS
        payout_due_at timestamptz;

ALTER TABLE tbl_market_payment_refunds
    ADD COLUMN IF NOT EXISTS
        payout_method varchar(30);

ALTER TABLE tbl_market_payment_refunds
    ADD COLUMN IF NOT EXISTS
        payout_destination text;

ALTER TABLE tbl_market_payment_refunds
    ADD COLUMN IF NOT EXISTS
        payout_account_name varchar(255);

ALTER TABLE tbl_market_payment_refunds
    ADD COLUMN IF NOT EXISTS
        payout_reference varchar(255);

ALTER TABLE tbl_market_payment_refunds
    ADD COLUMN IF NOT EXISTS
        payout_proof_url text;

ALTER TABLE tbl_market_payment_refunds
    ADD COLUMN IF NOT EXISTS
        processed_by uuid
        REFERENCES tbl_users(id);

ALTER TABLE tbl_market_payment_refunds
    ADD COLUMN IF NOT EXISTS
        processed_at timestamptz;

ALTER TABLE tbl_market_payment_refunds
    ADD COLUMN IF NOT EXISTS
        reconciliation_data jsonb;

ALTER TABLE tbl_market_payment_refunds
    ADD CONSTRAINT
        tbl_market_payment_refunds_status_check
    CHECK (
        status IN (
            'REQUESTED',
            'UNDER_REVIEW',
            'APPROVED',
            'REJECTED',
            'PROCESSING',
            'COMPLETED',
            'FAILED'
        )
    );

ALTER TABLE tbl_market_payment_refunds
    ADD CONSTRAINT
        tbl_market_payment_refunds_type_check
    CHECK (
        refund_type IN (
            'FULL',
            'PARTIAL'
        )
    );

ALTER TABLE tbl_market_payment_refunds
    ADD CONSTRAINT
        tbl_market_payment_refunds_source_check
    CHECK (
        request_source IN (
            'CUSTOMER',
            'ADMIN',
            'SYSTEM'
        )
    );

ALTER TABLE tbl_market_payment_refunds
    ADD CONSTRAINT
        tbl_market_payment_refunds_payout_method_check
    CHECK (
        payout_method IS NULL
        OR payout_method IN (
            'BANK_TRANSFER',
            'E_WALLET',
            'OTHER'
        )
    );

CREATE INDEX IF NOT EXISTS
    idx_market_payment_refunds_payment
ON tbl_market_payment_refunds (
    market_payment_id,
    created_at DESC
);

CREATE INDEX IF NOT EXISTS
    idx_market_payment_refunds_payout_queue
ON tbl_market_payment_refunds (
    status,
    payout_due_at
)
WHERE status IN (
    'APPROVED',
    'PROCESSING'
);

COMMIT;
