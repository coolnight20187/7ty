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

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || '';
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();

function logDebug(...args: any[]) { if (LOG_LEVEL === 'debug') console.debug('[kho-import]', ...args); }
function logInfo(...args: any[]) { if (['debug','info'].includes(LOG_LEVEL)) console.info('[kho-import]', ...args); }
function logWarn(...args: any[]) { if (['debug','info','warn'].includes(LOG_LEVEL)) console.warn('[kho-import]', ...args); }
function logError(...args: any[]) { console.error('[kho-import]', ...args); }

type Bill = {
  key: string;
  account: string;
  provider_id: string;
  name?: string;
  address?: string;
  amount_current?: string | number;
  amount_previous?: string | number;
  total?: string | number;
  nhapAt?: string;
  customer?: string;
  raw?: any;
};

let IN_MEMORY_STORE: Record<string, Bill & { nhapAt?: string; xuatAt?: string }> = {};

// Basic helpers
function isValidBill(b: any): b is Bill {
  return b && typeof b.key === 'string' && b.key.length > 0 && typeof b.account === 'string' && typeof b.provider_id === 'string';
}
function normalizeNumber(v: any): number {
  if (v == null) return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    const s = String(v).replace(/[^\d.-]/g, '');
    const s2 = s ? Number(s) : 0;
    return Number.isFinite(s2) ? s2 : 0;
  }
  return n;
}

// Upsert into Supabase if available
async function upsertSupabase(bills: Bill[]) {
  // dynamic import to avoid adding supabase dependency in simple deployments
  const fetchFn = (globalThis as any).fetch;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) throw new Error('Supabase service role not configured');

  // Build bulk upsert SQL using Postgres UPSERT pattern via RPC (using simple INSERT ... ON CONFLICT DO UPDATE)
  // We'll call REST endpoint /rest/v1/kho with upsert if using Supabase REST; alternatively use direct SQL via RPC
  // Simpler approach: call Supabase REST with POST and prefer=resolution=merge-duplicates (Supabase supports upsert via 'upsert' param)
  const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/kho`;
  const payload = bills.map(b => ({
    key: b.key,
    account: b.account,
    provider_id: b.provider_id,
    name: b.name || null,
    address: b.address || null,
    amount_previous: normalizeNumber(b.amount_previous),
    amount_current: normalizeNumber(b.amount_current),
    total: normalizeNumber(b.total),
    nhapAt: b.nhapAt || new Date().toISOString(),
    customer: b.customer || null,
    raw: b.raw || null
  }));

  // Using Supabase REST: upsert via 'Prefer: resolution=merge-duplicates' and POST
  const resp = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SERVICE_ROLE,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
      'Prefer': 'return=representation, resolution=merge-duplicates'
    },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Supabase upsert failed: ${resp.status} ${txt.slice(0, 500)}`);
  }
  const data = await resp.json();
  return data;
}

// Fallback: upsert into in-memory store
async function upsertInMemory(bills: Bill[]) {
  let added = 0;
  let updated = 0;
  for (const b of bills) {
    if (!isValidBill(b)) continue;
    const key = b.key;
    const now = new Date().toISOString();
    if (IN_MEMORY_STORE[key]) {
      // update some fields (we always update amounts/name/address if provided)
      IN_MEMORY_STORE[key] = {
        ...IN_MEMORY_STORE[key],
        account: b.account,
        provider_id: b.provider_id,
        name: b.name || IN_MEMORY_STORE[key].name,
        address: b.address || IN_MEMORY_STORE[key].address,
        amount_previous: b.amount_previous ?? IN_MEMORY_STORE[key].amount_previous ?? 0,
        amount_current: b.amount_current ?? IN_MEMORY_STORE[key].amount_current ?? 0,
        total: b.total ?? IN_MEMORY_STORE[key].total ?? 0,
        nhapAt: IN_MEMORY_STORE[key].nhapAt || (b.nhapAt || now),
        customer: (b.customer ?? IN_MEMORY_STORE[key].customer) ?? undefined,
        raw: b.raw || IN_MEMORY_STORE[key].raw || null
      };
      updated++;
    } else {
      IN_MEMORY_STORE[key] = {
        key,
        account: b.account,
        provider_id: b.provider_id,
        name: b.name || '',
        address: b.address || '',
        amount_previous: b.amount_previous ?? 0,
        amount_current: b.amount_current ?? 0,
        total: b.total ?? b.amount_current ?? 0,
        nhapAt: b.nhapAt || now,
        xuatAt: '',
        customer: b.customer ?? undefined,
        raw: b.raw || null
      };
      added++;
    }
  }
  return { added, updated, total: Object.keys(IN_MEMORY_STORE).length };
}

// Handler
const handler: Handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    // Auth basic stub
    const auth = (event.headers['authorization'] || event.headers['Authorization'] || '').trim();
    if (!auth && process.env.SKIP_AUTH !== 'true') {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    let body: any = {};
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch (e) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    const bills = Array.isArray(body.bills) ? body.bills : [];
    if (!bills.length) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing bills array' }) };
    }

    // Validate and sanitize up to a reasonable limit
    const MAX = 500;
    if (bills.length > MAX) {
      return { statusCode: 400, body: JSON.stringify({ error: `Too many bills in one request (max ${MAX})` }) };
    }

    const valid = bills.filter(isValidBill);
    if (!valid.length) return { statusCode: 400, body: JSON.stringify({ error: 'No valid bills found' }) };

    // Try Supabase upsert first if configured
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE) {
      try {
        logInfo(`Upserting ${valid.length} bills into Supabase`);
        const data = await upsertSupabase(valid);
        return { statusCode: 200, body: JSON.stringify({ ok: true, mode: 'supabase', count: valid.length, result: data }) };
      } catch (err: any) {
        logWarn('Supabase upsert failed, falling back to memory store:', err?.message || err);
        // fallthrough to in-memory
      }
    }

    // In-memory fallback
    const res = await upsertInMemory(valid);
    return { statusCode: 200, body: JSON.stringify({ ok: true, mode: 'memory', ...res }) };
  } catch (err: any) {
    logError('Handler error', err?.message || err);
    return { statusCode: 500, body: JSON.stringify({ error: err?.message || 'Internal error' }) };
  }
};

export { handler };
