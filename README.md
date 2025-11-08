# Project Tra cứu & Bán Bill (CheckBill Pro)

Phiên bản: 1.0.0  
Mục đích: Tra cứu hóa đơn điện hàng loạt, quản lý kho (KHO), bán bill, lịch sử giao dịch.  
Cổng duy nhất: CheckBill Pro (https://bill.7ty.vn/api) — endpoint `/check-electricity`.

---

Mục lục
- Giới thiệu
- Kiến trúc tổng quan
- Các thành phần chính
- Hướng dẫn cài đặt nhanh (local / dev)
- Biến môi trường cần cấu hình
- Luồng hoạt động chính
- Bảo mật & vận hành
- Triển khai (Netlify + Supabase / VPS)
- Migrations & seed data
- Gợi ý mở rộng
- Ghi chú dành cho dev

---

## 1. Giới thiệu ngắn

Ứng dụng này cho phép:
- Tra cứu hóa đơn điện hàng loạt bằng CheckBill Pro (proxy + user-agent rotation handled by upstream).
- Hiển thị kết quả dạng bảng hoặc lưới, tìm kiếm, sắp xếp, phân trang.
- Nhập bill vào KHO, lọc theo khoảng tiền, bán bill cho Khách Hàng Thẻ, lưu lịch sử.
- Quản lý nhân viên, ghi chú nhân viên, quản lý khách hàng thẻ.
- Xuất dữ liệu KHO ra Excel.

Phiên bản hiện tại:
- Backend: TypeScript + Express (server.ts)
- Frontend: Static HTML/CSS/JS (public/)
- Database: Migrations SQL cho Postgres (migrations/)
- Được thiết kế để dễ chuyển sang Netlify Functions + Supabase nếu muốn.

---

## 2. Kiến trúc tổng quan

- server.ts: TypeScript Express server, đóng vai proxy an toàn tới CheckBill Pro, cung cấp:
  - /api/check-electricity (single)
  - /api/check-electricity/bulk (bulk lookup with concurrency + retry/backoff)
  - /api/kho/*, /api/members/*, /api/sell, /api/history, /api/export-excel
- public/: Frontend static site (index.html, style.css, app.js)
- migrations/: SQL scripts to create tables and seed sample data
- .env.example: mẫu biến môi trường
- package.json / tsconfig.json: scripts & TypeScript config

Thiết kế thích hợp cho:
- Self-host (VPS / Render / Fly) chạy Node >= 18
- Hoặc chuyển sang Netlify Functions (serverless) và Supabase (managed Postgres + Auth)

---

## 3. Các thành phần chính (chi tiết)

- CheckBill Pro integration:
  - Base URL: `NEW_API_BASE_URL` (mặc định `https://bill.7ty.vn/api`)
  - Endpoint path: `NEW_API_PATH` (mặc định `/check-electricity`)
  - Hạn chế rate: concurrency config `NEW_API_CONCURRENCY` (giữ < 10 req/s)
  - Timeout: `NEW_API_TIMEOUT_MS` (mặc định 30000 ms)
  - Retry: `NEW_API_MAX_RETRIES`

- Backend features:
  - Robust HTTP fetch with timeout and retry/backoff
  - Bulk lookup with `p-limit` concurrency limiter
  - Normalizer to unify upstream responses to internal shape
  - In-memory fallback store for KHO/members/history for quick dev
  - Excel export via ExcelJS
  - Authentication stub (replace with real auth or integrate with Supabase)

- Frontend features:
  - Bulk input, de-dup, call `/api/check-electricity/bulk`, render results
  - Column toggles, export, copy clipboard
  - KHO import/list/remove, Sell workflow
  - Pagination, sorting, grid/list views

- Database:
  - Postgres schema provided in migrations/
  - Tables: employees, members, kho, history, work_notes

---

## 4. Hướng dẫn cài đặt nhanh (Local Development)

Bước 1 — Clone repo:
```bash
git clone <repo-url>
cd project-tra-cuu
