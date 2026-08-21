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
