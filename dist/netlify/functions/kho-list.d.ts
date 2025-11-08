/**
 * netlify/functions/kho-list.ts
 *
 * Netlify Function to list KHO (inventory) items.
 * Supports optional query params:
 * - fromAmount (number)  -> filter total >= fromAmount
 * - toAmount   (number)  -> filter total <= toAmount
 * - provider_id (string) -> filter by provider sku
 * - search (string)      -> fulltext-like filter on name/address/account
 * - limit, offset
 *
 * Behavior:
 * - If SUPABASE_URL + SUPABASE_SERVICE_ROLE present -> query Supabase REST endpoint /rest/v1/kho
 * - Otherwise falls back to an in-memory store kept in this runtime (volatile)
 *
 * Environment variables:
 * - SUPABASE_URL (optional)
 * - SUPABASE_SERVICE_ROLE (optional)
 * - SKIP_AUTH (optional for dev)
 *
 * Response:
 * 200 -> JSON array of items or { error }
 */
import { Handler } from '@netlify/functions';
declare const handler: Handler;
export { handler };
//# sourceMappingURL=kho-list.d.ts.map