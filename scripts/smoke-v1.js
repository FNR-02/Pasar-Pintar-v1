const pool = require('../src/config/db');

const BASE_URL =
  process.env.BASE_URL ||
  'http://127.0.0.1:3000';

const E2E_ORDER_ID =
  '52f13ead-f4e0-4c8a-89c7-f66d23020233';

let passed = 0;
let failed = 0;

function pass(name) {
  passed++;
  console.log(`PASS  ${name}`);
}

function fail(name, detail) {
  failed++;
  console.error(`FAIL  ${name}`);
  if (detail) {
    console.error(`      ${detail}`);
  }
}

async function checkHealth() {
  try {
    const res = await fetch(
      `${BASE_URL}/api/health`
    );

    const data = await res.json();

    if (
      res.ok &&
      data.status === 'success' &&
      data.kernel === 'online'
    ) {
      pass('API health + kernel online');
    } else {
      fail(
        'API health + kernel online',
        JSON.stringify(data)
      );
    }
  } catch (err) {
    fail('API health + kernel online', err.message);
  }
}

async function checkDatabase() {
  try {
    const r = await pool.query(
      'SELECT 1 AS ok'
    );

    if (Number(r.rows[0].ok) === 1) {
      pass('PostgreSQL connection');
    } else {
      fail('PostgreSQL connection');
    }
  } catch (err) {
    fail('PostgreSQL connection', err.message);
  }
}

async function checkIndexes() {
  const required = [
    'tbl_payments_one_paid_per_order',
    'uq_ledger_reference_account',
    'tbl_shipments_one_per_order',
    'tbl_inventory_movements_sale_unique'
  ];

  try {
    const r = await pool.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname='public'
        AND indexname = ANY($1::text[])
    `, [required]);

    const found =
      new Set(r.rows.map(x => x.indexname));

    for (const name of required) {
      if (found.has(name)) {
        pass(`DB index ${name}`);
      } else {
        fail(`DB index ${name}`, 'MISSING');
      }
    }
  } catch (err) {
    fail('Database indexes', err.message);
  }
}

async function checkDuplicates() {
  const checks = [
    {
      name: 'No duplicate shipment/order',
      sql: `
        SELECT order_id
        FROM tbl_shipments
        GROUP BY order_id
        HAVING COUNT(*) > 1
        LIMIT 1
      `
    },
    {
      name: 'No duplicate PAID payment/order',
      sql: `
        SELECT order_id
        FROM tbl_payments
        WHERE payment_status='PAID'
        GROUP BY order_id
        HAVING COUNT(*) > 1
        LIMIT 1
      `
    },
    {
      name: 'No duplicate SALE movement',
      sql: `
        SELECT
          reference_doc,
          product_id
        FROM tbl_inventory_movements
        WHERE movement_type='SALE'
        GROUP BY
          reference_doc,
          product_id,
          movement_type
        HAVING COUNT(*) > 1
        LIMIT 1
      `
    },
    {
      name: 'No duplicate ledger account/reference',
      sql: `
        SELECT
          transaction_reference,
          account_code
        FROM tbl_general_ledger
        GROUP BY
          transaction_reference,
          account_code
        HAVING COUNT(*) > 1
        LIMIT 1
      `
    }
  ];

  for (const check of checks) {
    try {
      const r = await pool.query(check.sql);

      if (r.rowCount === 0) {
        pass(check.name);
      } else {
        fail(
          check.name,
          JSON.stringify(r.rows[0])
        );
      }
    } catch (err) {
      fail(check.name, err.message);
    }
  }
}

async function checkE2EInvariant() {
  try {
    const r = await pool.query(`
      SELECT
        o.status AS order_status,

        (
          SELECT COUNT(*)::int
          FROM tbl_payments p
          WHERE p.order_id=o.id
            AND p.payment_status='PAID'
        ) AS paid_payments,

        (
          SELECT COUNT(*)::int
          FROM tbl_shipments s
          WHERE s.order_id=o.id
        ) AS shipments,

        (
          SELECT COUNT(*)::int
          FROM tbl_general_ledger gl
          WHERE gl.transaction_reference =
            'ORD-' || o.id::text
        ) AS ledger_entries,

        (
          SELECT COUNT(*)::int
          FROM tbl_inventory_movements im
          WHERE im.reference_doc =
            'ORD-' || o.id::text
            AND im.movement_type='SALE'
        ) AS sale_movements

      FROM tbl_orders_v2 o
      WHERE o.id=$1
    `, [E2E_ORDER_ID]);

    if (!r.rowCount) {
      fail(
        'E2E reference order',
        'Order tidak ditemukan'
      );
      return;
    }

    const x = r.rows[0];

    if (
      x.order_status === 'DELIVERED' &&
      Number(x.paid_payments) === 1 &&
      Number(x.shipments) === 1 &&
      Number(x.ledger_entries) === 2 &&
      Number(x.sale_movements) === 1
    ) {
      pass('E2E transaction invariant');
    } else {
      fail(
        'E2E transaction invariant',
        JSON.stringify(x)
      );
    }
  } catch (err) {
    fail(
      'E2E transaction invariant',
      err.message
    );
  }
}

async function main() {
  console.log(
    '===== PASAR PINTAR V1 SMOKE TEST ====='
  );

  await checkHealth();
  await checkDatabase();
  await checkIndexes();
  await checkDuplicates();
  await checkE2EInvariant();

  console.log();
  console.log('===== RESULT =====');
  console.log(`PASS: ${passed}`);
  console.log(`FAIL: ${failed}`);

  if (failed > 0) {
    process.exitCode = 1;
  } else {
    console.log('STATUS: HEALTHY');
  }
}

main()
  .catch(err => {
    console.error(
      'SMOKE TEST ERROR:',
      err.message
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
