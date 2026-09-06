CREATE TABLE IF NOT EXISTS tbl_whatsapp_product_contexts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL
        REFERENCES tbl_customers(id)
        ON DELETE CASCADE,
    context_type VARCHAR(48) NOT NULL,
    context_payload JSONB NOT NULL,
    source_message_id VARCHAR(128),
    status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP + INTERVAL '10 minutes'
);

CREATE INDEX IF NOT EXISTS
    idx_whatsapp_product_contexts_customer_active
ON tbl_whatsapp_product_contexts (
    customer_id,
    status,
    expires_at DESC
);
