-- =========================================================================
-- FASE 2: ENTERPRISE FOUNDATION - EPIC 2: ENTERPRISE DATA MODEL
-- =========================================================================

-- 1. DOM-001 & DOM-002: Identity & Authentication Domain
CREATE TABLE tbl_roles (
    id SERIAL PRIMARY KEY,
    role_name VARCHAR(50) UNIQUE NOT NULL,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tbl_permissions (
    id SERIAL PRIMARY KEY,
    permission_name VARCHAR(100) UNIQUE NOT NULL,
    description TEXT
);

CREATE TABLE tbl_role_permissions (
    role_id INT REFERENCES tbl_roles(id) ON DELETE CASCADE,
    permission_id INT REFERENCES tbl_permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE tbl_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role_id INT REFERENCES tbl_roles(id),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. DOM-003, DOM-004, DOM-005: Merchant, Product, & Inventory Domain
CREATE TABLE tbl_merchants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES tbl_users(id),
    store_name VARCHAR(150) NOT NULL,
    address TEXT,
    status VARCHAR(30) DEFAULT 'ACTIVE',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tbl_product_categories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    parent_id INT REFERENCES tbl_product_categories(id)
);

CREATE TABLE tbl_products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID REFERENCES tbl_merchants(id),
    category_id INT REFERENCES tbl_product_categories(id),
    sku VARCHAR(64) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tbl_product_prices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID REFERENCES tbl_products(id) ON DELETE CASCADE,
    price_type VARCHAR(30) DEFAULT 'RETAIL', -- RETAIL, WHOLESOME, TIER_1
    amount NUMERIC(12, 2) NOT NULL,
    effective_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tbl_warehouses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    warehouse_name VARCHAR(150) NOT NULL,
    location TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tbl_inventory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    warehouse_id UUID REFERENCES tbl_warehouses(id),
    product_id UUID REFERENCES tbl_products(id),
    quantity_on_hand INT DEFAULT 0,
    min_stock_level INT DEFAULT 5,
    max_stock_level INT DEFAULT 100,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tbl_inventory_movements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID REFERENCES tbl_products(id),
    warehouse_id UUID REFERENCES tbl_warehouses(id),
    movement_type VARCHAR(30) NOT NULL, -- IN, OUT, TRANSFER, ADJUSTMENT
    quantity INT NOT NULL,
    reference_doc VARCHAR(100),
    created_by UUID REFERENCES tbl_users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. DOM-007 & DOM-008: Supplier & Purchase Domain
CREATE TABLE tbl_suppliers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier_name VARCHAR(150) NOT NULL,
    contact_person VARCHAR(100),
    phone VARCHAR(30),
    email VARCHAR(100),
    address TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tbl_purchase_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier_id UUID REFERENCES tbl_suppliers(id),
    warehouse_id UUID REFERENCES tbl_warehouses(id),
    status VARCHAR(30) DEFAULT 'DRAFT', -- DRAFT, APPROVED, COMPLETED, CANCELLED
    total_amount NUMERIC(14, 2) DEFAULT 0.00,
    created_by UUID REFERENCES tbl_users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tbl_purchase_order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_order_id UUID REFERENCES tbl_purchase_orders(id) ON DELETE CASCADE,
    product_id UUID REFERENCES tbl_products(id),
    quantity INT NOT NULL,
    unit_cost NUMERIC(12, 2) NOT NULL
);

-- 4. DOM-009, DOM-010, DOM-011: Sales, Customer, & CRM Domain
CREATE TABLE tbl_customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES tbl_users(id),
    full_name VARCHAR(150) NOT NULL,
    phone VARCHAR(30),
    phone_verified_at TIMESTAMP WITH TIME ZONE,
    tier_status VARCHAR(30) DEFAULT 'STANDARD', -- STANDARD, SILVER, GOLD, PLATINUM
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX uq_tbl_customers_phone_nonempty
ON tbl_customers (phone)
WHERE phone IS NOT NULL
  AND BTRIM(phone) <> '';


CREATE TABLE tbl_phone_verification_challenges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL UNIQUE
        REFERENCES tbl_customers(id) ON DELETE CASCADE,
    phone VARCHAR(30) NOT NULL,
    code_hash TEXT NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    requested_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    consumed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_phone_verification_expires_at
ON tbl_phone_verification_challenges (expires_at);


CREATE TABLE tbl_loyalty_points (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID REFERENCES tbl_customers(id) ON DELETE CASCADE,
    points INT DEFAULT 0,
    transaction_type VARCHAR(30), -- EARNED, REDEEMED
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tbl_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID REFERENCES tbl_customers(id),
    merchant_id UUID REFERENCES tbl_merchants(id),
    status VARCHAR(30) DEFAULT 'PENDING', -- PENDING, PAID, PROCESSING, SHIPPED, COMPLETED, CANCELLED
    shipping_address TEXT,
    total_amount NUMERIC(14, 2) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tbl_order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID REFERENCES tbl_orders(id) ON DELETE CASCADE,
    product_id UUID REFERENCES tbl_products(id),
    quantity INT NOT NULL,
    unit_price NUMERIC(12, 2) NOT NULL
);

-- 5. DOM-012: Finance Domain
CREATE TABLE tbl_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID REFERENCES tbl_orders(id),
    payment_method VARCHAR(50) NOT NULL, -- QRIS, BANK_TRANSFER, COD, WALLET
    payment_status VARCHAR(30) DEFAULT 'UNPAID', -- UNPAID, PAID, FAILED, REFUNDED
    amount NUMERIC(14, 2) NOT NULL,
    gateway_response JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 6. DOM-013: Courier & Logistics Domain
CREATE TABLE tbl_shipments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID REFERENCES tbl_orders(id),
    courier_id UUID REFERENCES tbl_users(id),
    tracking_number VARCHAR(100) UNIQUE,
    shipping_status VARCHAR(30) DEFAULT 'ASSIGNED', -- ASSIGNED, PICKED_UP, ON_THE_WAY, DELIVERED
    notes TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 7. DOM-014: AI Engine Domain
CREATE TABLE tbl_ai_predictions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type VARCHAR(50), -- PRODUCT, INVENTORY, SALES_FORECAST
    entity_id UUID,
    prediction_data JSONB,
    confidence_score NUMERIC(5, 2),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 8. DOM-015: Reporting, Audit, & Events (Kernel Core)
CREATE TABLE tbl_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type VARCHAR(100),
    actor_id UUID,
    ip_address VARCHAR(45),
    payload JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tbl_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_name VARCHAR(100) NOT NULL,
    aggregate_id UUID,
    payload JSONB,
    processed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tbl_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES tbl_users(id),
    title VARCHAR(150),
    message TEXT,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- WhatsApp Customer Order Drafts
-- Draft sementara sebelum Customer melakukan konfirmasi eksplisit.
-- Tidak merepresentasikan order nyata.
-- ============================================================

CREATE TABLE IF NOT EXISTS tbl_whatsapp_order_drafts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    customer_id UUID NOT NULL
        REFERENCES tbl_customers(id)
        ON DELETE CASCADE,

    product_id UUID NOT NULL
        REFERENCES tbl_products(id),

    quantity INTEGER NOT NULL
        CHECK (quantity > 0 AND quantity <= 100),

    unit_price NUMERIC(14,2) NOT NULL
        CHECK (unit_price >= 0),

    subtotal NUMERIC(14,2) NOT NULL
        CHECK (subtotal >= 0),

    available_stock_snapshot INTEGER NOT NULL
        CHECK (available_stock_snapshot >= 0),

    source_message_id VARCHAR(128) NOT NULL,

    status VARCHAR(32) NOT NULL
        DEFAULT 'PENDING_CONFIRMATION'
        CHECK (
            status IN (
                'PENDING_CONFIRMATION',
                'CONFIRMED',
                'CANCELLED',
                'EXPIRED'
            )
        ),

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    expires_at TIMESTAMPTZ NOT NULL
        DEFAULT (CURRENT_TIMESTAMP + INTERVAL '15 minutes'),

    confirmed_at TIMESTAMPTZ,

    cancelled_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS
uq_whatsapp_order_drafts_source_message
ON tbl_whatsapp_order_drafts(source_message_id);

CREATE UNIQUE INDEX IF NOT EXISTS
uq_whatsapp_order_drafts_one_pending_per_customer
ON tbl_whatsapp_order_drafts(customer_id)
WHERE status = 'PENDING_CONFIRMATION';

CREATE INDEX IF NOT EXISTS
idx_whatsapp_order_drafts_customer_created
ON tbl_whatsapp_order_drafts(customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS
idx_whatsapp_order_drafts_expires
ON tbl_whatsapp_order_drafts(expires_at)
WHERE status = 'PENDING_CONFIRMATION';

-- Link WhatsApp draft ke order hasil konfirmasi.
ALTER TABLE tbl_whatsapp_order_drafts
ADD COLUMN IF NOT EXISTS confirmed_order_id UUID;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'tbl_whatsapp_order_drafts_confirmed_order_id_fkey'
    ) THEN
        ALTER TABLE tbl_whatsapp_order_drafts
        ADD CONSTRAINT tbl_whatsapp_order_drafts_confirmed_order_id_fkey
        FOREIGN KEY (confirmed_order_id)
        REFERENCES tbl_orders_v2(id);
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS
uq_whatsapp_order_drafts_confirmed_order
ON tbl_whatsapp_order_drafts(confirmed_order_id)
WHERE confirmed_order_id IS NOT NULL;

-- ============================================================
-- WhatsApp Notification Delivery Ledger
-- Idempotency + delivery state untuk subscriber event WhatsApp.
-- ============================================================
CREATE TABLE IF NOT EXISTS tbl_whatsapp_notification_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_key VARCHAR(180) NOT NULL,
    notification_type VARCHAR(64) NOT NULL,
    order_id UUID
        REFERENCES tbl_orders_v2(id)
        ON DELETE CASCADE,
    customer_id UUID
        REFERENCES tbl_customers(id)
        ON DELETE CASCADE,
    phone VARCHAR(32),
    status VARCHAR(24) NOT NULL
        DEFAULT 'PENDING'
        CHECK (
            status IN (
                'PENDING',
                'SENT',
                'FAILED'
            )
        ),
    outbound_message_id VARCHAR(180),
    attempts INTEGER NOT NULL
        DEFAULT 1
        CHECK (attempts >= 1),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,
    sent_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS
uq_whatsapp_notification_delivery_event
ON tbl_whatsapp_notification_deliveries(event_key);

CREATE INDEX IF NOT EXISTS
idx_whatsapp_notification_delivery_order
ON tbl_whatsapp_notification_deliveries(order_id);

CREATE INDEX IF NOT EXISTS
idx_whatsapp_notification_delivery_status
ON tbl_whatsapp_notification_deliveries(status, updated_at);

-- ============================================================
-- Event Store Timestamp Contract
-- EventKernel mengirim ISO-8601 UTC melalui Date#toISOString().
-- Nilai historis timestamp tanpa timezone ditafsirkan sebagai UTC.
-- ============================================================
ALTER TABLE tbl_event_store
ALTER COLUMN created_at
TYPE TIMESTAMPTZ
USING created_at AT TIME ZONE 'UTC';

ALTER TABLE tbl_event_store
ALTER COLUMN created_at
SET DEFAULT CURRENT_TIMESTAMP;
