/**
 * netlify/functions/kho-list.ts
 *
 * Netlify Function to list KHO (inventory) items.
 * - Queries Supabase REST /rest/v1/kho when SUPABASE_URL + SUPABASE_SERVICE_ROLE are set.
 * - Falls back to an in-memory store when Supabase isn't configured or the request fails.
 *
 * Notes / fixes applied:
 * - Fixed PostgREST query param construction: append each filter as an individual query param.
 * - Properly encode values and the 'or' filter for ilike searches.
 * - Robust header / auth handling with SKIP_AUTH support.
 * - Safer numeric parsing and defaults.
 * - Improved logging and clearer error messages.
 */

import { Handler } from '@netlify/functions';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || '';
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();

function logDebug(...args: any[]) { if (LOG_LEVEL === 'debug') console.debug('[kho-list]', ...args); }
function logInfo(...args: any[]) { if (['debug','info'].includes(LOG_LEVEL)) console.info('[kho-list]', ...args); }
function logWarn(...args: any[]) { if (['debug','info','warn'].includes(LOG_LEVEL)) console.warn('[kho-list]', ...args); }
function logError(...args: any[]) { console.error('[kho-list]', ...args); }

// In-memory store (shared across warm instances)
let IN_MEMORY_STORE: Record<string, any> = (global as any).__KHO_MEMORY_STORE__ || {};
(global as any).__KHO_MEMORY_STORE__ = IN_MEMORY_STORE;

// parse numeric query param safely
function parseNum(v: any, fallback: number | null = null): number | null {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Build and call Supabase / PostgREST endpoint
async function querySupabase(params: Record<string, any>) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) throw new Error('Supabase not configured');

  const base = SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/kho';
  const headers: Record<string,string> = {
    'apikey': SUPABASE_SERVICE_ROLE,
    'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
    'Accept': 'application/json'
  };

  const url = new URL(base);

  // select/limit/offset/order
  if (params.select) url.searchParams.set('select', String(params.select));
  if (params.limit != null) url.searchParams.set('limit', String(params.limit));
  if (params.offset != null) url.searchParams.set('offset', String(params.offset));
  if (!url.searchParams.has('order')) url.searchParams.set('order', 'nhapAt.desc');

  // Filters: append each filter as its own query param as PostgREST expects.
  if (params.fromAmount != null) {
    url.searchParams.append('total', `gte.${Number(params.fromAmount)}`);
  }
  if (params.toAmount != null) {
    url.searchParams.append('total', `lte.${Number(params.toAmount)}`);
  }
  if (params.provider_id) {
    // provider_id exact match
    url.searchParams.append('provider_id', `eq.${String(params.provider_id)}`);
  }
  if (params.search) {
    // Build an OR ilike filter across name,address,account
    // Example: or=(ilike(name,%25foo%25),ilike(address,%25foo%25),ilike(account,%25foo%25))
    const s = String(params.search);
    const encoded = encodeURIComponent(`or=(ilike(name,%25${s}%25),ilike(address,%25${s}%25),ilike(account,%25${s}%25))`);
    // URLSearchParams will double-encode if we pass the fully encoded string; append raw 'or' param value (unencoded),
    // then let URLSearchParams encode it properly.
    url.searchParams.append('or', `(ilike(name,%25${s}%25),ilike(address,%25${s}%25),ilike(account,%25${s}%25))`);
  }

  const full = url.toString();
  logDebug('Supabase URL', full);

  const resp = await fetch(full, { headers });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Supabase query failed: ${resp.status} ${txt ? ' - ' + txt.slice(0,500) : ''}`);
  }
  const data = await resp.json();
  return data;
}

// Local memory query fallback
function queryMemory(params: Record<string, any>) {
  const arr = Object.values(IN_MEMORY_STORE || {});
  let res = arr.slice();

  if (params.provider_id) {
    res = res.filter((r: any) => String(r.provider_id) === String(params.provider_id));
  }
  if (params.fromAmount != null) {
    res = res.filter((r: any) => Number(r.total ?? r.amount_current ?? 0) >= Number(params.fromAmount));
  }
  if (params.toAmount != null) {
    res = res.filter((r: any) => Number(r.total ?? r.amount_current ?? 0) <= Number(params.toAmount));
  }
  if (params.search) {
    const s = String(params.search).toLowerCase();
    res = res.filter((r: any) => {
      return String(r.name ?? '').toLowerCase().includes(s)
        || String(r.address ?? '').toLowerCase().includes(s)
        || String(r.account ?? '').toLowerCase().includes(s);
    });
  }

  // sort by nhapAt (desc) then created_at
  res.sort((a: any, b: any) => {
    const A = (a.nhapAt ?? a.created_at ?? '').toString();
    const B = (b.nhapAt ?? b.created_at ?? '').toString();
    // ISO strings compare lexicographically; otherwise fallback to string compare
    if (A === B) return 0;
    return (B > A) ? 1 : -1;
  });

  const offset = Number(params.offset || 0) || 0;
  const limit = Number(params.limit || 1000) || 1000;
  return res.slice(offset, offset + limit);
}

const handler: Handler = async (event) => {
  try {
    if (event.httpMethod !== 'GET') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const headers = event.headers || {};
    const auth = (headers.authorization || headers.Authorization || '').toString().trim();
    if (!auth && process.env.SKIP_AUTH !== 'true') {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    const qp = event.queryStringParameters || {};
    const fromAmount = parseNum(qp.fromAmount, null);
    const toAmount = parseNum(qp.toAmount, null);
    const provider_id = qp.provider_id || qp.sku || null;
    const search = qp.search || null;
    const limit = parseNum(qp.limit, 1000) ?? 1000;
    const offset = parseNum(qp.offset, 0) ?? 0;

    const params = { fromAmount, toAmount, provider_id, search, limit, offset, select: qp.select };

    // If Supabase configured, try Supabase first
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE) {
      try {
        logInfo('Querying Supabase for KHO', params);
        const data = await querySupabase(params);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        };
      } catch (err: any) {
        logWarn('Supabase query failed, falling back to in-memory store:', err?.message ?? err);
      }
    }

    // Fallback to in-memory
    logDebug('Querying in-memory store', params);
    const out = queryMemory(params);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(out)
    };
  } catch (err: any) {
    logError('Handler error', err?.stack ?? err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err?.message ?? 'Internal error' })
    };
  }
};

export { handler };
