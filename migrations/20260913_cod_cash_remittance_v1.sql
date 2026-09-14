BEGIN;

CREATE TABLE IF NOT EXISTS
    tbl_cod_cash_remittances (
        id uuid PRIMARY KEY
            DEFAULT gen_random_uuid(),

        courier_id uuid NOT NULL
            REFERENCES tbl_couriers(id),

        remittance_reference varchar(150)
            NOT NULL,

        status varchar(20) NOT NULL
            DEFAULT 'RECORDED',

        gross_amount numeric(14,2) NOT NULL,

        received_amount numeric(14,2),

        unresolved_amount numeric(14,2),

        remitted_at timestamptz,

        receipt_reference varchar(200),

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
            tbl_cod_cash_remittances_status_check
            CHECK (
                status IN (
                    'RECORDED',
                    'RECONCILED',
                    'REJECTED'
                )
            ),

        CONSTRAINT
            tbl_cod_cash_remittances_gross_check
            CHECK (
                gross_amount > 0
            ),

        CONSTRAINT
            tbl_cod_cash_remittances_received_check
            CHECK (
                received_amount IS NULL
                OR received_amount >= 0
            ),

        CONSTRAINT
            tbl_cod_cash_remittances_unresolved_check
            CHECK (
                unresolved_amount IS NULL
                OR unresolved_amount >= 0
            ),

        CONSTRAINT
            tbl_cod_cash_remittances_reconciled_check
            CHECK (
                status <> 'RECONCILED'
                OR (
                    received_amount IS NOT NULL
                    AND unresolved_amount IS NOT NULL
                    AND remitted_at IS NOT NULL
                    AND receipt_reference IS NOT NULL
                    AND BTRIM(receipt_reference) <> ''
                    AND evidence_reference IS NOT NULL
                    AND BTRIM(evidence_reference) <> ''
                    AND reconciled_by IS NOT NULL
                    AND reconciled_at IS NOT NULL
                    AND gross_amount =
                        received_amount
                        + unresolved_amount
                )
            ),

        CONSTRAINT
            tbl_cod_cash_remittances_amount_relation_check
            CHECK (
                received_amount IS NULL
                OR received_amount <= gross_amount
            ),

        CONSTRAINT
            uq_cod_cash_remittance_reference
            UNIQUE (
                remittance_reference
            )
    );

CREATE TABLE IF NOT EXISTS
    tbl_cod_cash_remittance_allocations (
        id uuid PRIMARY KEY
            DEFAULT gen_random_uuid(),

        remittance_id uuid NOT NULL
            REFERENCES tbl_cod_cash_remittances(id)
            ON DELETE CASCADE,

        market_payment_id uuid NOT NULL
            REFERENCES tbl_market_payments(id),

        collector_task_id uuid NOT NULL
            REFERENCES tbl_collector_tasks(id),

        amount numeric(14,2) NOT NULL,

        created_at timestamptz NOT NULL
            DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT
            tbl_cod_cash_remittance_allocation_amount_check
            CHECK (
                amount > 0
            ),

        CONSTRAINT
            uq_cod_cash_remittance_market_payment
            UNIQUE (
                market_payment_id
            )
    );

CREATE INDEX IF NOT EXISTS
    idx_cod_cash_remittances_status
ON tbl_cod_cash_remittances(
    status
);

CREATE INDEX IF NOT EXISTS
    idx_cod_cash_remittances_courier
ON tbl_cod_cash_remittances(
    courier_id
);

CREATE INDEX IF NOT EXISTS
    idx_cod_cash_remittance_allocations_remittance
ON tbl_cod_cash_remittance_allocations(
    remittance_id
);

CREATE INDEX IF NOT EXISTS
    idx_cod_cash_remittance_allocations_task
ON tbl_cod_cash_remittance_allocations(
    collector_task_id
);

COMMIT;
