-- 001_create_tables.sql
-- Migration: tạo các bảng cơ bản và tiện ích cho dự án "Tra cứu & Bán Bill"
-- Dành cho PostgreSQL / Supabase
-- Thực thi toàn bộ trong một transaction để rollback khi có lỗi
-- CHÚ Ý BẢO MẬT: không lưu mật khẩu thô trong migration; dùng seed script để hash bcrypt và cập nhật password_hash

BEGIN;

--------------------------------------------------------------------------------
-- 0. EXTENSIONS (nếu cần)
-- pgcrypto: cung cấp crypt() và gen_salt() (useful for SQL-side hashing if available)
-- uuid-ossp: tạo UUID nếu cần
-- citext: case-insensitive text (optional, helpful for usernames/emails)
--------------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS citext;

--------------------------------------------------------------------------------
-- 1. Utility: timestamp trigger function
-- Dùng chung để cập nhật updated_at trên nhiều bảng
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION util_update_timestamp()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

--------------------------------------------------------------------------------
-- 2. TABLE: employees
-- Lưu thông tin nhân viên / user (admin, user)
-- password_hash: lưu bcrypt hash (tạo từ server-side seed script)
-- meta: JSONB để lưu preference, roles, flags
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employees (
  id              BIGSERIAL PRIMARY KEY,
  username        CITEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  full_name       TEXT,
  email           TEXT,
  phone           TEXT,
  address         TEXT,
  avatar_url      TEXT,
  company_name    TEXT,
  tax_code        TEXT,
  meta            JSONB,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_employees_update_at ON employees;
CREATE TRIGGER trg_employees_update_at
BEFORE UPDATE ON employees
FOR EACH ROW EXECUTE PROCEDURE util_update_timestamp();

--------------------------------------------------------------------------------
-- 3. TABLE: members
-- Khách hàng/đối tác (dùng khi bán bill)
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS members (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT,
  zalo        TEXT,
  bank        TEXT,
  meta        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_members_update_at ON members;
CREATE TRIGGER trg_members_update_at
BEFORE UPDATE ON members
FOR EACH ROW EXECUTE PROCEDURE util_update_timestamp();

--------------------------------------------------------------------------------
-- 4. TABLE: kho
-- Inventory of bills. key is unique (provider_id::account)
-- numeric fields use NUMERIC(18,2) for monetary accuracy
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kho (
  key              TEXT PRIMARY KEY,
  account          TEXT NOT NULL,
  provider_id      TEXT NOT NULL,
  provider_code    TEXT,
  name             TEXT,
  address          TEXT,
  amount_previous  NUMERIC(18,2) DEFAULT 0,
  amount_current   NUMERIC(18,2) DEFAULT 0,
  total            NUMERIC(18,2) DEFAULT 0,
  currency         TEXT DEFAULT 'VND',
  nhapAt           TIMESTAMPTZ,
  xuatAt           TIMESTAMPTZ,
  customer         TEXT,
  raw              JSONB,
  tags             TEXT[],
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_kho_update_at ON kho;
CREATE TRIGGER trg_kho_update_at
BEFORE UPDATE ON kho
FOR EACH ROW EXECUTE PROCEDURE util_update_timestamp();

--------------------------------------------------------------------------------
-- 5. TABLE: history
-- Records sold transactions (copy of kho row at time of sale + sale metadata)
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS history (
  id                BIGSERIAL PRIMARY KEY,
  key               TEXT NOT NULL,
  account           TEXT NOT NULL,
  provider_id       TEXT NOT NULL,
  name              TEXT,
  address           TEXT,
  amount_previous   NUMERIC(18,2) DEFAULT 0,
  amount_current    NUMERIC(18,2) DEFAULT 0,
  total             NUMERIC(18,2) DEFAULT 0,
  currency          TEXT DEFAULT 'VND',
  nhapAt            TIMESTAMPTZ,
  xuatAt            TIMESTAMPTZ,
  soldAt            TIMESTAMPTZ,
  member_id         BIGINT REFERENCES members(id) ON DELETE SET NULL,
  member_name       TEXT,
  employee_id       BIGINT REFERENCES employees(id) ON DELETE SET NULL,
  employee_username TEXT,
  fee               NUMERIC(18,2) DEFAULT 0,
  note              TEXT,
  raw               JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

--------------------------------------------------------------------------------
-- 6. TABLE: work_notes
-- Simple notes attached to employees or items
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS work_notes (
  id               BIGSERIAL PRIMARY KEY,
  employee_id      BIGINT REFERENCES employees(id) ON DELETE CASCADE,
  author_id        BIGINT REFERENCES employees(id) ON DELETE SET NULL,
  author_username  TEXT,
  note_text        TEXT NOT NULL,
  meta             JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

--------------------------------------------------------------------------------
-- 7. TABLE: kho_audit
-- Lightweight audit log capturing inserts/updates/deletes on kho
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kho_audit (
  id          BIGSERIAL PRIMARY KEY,
  key         TEXT,
  operation   TEXT NOT NULL CHECK (operation IN ('INSERT','UPDATE','DELETE')),
  actor       TEXT,
  snapshot    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION trg_kho_audit_fn()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    INSERT INTO kho_audit(key, operation, actor, snapshot, created_at)
    VALUES (OLD.key, TG_OP, NULLIF(current_setting('app.current_user', true), ''), to_jsonb(OLD), NOW());
    RETURN OLD;
  ELSE
    INSERT INTO kho_audit(key, operation, actor, snapshot, created_at)
    VALUES (NEW.key, TG_OP, NULLIF(current_setting('app.current_user', true), ''), to_jsonb(NEW), NOW());
    RETURN NEW;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_kho_audit ON kho;
CREATE TRIGGER trg_kho_audit
AFTER INSERT OR UPDATE OR DELETE ON kho
FOR EACH ROW EXECUTE PROCEDURE trg_kho_audit_fn();

--------------------------------------------------------------------------------
-- 8. MIGRATIONS LOG (simple tracking)
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS migrations_log (
  id SERIAL PRIMARY KEY,
  filename TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checksum TEXT,
  notes TEXT
);

--------------------------------------------------------------------------------
-- 9. INDEXES & CONSTRAINTS
--------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_members_name_lower ON members (LOWER(name));
CREATE INDEX IF NOT EXISTS idx_kho_provider_account ON kho(provider_id, account);
CREATE INDEX IF NOT EXISTS idx_kho_nhapAt ON kho(nhapAt DESC);
CREATE INDEX IF NOT EXISTS idx_kho_created_at ON kho(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kho_tags_gin ON kho USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_kho_raw_gin ON kho USING GIN (raw);
CREATE INDEX IF NOT EXISTS idx_history_soldAt ON history(soldAt DESC);
CREATE INDEX IF NOT EXISTS idx_employees_username_lower ON employees (LOWER(username));
CREATE INDEX IF NOT EXISTS idx_kho_audit_key ON kho_audit(key);

--------------------------------------------------------------------------------
-- 10. HELPER: set_app_user
-- Set session variable used by triggers to record actor in audit logs
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_app_user(v TEXT) RETURNS TEXT LANGUAGE sql AS $$
  SELECT set_config('app.current_user', v, true);
$$;

--------------------------------------------------------------------------------
-- 11. HELPER: set_admin_password_sql
-- SQL helper using pgcrypto to set an admin password (server-only, optional)
-- NOTE: prefer hashing with bcrypt in server code and updating password via parameterized query.
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_admin_password_sql(p_username TEXT, p_plain TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  hashed TEXT;
BEGIN
  hashed := crypt(p_plain, gen_salt('bf', 12));
  UPDATE employees SET password_hash = hashed, updated_at = NOW() WHERE username = p_username;
  IF NOT FOUND THEN
    INSERT INTO employees (username, password_hash, role, full_name, created_at, updated_at)
    VALUES (p_username, hashed, 'admin', 'Quản Trị Viên', NOW(), NOW());
  END IF;
END;
$$;

--------------------------------------------------------------------------------
-- 12. Stored procedure: sell_items
-- Atomically move items from kho -> history
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sell_items(p_keys TEXT[], p_member_id BIGINT, p_employee_id BIGINT DEFAULT NULL, p_fee NUMERIC DEFAULT 0)
RETURNS TABLE(history_id BIGINT, key TEXT, account TEXT, provider_id TEXT, total NUMERIC, soldAt TIMESTAMPTZ) LANGUAGE plpgsql AS $$
DECLARE
  rec RECORD;
  hrec RECORD;
  mname TEXT;
  i INT;
BEGIN
  IF p_member_id IS NOT NULL THEN
    SELECT name INTO mname FROM members WHERE id = p_member_id;
  END IF;

  IF p_keys IS NULL OR array_length(p_keys,1) IS NULL THEN
    RETURN;
  END IF;

  FOR i IN array_lower(p_keys,1)..array_upper(p_keys,1) LOOP
    SELECT * INTO rec FROM kho WHERE key = p_keys[i] FOR UPDATE;
    IF rec IS NULL THEN
      CONTINUE;
    END IF;

    INSERT INTO history (
      key, account, provider_id, name, address,
      amount_previous, amount_current, total, nhapAt, xuatAt, soldAt,
      member_id, member_name, employee_id, employee_username, fee, raw, created_at
    )
    VALUES (
      rec.key, rec.account, rec.provider_id, rec.name, rec.address,
      rec.amount_previous, rec.amount_current, rec.total, rec.nhapAt, rec.xuatAt, NOW(),
      p_member_id, mname, p_employee_id, NULL, p_fee, rec.raw, NOW()
    )
    RETURNING id, key, account, provider_id, total INTO hrec;

    DELETE FROM kho WHERE key = rec.key;

    history_id := hrec.id;
    key := hrec.key;
    account := hrec.account;
    provider_id := hrec.provider_id;
    total := hrec.total;
    soldAt := NOW();

    RETURN NEXT;
  END LOOP;
END;
$$;

--------------------------------------------------------------------------------
-- 13. MATERIALIZED VIEW: mv_kho_summary
--------------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_kho_summary AS
SELECT provider_id,
       COUNT(*) AS items,
       SUM(COALESCE(total,0))::numeric(18,2) AS total_sum,
       AVG(COALESCE(total,0))::numeric(18,2) AS avg_total,
       MAX(COALESCE(total,0))::numeric(18,2) AS max_total
FROM kho
GROUP BY provider_id
WITH NO DATA;

CREATE INDEX IF NOT EXISTS idx_mv_kho_summary_provider ON mv_kho_summary(provider_id);

CREATE OR REPLACE FUNCTION refresh_kho_summary() RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_kho_summary;
EXCEPTION WHEN SQLSTATE '55000' THEN
  REFRESH MATERIALIZED VIEW mv_kho_summary;
END;
$$;

--------------------------------------------------------------------------------
-- 14. SAMPLE DATA (non-sensitive placeholders)
-- REMOVE/MODIFY in production
--------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM members WHERE name = 'Default Member') THEN
    INSERT INTO members (name, email, zalo, bank, meta, created_at, updated_at)
    VALUES ('Default Member', 'member@example.local', '0123456789', 'VIB 123456789', jsonb_build_object('note','sample member'), NOW(), NOW());
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM employees WHERE username = 'admin') THEN
    INSERT INTO employees (username, password_hash, role, full_name, email, created_at, updated_at)
    VALUES ('admin', 'PLACEHOLDER_HASH_CHANGE_ME', 'admin', 'Quản Trị Viên', 'admin@example.local', NOW(), NOW());
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM kho WHERE key = 'EVN::123456789') THEN
    INSERT INTO kho (key, account, provider_id, provider_code, name, address,
      amount_previous, amount_current, total, nhapAt, raw, tags, created_at, updated_at)
    VALUES (
      'EVN::123456789', '123456789', 'EVN', 'EVN-001', 'Nguyen Van A', 'Hanoi, Vietnam',
      0, 120000.00, 120000.00, NOW() - INTERVAL '30 days',
      jsonb_build_object('example','sample upstream payload','bill_month','2025-10'),
      ARRAY['sample','electricity'], NOW(), NOW()
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM kho WHERE key = 'EVN::987654321') THEN
    INSERT INTO kho (key, account, provider_id, provider_code, name, address,
      amount_previous, amount_current, total, nhapAt, raw, tags, created_at, updated_at)
    VALUES (
      'EVN::987654321', '987654321', 'EVN', 'EVN-002', 'Tran Thi B', 'Ho Chi Minh City',
      0, 85000.00, 85000.00, NOW() - INTERVAL '15 days',
      jsonb_build_object('example','another payload','bill_month','2025-10'),
      ARRAY['urgent','electricity'], NOW(), NOW()
    );
  END IF;
END;
$$;

--------------------------------------------------------------------------------
-- 15. MAINTENANCE: ANALYZE for planner statistics
--------------------------------------------------------------------------------
ANALYZE employees;
ANALYZE members;
ANALYZE kho;
ANALYZE history;
ANALYZE work_notes;

--------------------------------------------------------------------------------
-- 16. MIGRATION LOG ENTRY (basic)
--------------------------------------------------------------------------------
INSERT INTO migrations_log (filename, checksum, notes)
VALUES ('001_create_tables.sql', md5('001_create_tables.sql' || NOW()::text), 'Initial schema with audit, helpers and sample data')
ON CONFLICT DO NOTHING;

COMMIT;
