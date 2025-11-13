-- 002_seed_admin.sql
-- Resilient development seed for "Tra cứu & Bán Bill"
-- Matches schema defined in 001_create_tables.sql.
-- Safe to run multiple times: checks table existence, required NOT NULL columns without defaults,
-- and inserts only when safe. Does not alter schema.
-- IMPORTANT: Replace <BCRYPT_HASH_OF_PASSWORD> with a real bcrypt hash only for controlled dev use.
-- Prefer scripts/seed_admin.js for secure password hashing and parameterized DB access.

-------------------------
-- Informational message
-------------------------
SELECT 'Running 002_seed_admin.sql - development-only seed. Review before executing.' AS message;

-------------------------------------------------------------------------------
-- Section 1: Helper — create_or_update_admin_by_hash
-- Expects a bcrypt hash; does not generate bcrypt here.
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_or_update_admin_by_hash(p_username TEXT, p_bcrypt_hash TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF p_bcrypt_hash IS NULL OR char_length(p_bcrypt_hash) < 10 THEN
    RAISE EXCEPTION 'Invalid bcrypt hash provided';
  END IF;

  IF EXISTS (SELECT 1 FROM employees WHERE username = p_username) THEN
    UPDATE employees
      SET password_hash = p_bcrypt_hash, updated_at = COALESCE(updated_at, now())
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
-- Section 2: Optionally create admin via injected bcrypt hash
-- Usage (psql): \set myhash 'the_bcrypt_hash_here' then:
--   SELECT create_or_update_admin_by_hash('admin', :'myhash');
-------------------------------------------------------------------------------
DO $$
DECLARE
  v_hash TEXT := '<BCRYPT_HASH_OF_PASSWORD>'; -- replace before running if you want SQL-based admin creation
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
-- Section 4: Seed members (idempotent; matches members table in 001_create_tables.sql)
-- members columns per migration: id, name, email, zalo, bank, meta, created_at, updated_at
-------------------------------------------------------------------------------
DO $$
DECLARE
  cnt integer;
  required_cols TEXT[];
  filtered_required_cols TEXT[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'members'
  ) THEN
    RAISE NOTICE 'Table members not present; skipping members seed.';
    RETURN;
  END IF;

  -- Find NOT NULL columns without defaults
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

  IF array_length(filtered_required_cols,1) IS NOT NULL AND array_length(filtered_required_cols,1) > 0 THEN
    RAISE NOTICE 'Members table has required NOT NULL columns without defaults: %; skipping members seed.', filtered_required_cols;
    RETURN;
  END IF;

  EXECUTE format('SELECT COUNT(*) FROM %I.%I', current_schema(), 'members') INTO cnt;
  IF cnt > 0 THEN
    RAISE NOTICE 'Members table not empty (count=%); skipping members seed.', cnt;
    RETURN;
  END IF;

  INSERT INTO members (name, email, zalo, bank, meta, created_at, updated_at)
  VALUES
    ('Công ty A', NULL, '0123456789', 'Vietcombank - 12345678', jsonb_build_object('type','company'), now(), now()),
    ('Nguyễn Văn B', NULL, '0987654321', 'BIDV - 87654321', jsonb_build_object('type','individual'), now(), now()),
    ('Cá nhân C', NULL, NULL, 'Techcombank - 11122233', jsonb_build_object('type','individual'), now(), now());

  RAISE NOTICE 'Inserted sample members (3 rows).';
END;
$$ LANGUAGE plpgsql;

-------------------------------------------------------------------------------
-- Section 5: Seed kho (idempotent; matches kho table in 001_create_tables.sql)
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
    RAISE NOTICE 'Table kho not present; skipping kho seed.';
    RETURN;
  END IF;

  SELECT COUNT(*) INTO required_count
  FROM information_schema.columns
  WHERE table_schema = current_schema() AND table_name = 'kho'
    AND column_name IN ('key','account','provider_id','name','address','amount_previous','amount_current','total','nhapAt','raw','customer','created_at','updated_at');

  IF required_count < 13 THEN
    RAISE NOTICE 'kho table missing expected columns (found % of 13); skipping KHO inserts.', required_count;
    RETURN;
  END IF;

  EXECUTE format('SELECT COUNT(*) FROM %I.%I', current_schema(), 'kho') INTO cnt;
  IF cnt > 0 THEN
    RAISE NOTICE 'KHO table not empty (count=%); skipping KHO seed.', cnt;
    RETURN;
  END IF;

  INSERT INTO kho (key, account, provider_id, provider_code, name, address, amount_previous, amount_current, total, currency, nhapAt, customer, raw, created_at, updated_at)
  VALUES
    ('00906815::PB02020047317','PB02020047317','00906815','PB02020047317','NGUYEN VAN A','123 Nguyen Trai, Q1, HCM',0,150000,150000,'VND', nowts, 'Công ty A', jsonb_build_object('sample',true,'bill_month','2025-09'), nowts, nowts),
    ('00906815::PB02020047318','PB02020047318','00906815','PB02020047318','TRAN THI B','456 Le Lai, Q1, HCM',0,230000,230000,'VND', nowts - interval '1 day', 'Nguyễn Văn B', jsonb_build_object('sample',true,'bill_month','2025-09'), nowts - interval '1 day', nowts - interval '1 day'),
    ('00906819::PB99000000001','PB99000000001','00906819','PB99000000001','DOAN HUU C','789 Hai Ba Trung, HN',0,120000,120000,'VND', nowts - interval '2 days', 'Cá nhân C', jsonb_build_object('sample',true,'bill_month','2025-08'), nowts - interval '2 days', nowts - interval '2 days');

  RAISE NOTICE 'Inserted sample KHO items (3 rows).';
END;
$$ LANGUAGE plpgsql;

-------------------------------------------------------------------------------
-- Section 6: Seed history (idempotent; matches history table in 001_create_tables.sql)
-------------------------------------------------------------------------------
DO $$
DECLARE
  cnt integer;
  nowts timestamptz := now();
  required_cols TEXT[];
  filtered_required_cols TEXT[];
  admin_emp_id BIGINT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'history'
  ) THEN
    RAISE NOTICE 'Table history not present; skipping history seed.';
    RETURN;
  END IF;

  SELECT array_agg(column_name) INTO required_cols
  FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND table_name = 'history'
    AND is_nullable = 'NO'
    AND column_default IS NULL;

  IF required_cols IS NULL THEN
    filtered_required_cols := ARRAY[]::text[];
  ELSE
    filtered_required_cols := ARRAY(
      SELECT unnest(required_cols)
      EXCEPT
      SELECT unnest(ARRAY['id','history_id','createdat','created_at','created','updated','updated_at'])
    );
  END IF;

  IF array_length(filtered_required_cols,1) IS NOT NULL AND array_length(filtered_required_cols,1) > 0 THEN
    RAISE NOTICE 'History table has required NOT NULL columns without defaults: %; skipping history seed.', filtered_required_cols;
    RETURN;
  END IF;

  EXECUTE format('SELECT COUNT(*) FROM %I.%I', current_schema(), 'history') INTO cnt;
  IF cnt > 0 THEN
    RAISE NOTICE 'History table not empty (count=%); skipping history seed.', cnt;
    RETURN;
  END IF;

  -- Try to find admin employee id for employee_id references; may be NULL
  SELECT id INTO admin_emp_id FROM employees WHERE username = 'admin' LIMIT 1;

  INSERT INTO history
    (key, account, provider_id, name, address, amount_previous, amount_current, total, currency, nhapAt, xuatAt, soldAt, member_id, member_name, employee_id, employee_username, fee, note, raw, created_at)
  VALUES
    (
      '00906815::SOLD0001',
      'SOLD0001',
      '00906815',
      'LE VAN D',
      '12 Tran Phu, HCM',
      0,
      180000,
      180000,
      'VND',
      nowts - interval '10 days',
      nowts - interval '5 days',
      nowts - interval '5 days',
      (SELECT id FROM members WHERE name = 'Công ty A' LIMIT 1),
      'Công ty A',
      admin_emp_id,
      'admin',
      0,
      'Sample sold 1',
      jsonb_build_object('sample', true),
      nowts - interval '5 days'
    ),
    (
      '00906818::SOLD0002',
      'SOLD0002',
      '00906818',
      'PHAM THI E',
      '34 Nguyen Hue, HCM',
      0,
      210000,
      210000,
      'VND',
      nowts - interval '20 days',
      nowts - interval '2 days',
      nowts - interval '2 days',
      (SELECT id FROM members WHERE name = 'Nguyễn Văn B' LIMIT 1),
      'Nguyễn Văn B',
      admin_emp_id,
      'admin',
      0,
      'Sample sold 2',
      jsonb_build_object('sample', true),
      nowts - interval '2 days'
    );

  RAISE NOTICE 'Inserted sample history rows (2).';
END;
$$ LANGUAGE plpgsql;

-------------------------------------------------------------------------------
-- Section 7: Optional runtime role for local testing (safe)
-------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'local_app_runtime') THEN
    CREATE ROLE local_app_runtime NOINHERIT;
    RAISE NOTICE 'Created local_app_runtime role (no login).';
  ELSE
    RAISE NOTICE 'local_app_runtime role already exists; skipping.';
  END IF;
END;
$$ LANGUAGE plpgsql;

-------------------------------------------------------------------------------
-- Final informational messages
-------------------------------------------------------------------------------
SELECT '002_seed_admin.sql finished.' AS message;
SELECT ' - If admin not created via SQL, use scripts/seed_admin.js to create admin with bcrypt hash.' AS note;
SELECT ' - Review and remove sample data before deploying to production.' AS note;
SELECT ' - Do not store plain-text passwords; use bcrypt hashed values only.' AS note;
