/**
 * netlify/functions/get-bill.ts
 *
 * Netlify Function (Edge/Node) style handler for single CheckBill Pro request.
 * - Purpose: call CheckBill Pro /check-electricity endpoint securely from serverless env
 * - Usage: POST body { contract_number: string, sku: string }
 * - Returns: upstream JSON (raw) and normalized object under `normalized`
 *
 * Notes:
 * - Keep this function small and focused: single-request proxy with timeout, retry/backoff, and input validation.
 * - Store secrets (if any) in Netlify environment variables (do NOT expose on client).
 * - If you deploy as Netlify Edge Functions (Deno), adjust fetch/timeouts accordingly.
 *
 * Environment variables expected:
 * - NEW_API_BASE_URL (e.g. https://bill.7ty.vn/api)
 * - NEW_API_PATH (/check-electricity)
 * - NEW_API_TIMEOUT_MS (optional, default 30000)
 * - NEW_API_MAX_RETRIES (optional, default 3)
 * - LOG_LEVEL (optional) - 'debug'|'info'|'warn'|'error'
 *
 * Example response:
 * {
 *   "raw": { ...upstream response... },
 *   "normalized": { key, provider_id, account, name, address, amount_current, total, amount_previous, raw }
 * }
 */
import { Handler } from '@netlify/functions';
declare const handler: Handler;
export { handler };
//# sourceMappingURL=get-bill.d.ts.map