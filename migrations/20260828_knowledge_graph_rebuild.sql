BEGIN;

DELETE FROM tbl_knowledge_graph
WHERE source_type = 'CUSTOMER'
  AND ((relation = 'BUYS' AND target_type = 'PRODUCT')
    OR (relation = 'BUYS_FROM' AND target_type = 'MERCHANT'));

WITH fulfilled_items AS (
    SELECT
        o.id AS order_id,
        o.customer_id,
        o.merchant_id,
        o.created_at,
        oi.product_id,
        oi.quantity
    FROM tbl_orders_v2 o
    JOIN tbl_order_items oi
      ON oi.order_id = o.id
    JOIN tbl_inventory_movements im
      ON im.reference_doc = 'ORD-' || o.id::text
     AND im.product_id = oi.product_id
     AND im.movement_type = 'SALE'
),
product_edges AS (
    SELECT
        customer_id,
        product_id,
        SUM(quantity)::numeric AS weight,
        (ARRAY_AGG(order_id ORDER BY created_at DESC, order_id DESC))[1] AS last_order_id
    FROM fulfilled_items
    GROUP BY customer_id, product_id
)
INSERT INTO tbl_knowledge_graph
(source_type, source_id, relation, target_type, target_id, weight, metadata)
SELECT
    'CUSTOMER',
    customer_id,
    'BUYS',
    'PRODUCT',
    product_id,
    weight,
    jsonb_build_object('last_order_id', last_order_id::text)
FROM product_edges;

WITH fulfilled_orders AS (
    SELECT DISTINCT
        o.id AS order_id,
        o.customer_id,
        o.merchant_id,
        o.created_at
    FROM tbl_orders_v2 o
    JOIN tbl_inventory_movements im
      ON im.reference_doc = 'ORD-' || o.id::text
     AND im.movement_type = 'SALE'
),
merchant_edges AS (
    SELECT
        customer_id,
        merchant_id,
        COUNT(*)::numeric AS weight,
        (ARRAY_AGG(order_id ORDER BY created_at DESC, order_id DESC))[1] AS last_order_id
    FROM fulfilled_orders
    GROUP BY customer_id, merchant_id
)
INSERT INTO tbl_knowledge_graph
(source_type, source_id, relation, target_type, target_id, weight, metadata)
SELECT
    'CUSTOMER',
    customer_id,
    'BUYS_FROM',
    'MERCHANT',
    merchant_id,
    weight,
    jsonb_build_object('last_order_id', last_order_id::text)
FROM merchant_edges;

INSERT INTO tbl_knowledge_graph_order_applied (order_id)
SELECT DISTINCT o.id
FROM tbl_orders_v2 o
JOIN tbl_inventory_movements im
  ON im.reference_doc = 'ORD-' || o.id::text
 AND im.movement_type = 'SALE'
ON CONFLICT (order_id) DO NOTHING;

COMMIT;
