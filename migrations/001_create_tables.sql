-- 001_create_tables.sql
-- Migration: tạo các bảng cơ bản cho dự án "Tra cứu & Bán Bill"
-- Dùng cho PostgreSQL (Supabase hoặc Postgres tiêu chuẩn)
-- Lưu ý: chạy trong một transaction nếu hệ thống migration của bạn hỗ trợ

BEGIN;

-- =========================
-- Bảng employees (người dùng / nhân viên)
-- =========================
CREATE TABLE IF NOT EXISTS employees (
  id              BIGSERIAL PRIMARY KEY,
  username        TEXT      NOT NULL UNIQUE,
  password_hash   TEXT      NOT NULL,
  role            TEXT      NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  full_name       TEXT,
  phone           TEXT,
  address         TEXT,
  avatar_url      TEXT,
  company_name    TEXT,
  tax_code        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =========================
-- Bảng members (Khách Hàng Thẻ)
-- =========================
CREATE TABLE IF NOT EXISTS members (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  zalo        TEXT,
  bank        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =========================
-- Bảng kho (inventory of bills)
-- key = provider_id::account (unique)
-- total, amount_current, amount_previous lưu dạng numeric để dễ thống kê
-- =========================
CREATE TABLE IF NOT EXISTS kho (
  key           TEXT PRIMARY KEY,
  account       TEXT NOT NULL,
  provider_id   TEXT NOT NULL,
  name          TEXT,
  address       TEXT,
  amount_previous NUMERIC(18,2) DEFAULT 0,
  amount_current  NUMERIC(18,2) DEFAULT 0,
  total           NUMERIC(18,2) DEFAULT 0,
  nhapAt        TIMESTAMPTZ,
  xuatAt        TIMESTAMPTZ,
  customer      TEXT,
  raw           JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =========================
-- Bảng history (giao dịch đã bán)
-- =========================
CREATE TABLE IF NOT EXISTS history (
  id              BIGSERIAL PRIMARY KEY,
  key             TEXT NOT NULL,
  account         TEXT NOT NULL,
  provider_id     TEXT NOT NULL,
  name            TEXT,
  address         TEXT,
  amount_previous NUMERIC(18,2) DEFAULT 0,
  amount_current  NUMERIC(18,2) DEFAULT 0,
  total           NUMERIC(18,2) DEFAULT 0,
  nhapAt          TIMESTAMPTZ,
  xuatAt          TIMESTAMPTZ,
  soldAt          TIMESTAMPTZ,
  member_id       BIGINT REFERENCES members(id) ON DELETE SET NULL,
  member_name     TEXT,
  employee_id     BIGINT REFERENCES employees(id) ON DELETE SET NULL,
  employee_username TEXT,
  raw             JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =========================
-- Bảng work_notes (ghi chú cho nhân viên)
-- =========================
CREATE TABLE IF NOT EXISTS work_notes (
  id               BIGSERIAL PRIMARY KEY,
  employee_id      BIGINT REFERENCES employees(id) ON DELETE CASCADE,
  author_id        BIGINT REFERENCES employees(id) ON DELETE SET NULL,
  author_username  TEXT,
  note_text        TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =========================
-- Indexes (tối ưu truy vấn)
-- =========================
CREATE INDEX IF NOT EXISTS idx_kho_provider_account ON kho(provider_id, account);
CREATE INDEX IF NOT EXISTS idx_kho_nhapAt ON kho(nhapAt DESC);
CREATE INDEX IF NOT EXISTS idx_history_soldAt ON history(soldAt DESC);
CREATE INDEX IF NOT EXISTS idx_members_name ON members(LOWER(name));
CREATE INDEX IF NOT EXISTS idx_employees_username ON employees(LOWER(username));

-- =========================
-- Example seed admin (hash placeholder)
-- NOTE: you should replace password_hash with a bcrypt-hashed secret in your seed script
-- This INSERT uses a dummy value; for production, run a proper seed that hashes password.
-- =========================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM employees WHERE username = 'admin') THEN
    INSERT INTO employees (username, password_hash, role, full_name)
    VALUES ('admin', 'PLACEHOLDER_HASH_CHANGE_ME', 'admin', 'Quản Trị Viên');
  END IF;
END;
$$;

COMMIT;
