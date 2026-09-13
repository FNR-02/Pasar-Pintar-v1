BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS
    idx_merchant_withdrawal_one_requested
ON tbl_merchant_withdrawal_requests (
    merchant_id
)
WHERE status = 'REQUESTED';

COMMIT;
