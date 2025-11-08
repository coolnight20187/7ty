/**
 * netlify/functions/members.ts
 *
 * Handler for Members CRUD exposed as a single Netlify Function (REST-like).
 * Supports:
 *  - GET  /?id=...           -> fetch one or list all when id omitted
 *  - POST /                   -> create new member { name, zalo?, bank? }
 *  - PUT  /:id                -> update member by id { name?, zalo?, bank? }
 *
 * Auth:
 *  - Requires Authorization header unless SKIP_AUTH=true (dev convenience)
 *
 * Persistence:
 *  - If SUPABASE_URL + SUPABASE_SERVICE_ROLE present: use Supabase REST /rest/v1/members
 *  - Otherwise fallback to in-memory store (volatile in serverless warm runtime)
 *
 * Notes:
 *  - This file is intentionally minimal and defensive: validate inputs, limit sizes.
 *  - For production, prefer server-side validation and RBAC.
 */
import { Handler } from '@netlify/functions';
declare const handler: Handler;
export { handler };
//# sourceMappingURL=members.d.ts.map