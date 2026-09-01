BEGIN;

ALTER TABLE tbl_whatsapp_notification_deliveries
ADD COLUMN IF NOT EXISTS market_order_id uuid;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname =
            'tbl_whatsapp_notification_deliveries_market_order_id_fkey'
    ) THEN
        ALTER TABLE tbl_whatsapp_notification_deliveries
        ADD CONSTRAINT
            tbl_whatsapp_notification_deliveries_market_order_id_fkey
        FOREIGN KEY (market_order_id)
        REFERENCES tbl_market_orders(id)
        ON DELETE CASCADE;
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS
idx_whatsapp_notification_delivery_market_order
ON tbl_whatsapp_notification_deliveries(market_order_id);

COMMIT;
