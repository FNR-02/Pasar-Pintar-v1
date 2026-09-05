CREATE TABLE IF NOT EXISTS
    tbl_merchant_entitlement_adjustments
(
    id UUID PRIMARY KEY
        DEFAULT gen_random_uuid(),

    entitlement_id UUID NOT NULL
        REFERENCES tbl_merchant_entitlements(id),

    merchant_id UUID NOT NULL
        REFERENCES tbl_merchants(id),

    order_id UUID NOT NULL
        REFERENCES tbl_orders_v2(id),

    market_order_id UUID NOT NULL
        REFERENCES tbl_market_orders(id),

    refund_id UUID NOT NULL
        REFERENCES tbl_market_payment_refunds(id),

    refund_allocation_id UUID NOT NULL
        REFERENCES tbl_market_refund_allocations(id),

    adjustment_type VARCHAR(50) NOT NULL
        CHECK (
            adjustment_type IN (
                'REFUND_COMPLETED'
            )
        ),

    amount NUMERIC NOT NULL
        CHECK (amount > 0),

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT
        uq_merchant_entitlement_refund_allocation
        UNIQUE (refund_allocation_id)
);

CREATE INDEX IF NOT EXISTS
    idx_merchant_entitlement_adjustments_entitlement
ON tbl_merchant_entitlement_adjustments(
    entitlement_id
);

CREATE INDEX IF NOT EXISTS
    idx_merchant_entitlement_adjustments_merchant
ON tbl_merchant_entitlement_adjustments(
    merchant_id,
    created_at
);

CREATE INDEX IF NOT EXISTS
    idx_merchant_entitlement_adjustments_order
ON tbl_merchant_entitlement_adjustments(
    order_id
);

CREATE INDEX IF NOT EXISTS
    idx_merchant_entitlement_adjustments_refund
ON tbl_merchant_entitlement_adjustments(
    refund_id
);
