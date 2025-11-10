-- 002_seed_admin.sql
-- Seed script to create a secure admin account and sample data for development.
-- IMPORTANT:
--  - Replace <BCRYPT_HASH_OF_PASSWORD> with a real bcrypt hash before using in production.
--  - Prefer running scripts/seed_admin.js (Node) that generates bcrypt hash and updates DB securely using parameterized queries.
--  - This script is intended for development and staging environments only.
--  - Always review and remove sample data before promoting to production.

BEGIN;

-------------------------------------------------------------------------------
-- Section 0: Safety checks and notes
-------------------------------------------------------------------------------
RAISE NOTICE 'Running 002_seed_admin.sql - development-only seed. Review before executing.';

-- Quick guard: if migrations_log exists we can optionally check previous runs
-- (not enforced here to keep idempotent behavior of DO blocks below)

-------------------------------------------------------------------------------
-- Section 1: Helper function - create_or_update_admin_via_bcrypt
-- This function expects a bcrypt hash (not plain text).
-- Use Node to generate hash (bcrypt.hash(password, saltRounds)).
-- Example (Node):
--   node -e "const bcrypt=require('bcrypt'); bcrypt.hash('YourStrongPassword',12).then(h=>console.log(h));"
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_or_update_admin_by_hash(p_username TEXT, p_bcrypt_hash TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF p_bcrypt_hash IS NULL OR char_length(p_bcrypt_hash) < 10 THEN
    RAISE EXCEPTION 'Invalid bcrypt hash provided';
  END IF;

  IF EXISTS (SELECT 1 FROM employees WHERE username = p_username) THEN
    UPDATE employees SET password_hash = p_bcrypt_hash, updated_at = NOW()
      WHERE username = p_username;
    RAISE NOTICE 'Updated existing admin password for %', p_username;
  ELSE
    INSERT INTO employees (username, password_hash, role, full_name, created_at, updated_at)
    VALUES (p_username, p_bcrypt_hash, 'admin', 'Quản Trị Viên', NOW(), NOW());
    RAISE NOTICE 'Inserted admin user %', p_username;
  END IF;
END;
$$;

-------------------------------------------------------------------------------
-- Section 2: Create admin if bcrypt hash provided via variable substitution
-- Replace the placeholder below before running, or call function from your seed script.
-- Example usage (psql):
--   \set myhash 'the_bcrypt_hash_here'
--   SELECT create_or_update_admin_by_hash('admin', :'myhash');
-------------------------------------------------------------------------------
DO $$
DECLARE
  v_hash TEXT := '<BCRYPT_HASH_OF_PASSWORD>'; -- Replace before running or leave as placeholder
BEGIN
  IF v_hash IS NULL OR v_hash = '<BCRYPT_HASH_OF_PASSWORD>' THEN
    RAISE NOTICE 'No bcrypt hash provided in script variable. Skipping admin creation via SQL. Use scripts/seed_admin.js to create admin with bcrypt.' ;
  ELSE
    PERFORM create_or_update_admin_by_hash('admin', v_hash);
  END IF;
END;
$$ LANGUAGE plpgsql;

-------------------------------------------------------------------------------
-- Section 3: Convenience function to generate a secure random password on server side
-- NOTE: This returns plain text password and is only useful for one-off local dev convenience.
-- Prefer generating password locally and hashing in Node instead of using this in CI or production.
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
-- Section 4: Sample members seed (idempotent)
-------------------------------------------------------------------------------
DO $$
DECLARE
  cnt integer;
BEGIN
  SELECT COUNT(*) FROM members INTO cnt;
  IF cnt = 0 THEN
    INSERT INTO members (name, zalo, bank, meta, created_at, updated_at)
    VALUES
      ('Công ty A', '0123456789', 'Vietcombank - 12345678', jsonb_build_object('type','company'), NOW(), NOW()),
      ('Nguyễn Văn B', '0987654321', 'BIDV - 87654321', jsonb_build_object('type','individual'), NOW(), NOW()),
      ('Cá nhân C', NULL, 'Techcombank - 11122233', jsonb_build_object('type','individual'), NOW(), NOW());
    RAISE NOTICE 'Inserted sample members (3 rows).';
  ELSE
    RAISE NOTICE 'Members table not empty; skipping sample members (count=%).', cnt;
  END IF;
END;
$$ LANGUAGE plpgsql;

-------------------------------------------------------------------------------
-- Section 5: Sample KHO items (idempotent)
-- Insert development sample bills only if table empty.
-------------------------------------------------------------------------------
DO $$
DECLARE
  cnt integer;
  nowts timestamptz := now();
BEGIN
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
-- Section 6: Sample history entries (idempotent)
-------------------------------------------------------------------------------
DO $$
DECLARE
  cnt integer;
  nowts timestamptz := now();
BEGIN
  SELECT COUNT(*) FROM history INTO cnt;
  IF cnt = 0 THEN
    INSERT INTO history (key, account, provider_id, name, address, amount_previous, amount_current, total, nhapAt, xuatAt, soldAt, member_id, member_name, employee_username, raw, created_at)
    VALUES
      ('00906815::SOLD0001', 'SOLD0001', '00906815', 'LE VAN D', '12 Tran Phu, HCM', 0, 180000, 180000, nowts - interval '10 days', nowts - interval '5 days', nowts - interval '5 days', NULL, NULL, 'admin', jsonb_build_object('sample',true), nowts - interval '5 days'),
      ('00906818::SOLD0002', 'SOLD0002', '00906818', 'PHAM THI E', '34 Nguyen Hue, HCM', 0, 210000, 210000, nowts - interval '20 days', nowts - interval '2 days', nowts - interval '2 days', NULL, NULL, 'admin', jsonb_build_object('sample',true), nowts - interval '2 days');
    RAISE NOTICE 'Inserted sample history items (2 rows).';
  ELSE
    RAISE NOTICE 'History table not empty; skipping sample history inserts (count=%).', cnt;
  END IF;
END;
$$ LANGUAGE plpgsql;

-------------------------------------------------------------------------------
-- Section 7: Optional: create a temporary runtime account for local testing
-- WARNING: Do NOT use this pattern in production.
-------------------------------------------------------------------------------
DO $$
BEGIN
  -- Only create if not exists and only in non-production contexts
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'local_app_runtime') THEN
    -- This creates a role without login; if you need login include LOGIN and a secure password
    CREATE ROLE local_app_runtime NOINHERIT;
    RAISE NOTICE 'Created local_app_runtime role (no login). Grant privileges manually if needed.';
  ELSE
    RAISE NOTICE 'local_app_runtime role already exists; skipping creation.';
  END IF;
END;
$$ LANGUAGE plpgsql;

-------------------------------------------------------------------------------
-- Section 8: Final notices and recommendations
-------------------------------------------------------------------------------
RAISE NOTICE '002_seed_admin.sql finished. Please:';
RAISE NOTICE ' - If you skipped admin creation above, run scripts/seed_admin.js to create admin with bcrypt hash.';
RAISE NOTICE ' - Remove or review sample data before using in production.';
RAISE NOTICE ' - Do not store plain-text passwords; use bcrypt hashed values only.';

COMMIT;
