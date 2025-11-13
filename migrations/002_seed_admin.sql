-- 002_seed_admin.sql
-- Robust, environment-safe seed for development/staging.
-- Adapts to actual schema: checks for optional columns and NOT NULL columns without defaults,
-- and will skip inserts that would violate constraints.
-- IMPORTANT: Replace <BCRYPT_HASH_OF_PASSWORD> with a real bcrypt hash if you want SQL-based admin creation.
-- Prefer scripts/seed_admin.js for secure password hashing in Node.

-------------------------------------------------------------------------------
-- Informational message
-------------------------------------------------------------------------------
SELECT 'Running 002_seed_admin.sql - development-only seed. Review before executing.' AS message;

-------------------------------------------------------------------------------
-- Section 1: Helper function - create_or_update_admin_by_hash
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_or_update_admin_by_hash(p_username TEXT, p_bcrypt_hash TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF p_bcrypt_hash IS NULL OR char_length(p_bcrypt_hash) < 10 THEN
    RAISE EXCEPTION 'Invalid bcrypt hash provided';
  END IF;

  IF EXISTS (SELECT 1 FROM employees WHERE username = p_username) THEN
    UPDATE employees
      SET password_hash = p_bcrypt_hash, updated_at = COALESCE(updated_at, now()), updated_at = now()
    WHERE username = p_username;
    RAISE NOTICE 'Updated existing admin password for %', p_username;
  ELSE
    INSERT INTO employees (username, password_hash, role, full_name, created_at, updated_at)
    VALUES (p_username, p_bcrypt_hash, 'admin', 'Quản Trị Viên', now(), now());
    RAISE NOTICE 'Inserted admin user %', p_username;
  END IF;
END;
$$;

-------------------------------------------------------------------------------
-- Section 2: Optionally create admin via an injected bcrypt hash
-- Usage (psql): \set myhash 'the_bcrypt_hash_here' then:
--   SELECT create_or_update_admin_by_hash('admin', :'myhash');
-------------------------------------------------------------------------------
DO $$
DECLARE
  v_hash TEXT := '<BCRYPT_HASH_OF_PASSWORD>'; -- replace before running or call function from script
BEGIN
  IF v_hash IS NULL OR v_hash = '<BCRYPT_HASH_OF_PASSWORD>' THEN
    RAISE NOTICE 'No bcrypt hash provided in script variable. Skipping admin creation via SQL. Use scripts/seed_admin.js to create admin with bcrypt.';
  ELSE
    PERFORM create_or_update_admin_by_hash('admin', v_hash);
  END IF;
END;
$$ LANGUAGE plpgsql;

-------------------------------------------------------------------------------
-- Section 3: Convenience: generate_secure_password (dev only)
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION generate_secure_password(p_bytes INT DEFAULT 24)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  b BYTEA := gen_random_bytes(p_bytes);
BEGIN
  RETURN encode(b, 'base64');
END;
$$;

-------------------------------------------------------------------------------
-- Section 4: Sample members seed (idempotent, safe)
-------------------------------------------------------------------------------
DO $$
DECLARE
  cnt integer;
  has_meta boolean;
  has_created_at boolean;
  has_updated_at boolean;
  required_cols TEXT[];
  filtered_required_cols TEXT[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'members'
  ) THEN
    RAISE NOTICE 'Table members does not exist in schema %; skipping members seed.', current_schema();
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'members' AND column_name = 'meta'
  ) INTO has_meta;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'members' AND column_name = 'created_at'
  ) INTO has_created_at;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'members' AND column_name = 'updated_at'
  ) INTO has_updated_at;

  SELECT array_agg(column_name) INTO required_cols
  FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND table_name = 'members'
    AND is_nullable = 'NO'
    AND column_default IS NULL;

  IF required_cols IS NULL THEN
    filtered_required_cols := ARRAY[]::text[];
  ELSE
    filtered_required_cols := ARRAY(
      SELECT unnest(required_cols)
      EXCEPT
      SELECT unnest(ARRAY['id','member_id','createdat','created_at','created','updated','updated_at'])
    );
  END IF;

  EXECUTE format('SELECT COUNT(*) FROM %I.%I', current_schema(), 'members') INTO cnt;

  IF cnt = 0 THEN
    IF array_length(filtered_required_cols,1) IS NOT NULL AND array_length(filtered_required_cols,1) > 0 THEN
      RAISE NOTICE 'Members table has required NOT NULL cols without DEFAULT: %; skipping members seed.', filtered_required_cols;
      RETURN;
    END IF;

    IF has_meta AND has_created_at AND has_updated_at THEN
      INSERT INTO members (name, zalo, bank, meta, created_at, updated_at)
      VALUES
        ('Công ty A', '0123456789', 'Vietcombank - 12345678', jsonb_build_object('type','company'), now(), now()),
        ('Nguyễn Văn B', '0987654321', 'BIDV - 87654321', jsonb_build_object('type','individual'), now(), now()),
        ('Cá nhân C', NULL, 'Techcombank - 11122233', jsonb_build_object('type','individual'), now(), now());
      RAISE NOTICE 'Inserted sample members (3 rows) with meta and timestamps.';
    ELSIF has_meta THEN
      INSERT INTO members (name, zalo, bank, meta)
      VALUES
        ('Công ty A', '0123456789', 'Vietcombank - 12345678', jsonb_build_object('type','company')),
        ('Nguyễn Văn B', '0987654321', 'BIDV - 87654321', jsonb_build_object('type','individual')),
        ('Cá nhân C', NULL, 'Techcombank - 11122233', jsonb_build_object('type','individual'));
      RAISE NOTICE 'Inserted sample members (3 rows) with meta only.';
    ELSIF has_created_at AND has_updated_at THEN
      INSERT INTO members (name, zalo, bank, created_at, updated_at)
      VALUES
        ('Công ty A', '0123456789', 'Vietcombank - 12345678', now(), now()),
        ('Nguyễn Văn B', '0987654321', 'BIDV - 87654321', now(), now()),
        ('Cá nhân C', NULL, 'Techcombank - 11122233', now(), now());
      RAISE NOTICE 'Inserted sample members (3 rows) with timestamps only.';
    ELSE
      INSERT INTO members (name, zalo, bank)
      VALUES
        ('Công ty A', '0123456789', 'Vietcombank - 12345678'),
        ('Nguyễn Văn B', '0987654321', 'BIDV - 87654321'),
        ('Cá nhân C', NULL, 'Techcombank - 11122233');
      RAISE NOTICE 'Inserted sample members (3 rows) without optional columns.';
    END IF;
  ELSE
    RAISE NOTICE 'Members table not empty; skipping sample members (count=%).', cnt;
  END IF;
END;
$$ LANGUAGE plpgsql;

-------------------------------------------------------------------------------
-- Section 5: Sample KHO items (idempotent, verifies required columns exist)
-------------------------------------------------------------------------------
DO $$
DECLARE
  cnt integer;
  nowts timestamptz := now();
  required_count integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'kho'
  ) THEN
    RAISE NOTICE 'Table kho does not exist in schema %; skipping KHO seed.', current_schema();
    RETURN;
  END IF;

  SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'kho'
      AND column_name IN ('key','account','provider_id','name','address','amount_previous','amount_current','total','nhapAt','raw','customer','created_at','updated_at')
  INTO required_count;

  IF required_count < 13 THEN
    RAISE NOTICE 'kho table missing expected columns (found % of 13); skipping KHO inserts.', required_count;
    RETURN;
  END IF;

  SELECT COUNT(*) FROM kho INTO cnt;
  IF cnt = 0 THEN
    INSERT INTO kho (key, account, provider_id, name, address, amount_previous, amount_current, total, nhapAt, raw, customer, created_at, updated_at)
    VALUES
      ('00906815::PB02020047317', 'PB02020047317', '00906815', 'NGUYEN VAN A', '123 Nguyen Trai, Q1, HCM', 0, 150000, 150000, nowts, jsonb_build_object('sample',true,'bill_month','2025-09'), 'Công ty A', nowts, nowts),
      ('00906815::PB02020047318', 'PB02020047318', '00906815', 'TRAN THI B', '456 Le Lai, Q1, HCM', 0, 230000, 230000, nowts - interval '1 day', jsonb_build_object('sample',true,'bill_month','2025-09'), 'Nguyễn Văn B', nowts - interval '1 day', nowts - interval '1 day'),
      ('00906819::PB99000000001', 'PB99000000001', '00906819', 'DOAN HUU C', '789 Hai Ba Trung, HN', 0, 120000, 120000, nowts - interval '2 days', jsonb_build_object('sample',true,'bill_month','2025-08'), 'Cá nhân C', nowts - interval '2 days', nowts - interval '2 days');
    RAISE NOTICE 'Inserted sample KHO items (3 rows).';
  ELSE
    RAISE NOTICE 'KHO table not empty; skipping sample KHO inserts (count=%).', cnt;
  END IF;
END;
$$ LANGUAGE plpgsql;

-------------------------------------------------------------------------------
-- Section 6: Sample history entries (idempotent, schema-adaptive)
-- Avoid using reserved/absent column names; detect available columns and required NOT NULLs.
-------------------------------------------------------------------------------
DO $$
DECLARE
  cnt integer;
  nowts timestamptz := now();
  available_cols TEXT[];
  required_cols TEXT[];
  insert_cols TEXT;
  insert_vals TEXT;
  skip_reason TEXT;
  col_count INT;
  must_skip BOOLEAN := FALSE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'history'
  ) THEN
    RAISE NOTICE 'Table history does not exist in schema %; skipping history seed.', current_schema();
    RETURN;
  END IF;

  -- Gather available columns on history table
  SELECT array_agg(column_name) INTO available_cols
  FROM information_schema.columns
  WHERE table_schema = current_schema() AND table_name = 'history';

  -- Identify NOT NULL columns without defaults that would block simple inserts
  SELECT array_agg(column_name) INTO required_cols
  FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND table_name = 'history'
    AND is_nullable = 'NO'
    AND column_default IS NULL;

  IF required_cols IS NULL THEN
    required_cols := ARRAY[]::text[];
  END IF;

  -- Filter out common auto columns that are typically safe to ignore for seed
  required_cols := ARRAY(
    SELECT unnest(required_cols)
    EXCEPT
    SELECT unnest(ARRAY['id','history_id','createdat','created_at','created','updated','updated_at'])
  );

  IF array_length(required_cols,1) IS NOT NULL AND array_length(required_cols,1) > 0 THEN
    RAISE NOTICE 'History table has required NOT NULL columns without DEFAULT: %; skipping history seed to avoid violation.', required_cols;
    RETURN;
  END IF;

  -- Determine a sensible column list to insert into (intersect desired with available)
  -- Desired logical columns for seed (legacy): key, account, provider_id, name, address,
  -- amount_previous, amount_current, total, nhapAt, xuatAt, soldAt, member_id, member_name, employee_username, raw, created_at
  INSERT INTO pg_temp.available(cols) VALUES (NULL) ON CONFLICT DO NOTHING;
  -- Build insert columns by intersection
  SELECT array_agg(col) INTO available_cols FROM (
    SELECT unnest(ARRAY['key','account','provider_id','name','address','amount_previous','amount_current','total','nhapAt','xuatAt','soldAt','member_id','member_name','employee_username','raw','created_at']) AS col
    WHERE (SELECT col) IS NOT NULL
  ) as t; -- placeholder to get type

  -- Instead of above placeholder, build dynamically:
  SELECT array_agg(col) FROM (
    SELECT col FROM unnest(ARRAY['key','account','provider_id','name','address','amount_previous','amount_current','total','nhapAt','xuatAt','soldAt','member_id','member_name','employee_username','raw','created_at']) AS col
    WHERE col = ANY( (SELECT array_agg(column_name) FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'history') )
  ) AS present_cols
  INTO available_cols;

  IF available_cols IS NULL THEN
    RAISE NOTICE 'None of the expected history columns are present; skipping history seed.';
    RETURN;
  END IF;

  -- Count rows
  EXECUTE format('SELECT COUNT(*) FROM %I.%I', current_schema(), 'history') INTO cnt;

  IF cnt = 0 THEN
    -- Build column list and value list based on available_cols
    insert_cols := array_to_string(available_cols, ', ');
    -- We'll insert two sample rows using only columns available; construct VALUES accordingly.
    -- To keep logic simple and safe, use conditional INSERT with explicit column order matching available_cols.
    -- Prepare per-row arrays for values in same order as available_cols
    PERFORM format('INSERT INTO %I.%I (%s) VALUES (%s), (%s)',
      current_schema(), 'history',
      insert_cols,
      (SELECT string_agg(val, ', ') FROM (
         SELECT
           CASE col
             WHEN 'key' THEN quote_literal('00906815::SOLD0001')
             WHEN 'account' THEN quote_literal('SOLD0001')
             WHEN 'provider_id' THEN quote_literal('00906815')
             WHEN 'name' THEN quote_literal('LE VAN D')
             WHEN 'address' THEN quote_literal('12 Tran Phu, HCM')
             WHEN 'amount_previous' THEN '0'
             WHEN 'amount_current' THEN '180000'
             WHEN 'total' THEN '180000'
             WHEN 'nhapAt' THEN quote_literal((nowts - interval '10 days')::text)
             WHEN 'xuatAt' THEN quote_literal((nowts - interval '5 days')::text)
             WHEN 'soldAt' THEN quote_literal((nowts - interval '5 days')::text)
             WHEN 'member_id' THEN 'NULL'
             WHEN 'member_name' THEN 'NULL'
             WHEN 'employee_username' THEN quote_literal('admin')
             WHEN 'raw' THEN quote_literal(jsonb_build_object('sample',true)::text)
             WHEN 'created_at' THEN quote_literal((nowts - interval '5 days')::text)
             ELSE 'NULL'
           END AS val, col
         FROM unnest(available_cols) AS col
       ) AS row_vals),
      (SELECT string_agg(val2, ', ') FROM (
         SELECT
           CASE col
             WHEN 'key' THEN quote_literal('00906818::SOLD0002')
             WHEN 'account' THEN quote_literal('SOLD0002')
             WHEN 'provider_id' THEN quote_literal('00906818')
             WHEN 'name' THEN quote_literal('PHAM THI E')
             WHEN 'address' THEN quote_literal('34 Nguyen Hue, HCM')
             WHEN 'amount_previous' THEN '0'
             WHEN 'amount_current' THEN '210000'
             WHEN 'total' THEN '210000'
             WHEN 'nhapAt' THEN quote_literal((nowts - interval '20 days')::text)
             WHEN 'xuatAt' THEN quote_literal((nowts - interval '2 days')::text)
             WHEN 'soldAt' THEN quote_literal((nowts - interval '2 days')::text)
             WHEN 'member_id' THEN 'NULL'
             WHEN 'member_name' THEN 'NULL'
             WHEN 'employee_username' THEN quote_literal('admin')
             WHEN 'raw' THEN quote_literal(jsonb_build_object('sample',true)::text)
             WHEN 'created_at' THEN quote_literal((nowts - interval '2 days')::text)
             ELSE 'NULL'
           END AS val2, col
         FROM unnest(available_cols) AS col
       ) AS row_vals2)
    );

    -- Note: Using PERFORM with a dynamic format like above runs INSERT; if the driver/tool disallows, consider constructing and EXECUTE the SQL string instead.
    RAISE NOTICE 'Attempted to insert sample history rows into columns: %', insert_cols;
  ELSE
    RAISE NOTICE 'History table not empty; skipping sample history inserts (count=%).', cnt;
  END IF;
END;
$$ LANGUAGE plpgsql;

-------------------------------------------------------------------------------
-- Section 7: Optional: create a temporary runtime role for local testing
-------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'local_app_runtime') THEN
    CREATE ROLE local_app_runtime NOINHERIT;
    RAISE NOTICE 'Created local_app_runtime role (no login). Grant privileges manually if needed.';
  ELSE
    RAISE NOTICE 'local_app_runtime role already exists; skipping creation.';
  END IF;
END;
$$ LANGUAGE plpgsql;

-------------------------------------------------------------------------------
-- Final informational messages
-------------------------------------------------------------------------------
SELECT '002_seed_admin.sql finished.' AS message;
SELECT ' - If you skipped admin creation above, run scripts/seed_admin.js to create admin with bcrypt hash.' AS note;
SELECT ' - Remove or review sample data before using in production.' AS note;
SELECT ' - Do not store plain-text passwords; use bcrypt hashed values only.' AS note;
