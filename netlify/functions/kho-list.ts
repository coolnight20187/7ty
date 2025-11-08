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

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || '';
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();

function logDebug(...args: any[]) { if (LOG_LEVEL === 'debug') console.debug('[kho-list]', ...args); }
function logInfo(...args: any[]) { if (['debug','info'].includes(LOG_LEVEL)) console.info('[kho-list]', ...args); }
function logWarn(...args: any[]) { if (['debug','info','warn'].includes(LOG_LEVEL)) console.warn('[kho-list]', ...args); }
function logError(...args: any[]) { console.error('[kho-list]', ...args); }

// In-memory store (shared across function instances only while warm)
let IN_MEMORY_STORE: Record<string, any> = (global as any).__KHO_MEMORY_STORE__ || {};
(global as any).__KHO_MEMORY_STORE__ = IN_MEMORY_STORE;

// Helper to parse numeric query params safely
function parseNum(v: any, fallback: number | null = null) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Query Supabase REST for kho (using simple filters)
async function querySupabase(params: Record<string, any>) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) throw new Error('Supabase not configured');
  const base = SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/kho';
  const headers: Record<string,string> = {
    'apikey': SUPABASE_SERVICE_ROLE,
    'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
    'Accept': 'application/json'
  };

  // Build filter query (Supabase uses PostgREST query syntax)
  const filters: string[] = [];
  if (params.fromAmount != null) filters.push(`total=gte.${Number(params.fromAmount)}`);
  if (params.toAmount != null) filters.push(`total=lte.${Number(params.toAmount)}`);
  if (params.provider_id) filters.push(`provider_id=eq.${encodeURIComponent(params.provider_id)}`);
  if (params.search) {
    const s = String(params.search).toLowerCase();
    // Search across account, name, address using OR
    filters.push(`or=(ilike(name,'%25${s}%25'),ilike(address,'%25${s}%25'),ilike(account,'%25${s}%25'))`);
  }

  const qs = new URLSearchParams();
  if (filters.length) qs.set('q', filters.join('&')); // Note: PostgREST expects each filter as separate query param; we'll append manually below

  // Better: append filters individually
  const url = new URL(base);
  if (params.select) url.searchParams.set('select', params.select);
  if (params.limit) url.searchParams.set('limit', String(params.limit));
  if (params.offset) url.searchParams.set('offset', String(params.offset));

  // Append filters as individual query params
  if (filters.length) {
    // filters currently like ["total=gte.10000", ...] but should be key=value pairs
    for (const f of filters) {
      const [k, v] = f.split('=');
      if (k && v !== undefined) url.searchParams.append(k, v);
    }
  }

  // default order
  if (!url.searchParams.has('order')) url.searchParams.set('order', 'nhapAt.desc');

  const resp = await fetch(url.toString(), { headers });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Supabase query failed: ${resp.status} ${txt.slice(0,500)}`);
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
    res = res.filter((r: any) => Number(r.total || r.amount_current || 0) >= Number(params.fromAmount));
  }
  if (params.toAmount != null) {
    res = res.filter((r: any) => Number(r.total || r.amount_current || 0) <= Number(params.toAmount));
  }
  if (params.search) {
    const s = String(params.search).toLowerCase();
    res = res.filter((r: any) => {
      return String(r.name || '').toLowerCase().includes(s)
        || String(r.address || '').toLowerCase().includes(s)
        || String(r.account || '').toLowerCase().includes(s);
    });
  }
  // sort
  res.sort((a: any, b: any) => {
    const A = a.nhapAt || a.created_at || '';
    const B = b.nhapAt || b.created_at || '';
    return (B || '').localeCompare(A || '');
  });
  // pagination
  const offset = Number(params.offset || 0);
  const limit = Number(params.limit || 1000);
  return res.slice(offset, offset + limit);
}

const handler: Handler = async (event) => {
  try {
    if (event.httpMethod !== 'GET') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const auth = (event.headers['authorization'] || event.headers['Authorization'] || '').trim();
    if (!auth && process.env.SKIP_AUTH !== 'true') {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    const qp = event.queryStringParameters || {};
    const fromAmount = parseNum(qp.fromAmount, null);
    const toAmount = parseNum(qp.toAmount, null);
    const provider_id = qp.provider_id || qp.sku || null;
    const search = qp.search || null;
    const limit = parseNum(qp.limit, 1000) || 1000;
    const offset = parseNum(qp.offset, 0) || 0;

    const params = { fromAmount, toAmount, provider_id, search, limit, offset, select: qp.select };

    // If Supabase configured, try to query it
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
        logWarn('Supabase query failed, falling back to memory:', err?.message || err);
      }
    }

    // Fallback to in-memory store
    const out = queryMemory(params);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(out)
    };
  } catch (err: any) {
    logError('Handler error', err?.message || err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err?.message || 'Internal error' })
    };
  }
};

export { handler };
