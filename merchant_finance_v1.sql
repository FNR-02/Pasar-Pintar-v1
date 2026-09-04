-- Pasar Pintar
-- Merchant Finance v1
-- Tahap 1: Merchant Entitlement
--
-- Tujuan:
-- Mencatat hak finansial merchant dari setiap child order.
-- GMV merchant bukan otomatis pendapatan Pasar Pintar.

CREATE TABLE IF NOT EXISTS tbl_merchant_entitlements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    merchant_id UUID NOT NULL
        REFERENCES tbl_merchants(id),

    order_id UUID NOT NULL
        REFERENCES tbl_orders_v2(id),

    market_order_id UUID NULL
        REFERENCES tbl_market_orders(id),

    gross_amount NUMERIC(18,2) NOT NULL
        CHECK (gross_amount >= 0),

    platform_commission NUMERIC(18,2) NOT NULL DEFAULT 0
        CHECK (platform_commission >= 0),

    merchant_entitlement NUMERIC(18,2) NOT NULL
        CHECK (merchant_entitlement >= 0),

    status VARCHAR(30) NOT NULL DEFAULT 'PENDING'
        CHECK (
            status IN (
                'PENDING',
                'AVAILABLE',
                'SETTLED',
                'REVERSED'
            )
        ),

    source_event VARCHAR(50) NOT NULL DEFAULT 'ORDER_PAID',

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    available_at TIMESTAMPTZ NULL,
    settled_at TIMESTAMPTZ NULL,
    reversed_at TIMESTAMPTZ NULL,

    CONSTRAINT uq_merchant_entitlement_order
        UNIQUE (order_id),

    CONSTRAINT chk_merchant_entitlement_amount
        CHECK (
            merchant_entitlement =
            gross_amount - platform_commission
        )
);

CREATE INDEX IF NOT EXISTS
    idx_merchant_entitlements_merchant_status
ON tbl_merchant_entitlements (
    merchant_id,
    status
);

CREATE INDEX IF NOT EXISTS
    idx_merchant_entitlements_market_order
ON tbl_merchant_entitlements (
    market_order_id
);
