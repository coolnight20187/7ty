/**
 * netlify/functions/get-bills.ts
 *
 * Netlify Function to perform bulk requests to CheckBill Pro (/check-electricity) with:
 *  - concurrency control (p-limit)
 *  - timeout and retry/backoff for each upstream call
 *  - input validation and per-account error isolations
 *  - returns array of results: { account, ok, normalized?, raw?, error? }
 *
 * Expected environment variables:
 * - NEW_API_BASE_URL (e.g. https://bill.7ty.vn/api)
 * - NEW_API_PATH (/check-electricity)
 * - NEW_API_TIMEOUT_MS (default 30000)
 * - NEW_API_MAX_RETRIES (default 3)
 * - NEW_API_CONCURRENCY (default 6)
 * - SKIP_AUTH (optional for dev)
 *
 * Notes:
 * - This function is safe to call from the frontend only when you enforce authentication,
 *   or when you have server-side protections (e.g., require JWT).
 * - Do NOT expose service_role keys on the client.
 */
import { Handler } from '@netlify/functions';
declare const handler: Handler;
export { handler };
//# sourceMappingURL=get-bills.d.ts.map