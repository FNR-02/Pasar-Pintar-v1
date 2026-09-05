BEGIN;

DO $$
DECLARE
    v_candidate_count integer;
    v_candidate_amount numeric;
    v_existing_refs integer;
    v_existing_rows integer;
BEGIN
    SELECT
        COUNT(*),
        COALESCE(SUM(o.total_amount), 0)
    INTO
        v_candidate_count,
        v_candidate_amount
    FROM tbl_orders_v2 o
    JOIN tbl_payments p
      ON p.order_id = o.id
    JOIN tbl_merchant_entitlements e
      ON e.order_id = o.id
    WHERE o.market_order_id IS NOT NULL
      AND p.provider = 'MIDTRANS'
      AND p.payment_status = 'PAID'
      AND p.payment_method IN (
          'QRIS',
          'VIRTUAL_ACCOUNT'
      )
      AND p.amount = o.total_amount
      AND e.status = 'PENDING'
      AND e.merchant_entitlement = o.total_amount
      AND e.platform_commission = 0
      AND (
          SELECT COUNT(*)
          FROM tbl_payments px
          WHERE px.order_id = o.id
            AND px.payment_status = 'PAID'
      ) = 1;

    SELECT
        COUNT(DISTINCT transaction_reference),
        COUNT(*)
    INTO
        v_existing_refs,
        v_existing_rows
    FROM tbl_general_ledger
    WHERE transaction_reference LIKE
          'RECLASS-MKT-%';

    IF v_existing_refs = 6
       AND v_existing_rows = 24
       AND v_candidate_count = 6
       AND v_candidate_amount = 113000 THEN
        RAISE NOTICE
          'Marketplace historical reclassification already complete';
        RETURN;
    END IF;

    IF v_existing_refs <> 0
       OR v_existing_rows <> 0 THEN
        RAISE EXCEPTION
          'Partial reclassification detected: refs=%, rows=%',
          v_existing_refs,
          v_existing_rows;
    END IF;

    IF v_candidate_count <> 6
       OR v_candidate_amount <> 113000 THEN
        RAISE EXCEPTION
          'Candidate guard failed: count=%, amount=%',
          v_candidate_count,
          v_candidate_amount;
    END IF;

    INSERT INTO tbl_general_ledger (
        transaction_reference,
        account_code,
        account_name,
        debit,
        credit,
        description
    )
    SELECT
        'RECLASS-MKT-' || o.id::text,
        x.account_code,
        x.account_name,
        CASE
            WHEN x.account_code IN ('4000','1400')
            THEN o.total_amount
            ELSE 0
        END,
        CASE
            WHEN x.account_code IN ('1100','2200')
            THEN o.total_amount
            ELSE 0
        END,
        x.description
    FROM tbl_orders_v2 o
    JOIN tbl_payments p
      ON p.order_id = o.id
    JOIN tbl_merchant_entitlements e
      ON e.order_id = o.id
    CROSS JOIN (
        VALUES
        (
            '4000',
            'Pendapatan Penjualan',
            'Koreksi historis marketplace: reversal pendapatan lama'
        ),
        (
            '1100',
            'Kas & Bank',
            'Koreksi historis marketplace: reversal kas lama'
        ),
        (
            '1400',
            'Dana di Payment Gateway',
            'Koreksi historis marketplace: dana dalam custody gateway'
        ),
        (
            '2200',
            'Kewajiban kepada Merchant',
            'Koreksi historis marketplace: kewajiban merchant'
        )
    ) AS x(
        account_code,
        account_name,
        description
    )
    WHERE o.market_order_id IS NOT NULL
      AND p.provider = 'MIDTRANS'
      AND p.payment_status = 'PAID'
      AND p.payment_method IN (
          'QRIS',
          'VIRTUAL_ACCOUNT'
      )
      AND p.amount = o.total_amount
      AND e.status = 'PENDING'
      AND e.merchant_entitlement = o.total_amount
      AND e.platform_commission = 0
      AND (
          SELECT COUNT(*)
          FROM tbl_payments px
          WHERE px.order_id = o.id
            AND px.payment_status = 'PAID'
      ) = 1;
END
$$;

COMMIT;
