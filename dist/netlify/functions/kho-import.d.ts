/**
 * netlify/functions/kho-import.ts
 *
 * Netlify Function to import bills into KHO (inventory).
 * - Expects POST body: { bills: [ { key, account, provider_id, name, address, amount_current, amount_previous, total, nhapAt?, customer?, raw? } ] }
 * - Auth: requires Authorization header (Bearer JWT) unless SKIP_AUTH=true (dev)
 * - Persistence: this function demonstrates two modes:
 *    1) If SUPABASE_SERVICE_ROLE and SUPABASE_URL are provided, it will upsert into Supabase (Postgres).
 *    2) Otherwise it falls back to an in-memory store (for local dev).
 *
 * Behavior:
 * - Validate inputs with basic checks
 * - Upsert rows by key (key = provider_id::account)
 * - Return summary: { ok, added, updated, skipped, total }
 *
 * Environment variables used:
 * - SUPABASE_URL (optional)
 * - SUPABASE_SERVICE_ROLE (optional)  -> used server-side only
 * - SKIP_AUTH (optional) for dev convenience
 *
 * Notes:
 * - Never expose SUPABASE_SERVICE_ROLE to client; only stored in Netlify env
 * - For production, you should use RLS and stored procedures / transactions in Postgres for atomicity
 */
import { Handler } from '@netlify/functions';
declare const handler: Handler;
export { handler };
//# sourceMappingURL=kho-import.d.ts.map