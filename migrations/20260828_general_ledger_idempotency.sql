CREATE UNIQUE INDEX IF NOT EXISTS uq_general_ledger_ref_account
ON tbl_general_ledger (transaction_reference, account_code);
