BEGIN;

INSERT INTO tbl_product_categories (name,parent_id)
SELECT v.name,NULL
FROM (VALUES
 ('Sembako & Bahan Pokok'),
 ('Sayur & Buah'),
 ('Daging, Ikan & Protein'),
 ('Bumbu & Bahan Masak'),
 ('Minuman')
) AS v(name)
WHERE NOT EXISTS (
 SELECT 1 FROM tbl_product_categories c
 WHERE LOWER(c.name)=LOWER(v.name)
);

INSERT INTO tbl_product_categories (name,parent_id)
SELECT v.name, r.id
FROM (VALUES
 ('Beras'),
 ('Minyak Goreng'),
 ('Gula'),
 ('Tepung'),
 ('Telur')
) AS v(name)
JOIN tbl_product_categories r
  ON LOWER(r.name)=LOWER('Sembako & Bahan Pokok')
WHERE NOT EXISTS (
 SELECT 1
 FROM tbl_product_categories c
 WHERE LOWER(c.name)=LOWER(v.name)
);

UPDATE tbl_product_categories c
SET parent_id = r.id
FROM tbl_product_categories r
WHERE c.id = 2
  AND LOWER(c.name)=LOWER('Mie Instan')
  AND LOWER(r.name)=LOWER('Sembako & Bahan Pokok');

INSERT INTO tbl_product_categories (name,parent_id)
SELECT v.name, r.id
FROM (VALUES
 ('Sayuran Daun'),
 ('Sayuran Buah'),
 ('Umbi & Akar'),
 ('Buah')
) AS v(name)
JOIN tbl_product_categories r
  ON LOWER(r.name)=LOWER('Sayur & Buah')
WHERE NOT EXISTS (
 SELECT 1
 FROM tbl_product_categories c
 WHERE LOWER(c.name)=LOWER(v.name)
);

INSERT INTO tbl_product_categories (name,parent_id)
SELECT v.name, r.id
FROM (VALUES
 ('Ayam'),
 ('Daging'),
 ('Ikan & Seafood'),
 ('Tahu & Tempe')
) AS v(name)
JOIN tbl_product_categories r
  ON LOWER(r.name)=LOWER('Daging, Ikan & Protein')
WHERE NOT EXISTS (
 SELECT 1
 FROM tbl_product_categories c
 WHERE LOWER(c.name)=LOWER(v.name)
);

INSERT INTO tbl_product_categories (name,parent_id)
SELECT v.name, r.id
FROM (VALUES
 ('Bawang'),
 ('Cabai'),
 ('Bumbu & Rempah'),
 ('Saus & Kecap')
) AS v(name)
JOIN tbl_product_categories r
  ON LOWER(r.name)=LOWER('Bumbu & Bahan Masak')
WHERE NOT EXISTS (
 SELECT 1
 FROM tbl_product_categories c
 WHERE LOWER(c.name)=LOWER(v.name)
);

INSERT INTO tbl_product_categories (name,parent_id)
SELECT v.name, r.id
FROM (VALUES
 ('Air Minum'),
 ('Teh & Kopi'),
 ('Susu'),
 ('Minuman Lain')
) AS v(name)
JOIN tbl_product_categories r
  ON LOWER(r.name)=LOWER('Minuman')
WHERE NOT EXISTS (
 SELECT 1
 FROM tbl_product_categories c
 WHERE LOWER(c.name)=LOWER(v.name)
);

DO $$
DECLARE
  root_count integer;
  leaf_count integer;
BEGIN
  SELECT COUNT(*) INTO root_count
  FROM tbl_product_categories
  WHERE parent_id IS NULL
    AND name IN (
      'Sembako & Bahan Pokok',
      'Sayur & Buah',
      'Daging, Ikan & Protein',
      'Bumbu & Bahan Masak',
      'Minuman'
    );

  IF root_count <> 5 THEN
    RAISE EXCEPTION 'B4-D validation failed: expected 5 roots, got %', root_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM tbl_product_categories c
    JOIN tbl_product_categories r
      ON r.id = c.parent_id
    WHERE c.id = 2
      AND c.name = 'Mie Instan'
      AND r.name = 'Sembako & Bahan Pokok'
  ) THEN
    RAISE EXCEPTION 'B4-D validation failed: Mie Instan id 2 parent incorrect';
  END IF;

  SELECT COUNT(*) INTO leaf_count
  FROM tbl_product_categories
  WHERE parent_id IS NOT NULL;

  IF leaf_count <> 22 THEN
    RAISE EXCEPTION 'B4-D validation failed: expected 22 leaves, got %', leaf_count;
  END IF;
END
$$;

COMMIT;
