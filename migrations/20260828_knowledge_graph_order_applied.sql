CREATE TABLE IF NOT EXISTS tbl_knowledge_graph_order_applied (
    order_id UUID PRIMARY KEY,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
