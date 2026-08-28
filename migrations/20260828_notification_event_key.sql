ALTER TABLE tbl_notifications
ADD COLUMN IF NOT EXISTS event_key VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_event_key
ON tbl_notifications (event_key)
WHERE event_key IS NOT NULL;
