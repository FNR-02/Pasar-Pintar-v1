ALTER TABLE tbl_whatsapp_notification_deliveries
    ADD COLUMN IF NOT EXISTS payload_media_url TEXT,
    ADD COLUMN IF NOT EXISTS payload_media_type VARCHAR(24);
