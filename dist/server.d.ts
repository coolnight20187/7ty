/**
 * server.ts
 *
 * Express server implementation for "Tra cứu & Bán Bill"
 * - Provides REST endpoints used by frontend and Netlify function equivalents:
 *    - POST  /api/check-electricity         (single)
 *    - POST  /api/check-electricity/bulk    (bulk)
 *    - POST  /api/kho/import
 *    - GET   /api/kho/list
 *    - POST  /api/kho/remove
 *    - POST  /api/sell
 *    - GET   /api/history
 *    - GET   /api/members, POST /api/members, PUT /api/members/:id
 *    - GET   /api/export-excel
 * - Designed to run as a standalone Node server (useful for local dev and VPS)
 * - Uses in-memory fallback stores when DATABASE_URL / SUPABASE are not configured
 *
 * Notes:
 * - This file keeps logic simple and readable; for production split into modules.
 * - Ensure environment variables are set (see .env.example or README).
 */
export {};
//# sourceMappingURL=server.d.ts.map