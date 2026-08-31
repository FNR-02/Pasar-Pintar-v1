BEGIN;

-- =========================================================
-- PARENT CATEGORIES
-- =========================================================

INSERT INTO tbl_product_categories (name, parent_id)
SELECT v.name, NULL
FROM (
    VALUES
        ('Plastik & Kemasan'),
        ('Bahan Kue & Baking')
) AS v(name)
WHERE NOT EXISTS (
    SELECT 1
    FROM tbl_product_categories c
    WHERE c.name = v.name
      AND c.parent_id IS NULL
);

-- =========================================================
-- PLASTIK & KEMASAN
-- =========================================================

INSERT INTO tbl_product_categories (name, parent_id)
SELECT
    v.name,
    p.id
FROM (
    VALUES
        ('Plastik Kresek'),
        ('Plastik Bening / PP / PE'),
        ('Plastik Klip / Ziplock'),
        ('Plastik Sampah'),
        ('Cup Plastik'),
        ('Gelas & Tutup Cup'),
        ('Sedotan'),
        ('Mika / Food Container'),
        ('Thinwall / Kotak Makan'),
        ('Styrofoam'),
        ('Paper Bowl / Paper Cup'),
        ('Dus / Box Makanan'),
        ('Kertas Nasi / Kertas Bungkus'),
        ('Aluminium Foil'),
        ('Cling Wrap / Plastik Wrap'),
        ('Sendok / Garpu Sekali Pakai'),
        ('Tusuk Sate / Tusuk Makanan'),
        ('Karet Gelang'),
        ('Lakban / Isolasi'),
        ('Plastik & Kemasan Lainnya')
) AS v(name)
JOIN tbl_product_categories p
  ON p.name = 'Plastik & Kemasan'
 AND p.parent_id IS NULL
WHERE NOT EXISTS (
    SELECT 1
    FROM tbl_product_categories c
    WHERE c.name = v.name
      AND c.parent_id = p.id
);

-- =========================================================
-- BAHAN KUE & BAKING
-- =========================================================

INSERT INTO tbl_product_categories (name, parent_id)
SELECT
    v.name,
    p.id
FROM (
    VALUES
        ('Tepung Terigu'),
        ('Tepung Maizena'),
        ('Tepung Tapioka'),
        ('Tepung Beras'),
        ('Gula Halus / Gula Pasir'),
        ('Margarin / Mentega'),
        ('Cokelat / Cokelat Bubuk'),
        ('Keju'),
        ('Susu Bubuk / Susu Kental'),
        ('Santan'),
        ('Ragi'),
        ('Baking Powder'),
        ('Baking Soda'),
        ('Vanili'),
        ('Ovalet / SP / TBM'),
        ('Pewarna Makanan'),
        ('Perisa / Essence'),
        ('Selai / Filling'),
        ('Meses / Sprinkles'),
        ('Kacang / Topping'),
        ('Whipping Cream'),
        ('Agar-agar / Jelly'),
        ('Tepung Premix'),
        ('Bahan Kue Lainnya')
) AS v(name)
JOIN tbl_product_categories p
  ON p.name = 'Bahan Kue & Baking'
 AND p.parent_id IS NULL
WHERE NOT EXISTS (
    SELECT 1
    FROM tbl_product_categories c
    WHERE c.name = v.name
      AND c.parent_id = p.id
);

-- =========================================================
-- MINUMAN
-- =========================================================

INSERT INTO tbl_product_categories (name, parent_id)
SELECT
    v.name,
    p.id
FROM (
    VALUES
        ('Minuman Serbuk / Sachet'),
        ('Sirup & Konsentrat'),
        ('Minuman Botol & Kaleng'),
        ('Minuman Isotonik & Energi')
) AS v(name)
JOIN tbl_product_categories p
  ON p.name = 'Minuman'
 AND p.parent_id IS NULL
WHERE NOT EXISTS (
    SELECT 1
    FROM tbl_product_categories c
    WHERE c.name = v.name
      AND c.parent_id = p.id
);

-- Rapikan nama Minuman Lain -> Minuman Lainnya,
-- hanya jika nama tujuan belum ada pada parent yang sama.
UPDATE tbl_product_categories c
SET name = 'Minuman Lainnya'
FROM tbl_product_categories p
WHERE c.parent_id = p.id
  AND p.name = 'Minuman'
  AND p.parent_id IS NULL
  AND c.name = 'Minuman Lain'
  AND NOT EXISTS (
      SELECT 1
      FROM tbl_product_categories x
      WHERE x.parent_id = p.id
        AND x.name = 'Minuman Lainnya'
  );

COMMIT;
