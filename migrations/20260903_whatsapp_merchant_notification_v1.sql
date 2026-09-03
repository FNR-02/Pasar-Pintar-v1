BEGIN;

ALTER TABLE tbl_whatsapp_notification_deliveries
ADD COLUMN IF NOT EXISTS merchant_id UUID;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname =
            'tbl_whatsapp_notification_deliveries_merchant_id_fkey'
    ) THEN
        ALTER TABLE tbl_whatsapp_notification_deliveries
        ADD CONSTRAINT
            tbl_whatsapp_notification_deliveries_merchant_id_fkey
        FOREIGN KEY (merchant_id)
        REFERENCES tbl_merchants(id)
        ON DELETE CASCADE;
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS
    idx_whatsapp_notification_delivery_merchant
ON tbl_whatsapp_notification_deliveries (merchant_id);

COMMIT;
