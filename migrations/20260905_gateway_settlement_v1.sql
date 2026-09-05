BEGIN;

CREATE TABLE IF NOT EXISTS tbl_gateway_settlements (
    id uuid PRIMARY KEY
        DEFAULT gen_random_uuid(),

    provider varchar(50) NOT NULL,

    settlement_reference varchar(150)
        NOT NULL,

    status varchar(20) NOT NULL
        DEFAULT 'RECORDED',

    gross_amount numeric(14,2) NOT NULL,

    bank_received_amount numeric(14,2),

    unresolved_amount numeric(14,2),

    settlement_at timestamptz,

    bank_reference varchar(200),

    evidence_reference text,

    reconciliation_data jsonb,

    created_by uuid
        REFERENCES tbl_users(id),

    reconciled_by uuid
        REFERENCES tbl_users(id),

    created_at timestamptz NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    reconciled_at timestamptz,

    updated_at timestamptz NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT
        tbl_gateway_settlements_status_check
        CHECK (
            status IN (
                'RECORDED',
                'RECONCILED',
                'REJECTED'
            )
        ),

    CONSTRAINT
        tbl_gateway_settlements_gross_check
        CHECK (
            gross_amount > 0
        ),

    CONSTRAINT
        tbl_gateway_settlements_bank_amount_check
        CHECK (
            bank_received_amount IS NULL
            OR bank_received_amount >= 0
        ),

    CONSTRAINT
        tbl_gateway_settlements_unresolved_check
        CHECK (
            unresolved_amount IS NULL
            OR unresolved_amount >= 0
        ),

    CONSTRAINT
        tbl_gateway_settlements_reconciled_check
        CHECK (
            status <> 'RECONCILED'
            OR (
                bank_received_amount IS NOT NULL
                AND unresolved_amount IS NOT NULL
                AND settlement_at IS NOT NULL
                AND bank_reference IS NOT NULL
                AND BTRIM(bank_reference) <> ''
                AND evidence_reference IS NOT NULL
                AND BTRIM(evidence_reference) <> ''
                AND reconciled_by IS NOT NULL
                AND reconciled_at IS NOT NULL
                AND gross_amount =
                    bank_received_amount
                    + unresolved_amount
            )
        ),

    CONSTRAINT
        tbl_gateway_settlements_amount_relation_check
        CHECK (
            bank_received_amount IS NULL
            OR bank_received_amount <= gross_amount
        ),

    CONSTRAINT
        uq_gateway_settlement_provider_reference
        UNIQUE (
            provider,
            settlement_reference
        )
);

CREATE TABLE IF NOT EXISTS
    tbl_gateway_settlement_allocations (
        id uuid PRIMARY KEY
            DEFAULT gen_random_uuid(),

        settlement_id uuid NOT NULL
            REFERENCES tbl_gateway_settlements(id)
            ON DELETE CASCADE,

        market_payment_id uuid NOT NULL
            REFERENCES tbl_market_payments(id),

        amount numeric(14,2) NOT NULL,

        created_at timestamptz NOT NULL
            DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT
            tbl_gateway_settlement_allocation_amount_check
            CHECK (
                amount > 0
            ),

        CONSTRAINT
            uq_gateway_settlement_market_payment
            UNIQUE (
                market_payment_id
            )
    );

CREATE INDEX IF NOT EXISTS
    idx_gateway_settlements_status
ON tbl_gateway_settlements(
    status
);

CREATE INDEX IF NOT EXISTS
    idx_gateway_settlements_provider
ON tbl_gateway_settlements(
    provider
);

CREATE INDEX IF NOT EXISTS
    idx_gateway_settlement_allocations_settlement
ON tbl_gateway_settlement_allocations(
    settlement_id
);

COMMIT;
