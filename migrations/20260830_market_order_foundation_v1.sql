BEGIN;

CREATE TABLE IF NOT EXISTS tbl_markets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name varchar(150) NOT NULL,
    code varchar(50) NOT NULL UNIQUE,
    address text,
    city varchar(100),
    status varchar(30) NOT NULL DEFAULT 'ACTIVE',
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),

    CONSTRAINT tbl_markets_status_check
    CHECK (status IN ('ACTIVE', 'INACTIVE'))
);

CREATE TABLE IF NOT EXISTS tbl_market_merchants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    market_id uuid NOT NULL
        REFERENCES tbl_markets(id),
    merchant_id uuid NOT NULL
        REFERENCES tbl_merchants(id),
    stall_name varchar(150),
    stall_number varchar(50),
    status varchar(30) NOT NULL DEFAULT 'ACTIVE',
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),

    CONSTRAINT tbl_market_merchants_unique
    UNIQUE (market_id, merchant_id),

    CONSTRAINT tbl_market_merchants_status_check
    CHECK (status IN ('ACTIVE', 'INACTIVE'))
);

CREATE TABLE IF NOT EXISTS tbl_market_orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid NOT NULL
        REFERENCES tbl_customers(id),
    market_id uuid NOT NULL
        REFERENCES tbl_markets(id),
    status varchar(40) NOT NULL DEFAULT 'PENDING',
    fulfillment_type varchar(20) NOT NULL,
    shipping_address text,
    total_amount numeric NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),

    CONSTRAINT tbl_market_orders_status_check
    CHECK (
        status IN (
            'PENDING',
            'COLLECTING',
            'READY_FOR_DELIVERY',
            'OUT_FOR_DELIVERY',
            'DELIVERED',
            'CANCELLED'
        )
    ),

    CONSTRAINT tbl_market_orders_fulfillment_check
    CHECK (
        fulfillment_type IN (
            'DELIVERY',
            'PICKUP'
        )
    )
);

ALTER TABLE tbl_orders_v2
ADD COLUMN IF NOT EXISTS market_order_id uuid;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname =
            'tbl_orders_v2_market_order_id_fkey'
    ) THEN
        ALTER TABLE tbl_orders_v2
        ADD CONSTRAINT
            tbl_orders_v2_market_order_id_fkey
        FOREIGN KEY (market_order_id)
        REFERENCES tbl_market_orders(id);
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS tbl_collector_tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    market_order_id uuid NOT NULL
        REFERENCES tbl_market_orders(id),
    courier_id uuid
        REFERENCES tbl_couriers(id),
    status varchar(40) NOT NULL DEFAULT 'PENDING',
    assigned_at timestamptz,
    collection_started_at timestamptz,
    collection_completed_at timestamptz,
    delivery_started_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),

    CONSTRAINT tbl_collector_tasks_market_order_unique
    UNIQUE (market_order_id),

    CONSTRAINT tbl_collector_tasks_status_check
    CHECK (
        status IN (
            'PENDING',
            'ASSIGNED',
            'COLLECTING',
            'COLLECTED',
            'OUT_FOR_DELIVERY',
            'COMPLETED',
            'CANCELLED'
        )
    )
);

CREATE TABLE IF NOT EXISTS tbl_collector_task_stops (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    collector_task_id uuid NOT NULL
        REFERENCES tbl_collector_tasks(id),
    order_id uuid NOT NULL
        REFERENCES tbl_orders_v2(id),
    sequence_no integer,
    status varchar(40) NOT NULL DEFAULT 'PENDING',
    ready_at timestamptz,
    arrived_at timestamptz,
    picked_up_at timestamptz,
    issue_reason text,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),

    CONSTRAINT tbl_collector_task_stops_unique
    UNIQUE (collector_task_id, order_id),

    CONSTRAINT tbl_collector_task_stops_sequence_check
    CHECK (
        sequence_no IS NULL
        OR sequence_no > 0
    ),

    CONSTRAINT tbl_collector_task_stops_status_check
    CHECK (
        status IN (
            'PENDING',
            'READY',
            'ARRIVED',
            'PICKED_UP',
            'ISSUE',
            'CANCELLED'
        )
    )
);

CREATE INDEX IF NOT EXISTS
    idx_collector_task_stops_task
ON tbl_collector_task_stops (
    collector_task_id,
    status,
    sequence_no
);

CREATE INDEX IF NOT EXISTS
    idx_collector_task_stops_order
ON tbl_collector_task_stops (
    order_id
);

CREATE INDEX IF NOT EXISTS
    idx_market_merchants_market
ON tbl_market_merchants (
    market_id,
    status
);

CREATE INDEX IF NOT EXISTS
    idx_market_merchants_merchant
ON tbl_market_merchants (
    merchant_id
);

CREATE INDEX IF NOT EXISTS
    idx_market_orders_customer
ON tbl_market_orders (
    customer_id,
    created_at DESC
);

CREATE INDEX IF NOT EXISTS
    idx_market_orders_market
ON tbl_market_orders (
    market_id,
    status,
    created_at DESC
);

CREATE INDEX IF NOT EXISTS
    idx_orders_v2_market_order
ON tbl_orders_v2 (
    market_order_id
)
WHERE market_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS
    idx_collector_tasks_courier
ON tbl_collector_tasks (
    courier_id,
    status
)
WHERE courier_id IS NOT NULL;

COMMIT;
