/**
 * netlify/functions/sell.ts
 *
 * Netlify Function to perform selling operation:
 * - Move selected bills from KHO -> history atomically (best-effort).
 * - Accepts POST body:
 *    { memberId: string | number, keys: string[], employeeId?: number, employeeUsername?: string }
 * - Auth: requires Authorization header (Bearer JWT) unless SKIP_AUTH=true
 * - Persistence:
 *    * If SUPABASE_URL + SUPABASE_SERVICE_ROLE present: perform operations via Supabase REST or SQL RPC.
 *    * Otherwise: operate on in-memory store (volatile).
 *
 * Behavior & guarantees:
 * - Attempts to perform an atomic transaction server-side when Supabase is configured.
 * - On success returns { ok: true, sold_count, sold: [history rows] }.
 * - On partial failure, returns 500 with a descriptive error; best-effort rollback attempted when using Supabase transactions/RPC.
 *
 * Security:
 * - SUPABASE_SERVICE_ROLE must NEVER be exposed to clients.
 * - Validate inputs and limit bulk size to avoid resource exhaustion.
 *
 * Environment variables:
 * - SUPABASE_URL (optional)
 * - SUPABASE_SERVICE_ROLE (optional)
 * - SKIP_AUTH (optional)
 * - LOG_LEVEL (optional)
 */
import { Handler } from '@netlify/functions';
declare const handler: Handler;
export { handler };
//# sourceMappingURL=sell.d.ts.map