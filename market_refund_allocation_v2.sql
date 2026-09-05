CREATE TABLE IF NOT EXISTS tbl_market_refund_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    refund_id UUID NOT NULL
        REFERENCES tbl_market_payment_refunds(id)
        ON DELETE CASCADE,

    order_id UUID NOT NULL
        REFERENCES tbl_orders_v2(id),

    merchant_id UUID NOT NULL
        REFERENCES tbl_merchants(id),

    order_item_id UUID NULL
        REFERENCES tbl_order_items(id),

    amount NUMERIC NOT NULL
        CHECK (amount > 0),

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS
    uq_market_refund_allocation_order
ON tbl_market_refund_allocations (
    refund_id,
    order_id
)
WHERE order_item_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS
    uq_market_refund_allocation_item
ON tbl_market_refund_allocations (
    refund_id,
    order_item_id
)
WHERE order_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS
    idx_market_refund_allocations_refund
ON tbl_market_refund_allocations(refund_id);

CREATE INDEX IF NOT EXISTS
    idx_market_refund_allocations_order
ON tbl_market_refund_allocations(order_id);

CREATE INDEX IF NOT EXISTS
    idx_market_refund_allocations_merchant
ON tbl_market_refund_allocations(merchant_id);
