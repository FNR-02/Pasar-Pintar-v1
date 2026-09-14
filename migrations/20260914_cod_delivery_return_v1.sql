BEGIN;

ALTER TABLE tbl_market_orders
DROP CONSTRAINT IF EXISTS tbl_market_orders_status_check;

ALTER TABLE tbl_market_orders
ADD CONSTRAINT tbl_market_orders_status_check
CHECK (
    status IN (
        'PENDING',
        'COLLECTING',
        'READY_FOR_DELIVERY',
        'OUT_FOR_DELIVERY',
        'RETURNING',
        'RETURNED',
        'DELIVERED',
        'CANCELLED'
    )
);

ALTER TABLE tbl_collector_tasks
DROP CONSTRAINT IF EXISTS tbl_collector_tasks_status_check;

ALTER TABLE tbl_collector_tasks
ADD CONSTRAINT tbl_collector_tasks_status_check
CHECK (
    status IN (
        'PENDING',
        'ASSIGNED',
        'COLLECTING',
        'COLLECTED',
        'OUT_FOR_DELIVERY',
        'RETURNING',
        'RETURNED',
        'COMPLETED',
        'CANCELLED'
    )
);

ALTER TABLE tbl_collector_task_stops
DROP CONSTRAINT IF EXISTS tbl_collector_task_stops_status_check;

ALTER TABLE tbl_collector_task_stops
ADD CONSTRAINT tbl_collector_task_stops_status_check
CHECK (
    status IN (
        'PENDING',
        'READY',
        'ARRIVED',
        'PICKED_UP',
        'ISSUE',
        'RETURNED',
        'CANCELLED'
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS
    tbl_inventory_movements_cod_return_unique
ON tbl_inventory_movements (
    reference_doc,
    product_id,
    movement_type
)
WHERE movement_type = 'COD_RETURN';

COMMIT;
