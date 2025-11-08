-- 002_seed_admin.sql
-- Seed script to create a secure admin account and sample data for development.
-- IMPORTANT:
--  - Replace <BCRYPT_HASH_OF_PASSWORD> with a real bcrypt hash before using in production.
--  - Alternatively run an external script to create the admin user with a hashed password.
--  - This script is intended for development and staging environments.

BEGIN;

-- 1) Create a secure admin user if not exists
-- Note: do NOT use plain text password. Use bcrypt hash. Example generation:
--   node -e "const bcrypt=require('bcrypt'); bcrypt.hash('YourStrongPassword',10).then(h=>console.log(h));"
DO $$
DECLARE
  v_exists boolean;
  v_hash text := '<BCRYPT_HASH_OF_PASSWORD>'; -- replace with actual hashed password
BEGIN
  SELECT EXISTS(SELECT 1 FROM employees WHERE username = 'admin') INTO v_exists;
  IF NOT v_exists THEN
    IF v_hash IS NULL OR v_hash = '<BCRYPT_HASH_OF_PASSWORD>' THEN
      RAISE NOTICE 'No bcrypt hash provided. Skipping admin creation. Please run a script to create admin with hashed password.';
    ELSE
      INSERT INTO employees (username, password_hash, role, full_name, created_at)
      VALUES ('admin', v_hash, 'admin', 'Quản Trị Viên', NOW());
      RAISE NOTICE 'Admin user created (username=admin).';
    END IF;
  ELSE
    RAISE NOTICE 'Admin already exists, skipping creation.';
  END IF;
END;
$$ LANGUAGE plpgsql;

-- 2) Seed example members (only if table empty)
DO $$
DECLARE
  cnt integer;
BEGIN
  SELECT COUNT(*) FROM members INTO cnt;
  IF cnt = 0 THEN
    INSERT INTO members (name, zalo, bank)
    VALUES
      ('Công ty A', '0123456789', 'Vietcombank'),
      ('Nguyễn Văn B', '0987654321', 'BIDV'),
      ('Cá nhân C', '', 'Techcombank');
    RAISE NOTICE 'Inserted sample members.';
  ELSE
    RAISE NOTICE 'Members table not empty; skipping sample members.';
  END IF;
END;
$$ LANGUAGE plpgsql;

-- 3) Seed sample KHO items for development (only if empty)
DO $$
DECLARE
  cnt integer;
  nowts timestamptz := now();
BEGIN
  SELECT COUNT(*) FROM kho INTO cnt;
  IF cnt = 0 THEN
    INSERT INTO kho (key, account, provider_id, name, address, amount_previous, amount_current, total, nhapAt, raw, customer)
    VALUES
      ('00906815::PB02020047317', 'PB02020047317', '00906815', 'NGUYEN VAN A', '123 Nguyen Trai, Q1, HCM', 0, 150000, 150000, nowts, '{"sample":true}'::jsonb, 'Công ty A'),
      ('00906815::PB02020047318', 'PB02020047318', '00906815', 'TRAN THI B', '456 Le Lai, Q1, HCM', 0, 230000, 230000, nowts - interval '1 day', '{"sample":true}'::jsonb, 'Nguyễn Văn B'),
      ('00906819::PB99000000001', 'PB99000000001', '00906819', 'DOAN HUU C', '789 Hai Ba Trung, HN', 0, 120000, 120000, nowts - interval '2 days', '{"sample":true}'::jsonb, 'Cá nhân C');
    RAISE NOTICE 'Inserted sample KHO items.';
  ELSE
    RAISE NOTICE 'KHO table not empty; skipping sample KHO inserts.';
  END IF;
END;
$$ LANGUAGE plpgsql;

-- 4) Seed sample history (only if empty)
DO $$
DECLARE
  cnt integer;
  nowts timestamptz := now();
BEGIN
  SELECT COUNT(*) FROM history INTO cnt;
  IF cnt = 0 THEN
    INSERT INTO history (key, account, provider_id, name, address, amount_previous, amount_current, total, nhapAt, xuatAt, soldAt, member_id, member_name, employee_username, raw)
    VALUES
      ('00906815::PB00000000001', 'PB00000000001', '00906815', 'LE VAN D', '12 Tran Phu, HCM', 0, 180000, 180000, nowts - interval '10 days', nowts - interval '5 days', nowts - interval '5 days', NULL, NULL, 'admin', '{"sample":true}'::jsonb),
      ('00906818::PB00000000002', 'PB00000000002', '00906818', 'PHAM THI E', '34 Nguyen Hue, HCM', 0, 210000, 210000, nowts - interval '20 days', nowts - interval '2 days', nowts - interval '2 days', NULL, NULL, 'admin', '{"sample":true}'::jsonb);
    RAISE NOTICE 'Inserted sample history items.';
  ELSE
    RAISE NOTICE 'History table not empty; skipping sample history inserts.';
  END IF;
END;
$$ LANGUAGE plpgsql;

-- 5) Final notice and grants (development convenience)
-- Grant minimal select/insert/update to PUBLIC for development only (remove in production)
-- WARNING: Only for local development. Do NOT grant PUBLIC in production.
DO $$
BEGIN
  IF current_setting('server_version_num', true) IS NOT NULL THEN
    RAISE NOTICE 'Skipping GRANT step for safety. Adjust privileges manually for production.';
  END IF;
END;
$$ LANGUAGE plpgsql;

COMMIT;
