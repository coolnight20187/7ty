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

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || '';
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();

function logDebug(...args: any[]) { if (LOG_LEVEL === 'debug') console.debug('[members]', ...args); }
function logInfo(...args: any[]) { if (['debug','info'].includes(LOG_LEVEL)) console.info('[members]', ...args); }
function logWarn(...args: any[]) { if (['debug','info','warn'].includes(LOG_LEVEL)) console.warn('[members]', ...args); }
function logError(...args: any[]) { console.error('[members]', ...args); }

// In-memory members store for fallback (shared across warm instances)
const MEM = (global as any).__PROJECT_TRA_CUU_MEM__ || { MEMBERS: {}, KHO: {}, HISTORY: [] };
(global as any).__PROJECT_TRA_CUU_MEM__ = MEM;

// Simple helpers
function jsonResponse(status: number, payload: any) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
}
function parseBody(event: any) {
  try {
    return event.body ? JSON.parse(event.body) : {};
  } catch {
    return null;
  }
}
function normalizeMemberRow(r: any) {
  return {
    id: r.id ?? r.member_id ?? null,
    name: r.name ?? r.full_name ?? '',
    zalo: r.zalo ?? '',
    bank: r.bank ?? '',
    created_at: r.created_at ?? null
  };
}

// Supabase REST helpers
async function supabaseGet(id?: string | null) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) throw new Error('Supabase not configured');
  const base = SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/members';
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
    Accept: 'application/json'
  };
  const url = new URL(base);
  if (id) {
    url.searchParams.set('id', `eq.${encodeURIComponent(String(id))}`);
    url.searchParams.set('select', '*');
  } else {
    url.searchParams.set('select', '*');
    url.searchParams.set('order', 'created_at.desc');
    url.searchParams.set('limit', '1000');
  }
  const resp = await fetch(url.toString(), { headers });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Supabase members GET failed: ${resp.status} ${txt.slice(0, 500)}`);
  }
  const data = await resp.json();
  return data;
}

async function supabaseCreate(member: any) {
  const base = SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/members';
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  };
  const payload = {
    name: member.name,
    zalo: member.zalo ?? null,
    bank: member.bank ?? null
  };
  const resp = await fetch(base, { method: 'POST', headers, body: JSON.stringify(payload) });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Supabase members CREATE failed: ${resp.status} ${txt.slice(0, 500)}`);
  }
  const data = await resp.json();
  return data[0] ?? data;
}

async function supabaseUpdate(id: string, values: any) {
  const base = SUPABASE_URL.replace(/\/$/, '') + `/rest/v1/members?id=eq.${encodeURIComponent(String(id))}`;
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  };
  const resp = await fetch(base, { method: 'PATCH', headers, body: JSON.stringify(values) });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Supabase members UPDATE failed: ${resp.status} ${txt.slice(0, 500)}`);
  }
  const data = await resp.json();
  return data[0] ?? data;
}

// In-memory helpers
function memGetAll() {
  return Object.values(MEM.MEMBERS || {}).sort((a: any, b: any) => (b.created_at || '').localeCompare(a.created_at || ''));
}
function memGetOne(id: string) {
  return MEM.MEMBERS ? MEM.MEMBERS[String(id)] || null : null;
}
function memCreate(member: any) {
  const id = String(Date.now()) + Math.random().toString(36).slice(2, 8);
  const entry = { id, name: member.name, zalo: member.zalo ?? '', bank: member.bank ?? '', created_at: new Date().toISOString() };
  MEM.MEMBERS[id] = entry;
  return entry;
}
function memUpdate(id: string, values: any) {
  if (!MEM.MEMBERS || !MEM.MEMBERS[id]) return null;
  MEM.MEMBERS[id] = { ...MEM.MEMBERS[id], ...values };
  return MEM.MEMBERS[id];
}

// Validate input basic
function validateMemberInput(payload: any) {
  if (!payload || typeof payload.name !== 'string' || payload.name.trim().length === 0) {
    return 'Thiếu tên hợp lệ';
  }
  if (payload.name.length > 200) return 'Tên quá dài';
  if (payload.zalo && String(payload.zalo).length > 50) return 'Zalo quá dài';
  if (payload.bank && String(payload.bank).length > 200) return 'Bank quá dài';
  return null;
}

// Handler
const handler: Handler = async (event) => {
  try {
    const method = event.httpMethod || 'GET';
    const auth = (event.headers['authorization'] || event.headers['Authorization'] || '').trim();
    if (!auth && process.env.SKIP_AUTH !== 'true') {
      return jsonResponse(401, { error: 'Unauthorized' });
    }

    // Route by method and path (Netlify Functions route maps file path to base path; for PUT id we expect query id or path param)
    if (method === 'GET') {
      const qp = event.queryStringParameters || {};
      const id = qp.id || qp.memberId || null;
      try {
        if (SUPABASE_URL && SUPABASE_SERVICE_ROLE) {
          const data = await supabaseGet(id);
          if (id) return jsonResponse(200, Array.isArray(data) && data.length ? normalizeMemberRow(data[0]) : null);
          return jsonResponse(200, (data || []).map(normalizeMemberRow));
        } else {
          if (id) return jsonResponse(200, memGetOne(String(id)));
          return jsonResponse(200, memGetAll());
        }
      } catch (err: any) {
        logError('GET members error', err?.message || err);
        return jsonResponse(500, { error: err?.message || 'Internal error' });
      }
    }

    if (method === 'POST') {
      const body = parseBody(event);
      if (!body) return jsonResponse(400, { error: 'Invalid JSON body' });
      const v = validateMemberInput(body);
      if (v) return jsonResponse(400, { error: v });

      if (SUPABASE_URL && SUPABASE_SERVICE_ROLE) {
        try {
          const created = await supabaseCreate(body);
          return jsonResponse(201, normalizeMemberRow(created));
        } catch (err: any) {
          logError('Supabase create member error', err?.message || err);
          return jsonResponse(500, { error: err?.message || 'Create failed' });
        }
      } else {
        const created = memCreate(body);
        return jsonResponse(201, created);
      }
    }

    if (method === 'PUT' || method === 'PATCH') {
      // Expect id either in query or a rudimentary path param (Netlify not supporting direct path here)
      const qp = event.queryStringParameters || {};
      const id = qp.id || qp.memberId || null;
      if (!id) return jsonResponse(400, { error: 'Missing id' });

      const body = parseBody(event);
      if (!body) return jsonResponse(400, { error: 'Invalid JSON body' });

      // Optional validation for fields if present
      if (body.name !== undefined) {
        if (typeof body.name !== 'string' || body.name.trim().length === 0) return jsonResponse(400, { error: 'Tên không hợp lệ' });
        if (body.name.length > 200) return jsonResponse(400, { error: 'Tên quá dài' });
      }

      const up = { name: body.name, zalo: body.zalo, bank: body.bank };

      if (SUPABASE_URL && SUPABASE_SERVICE_ROLE) {
        try {
          const updated = await supabaseUpdate(String(id), up);
          return jsonResponse(200, normalizeMemberRow(updated));
        } catch (err: any) {
          logError('Supabase update member error', err?.message || err);
          return jsonResponse(500, { error: err?.message || 'Update failed' });
        }
      } else {
        const updated = memUpdate(String(id), up);
        if (!updated) return jsonResponse(404, { error: 'Member not found' });
        return jsonResponse(200, updated);
      }
    }

    // Unsupported method
    return jsonResponse(405, { error: 'Method not allowed' });
  } catch (err: any) {
    logError('Handler error', err?.message || err);
    return jsonResponse(500, { error: err?.message || 'Internal error' });
  }
};

export { handler };
