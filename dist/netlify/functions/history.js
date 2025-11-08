/**
 * Netlify Function to list and query sold history records.
 * See original header for full description.
 */
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || '';
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
function logDebug(...args) { if (LOG_LEVEL === 'debug')
    console.debug('[history]', ...args); }
function logInfo(...args) { if (['debug', 'info'].includes(LOG_LEVEL))
    console.info('[history]', ...args); }
function logWarn(...args) { if (['debug', 'info', 'warn'].includes(LOG_LEVEL))
    console.warn('[history]', ...args); }
function logError(...args) { console.error('[history]', ...args); }
function parseIntSafe(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
}
function parseFloatSafe(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}
function parseDateSafe(v) {
    if (!v)
        return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
}
// Simple CSV encoder
function toCsv(rows, columns) {
    const escape = (v) => {
        if (v === null || v === undefined)
            return '';
        const s = String(v);
        if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
            return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
    };
    const header = columns.join(',');
    const lines = rows.map(r => columns.map(c => escape(r[c])).join(','));
    return [header, ...lines].join('\r\n');
}
// In-memory store (shared across warm instances)
const MEM = global.__PROJECT_TRA_CUU_MEM__ || { KHO: {}, HISTORY: [], MEMBERS: {}, EMPLOYEES: {} };
global.__PROJECT_TRA_CUU_MEM__ = MEM;
// Query Supabase history via REST
async function querySupabaseHistory(params) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE)
        throw new Error('Supabase not configured');
    const base = SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/history';
    const headers = {
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        Accept: 'application/json'
    };
    const url = new URL(base);
    url.searchParams.set('select', params.select || '*');
    if (params.search) {
        const s = String(params.search).toLowerCase();
        url.searchParams.set('or', `ilike(name,'%25${s}%25'),ilike(address,'%25${s}%25'),ilike(account,'%25${s}%25'),ilike(member_name,'%25${s}%25'),ilike(employee_username,'%25${s}%25')`);
    }
    if (params.fromDate)
        url.searchParams.set('soldAt', `gte.${params.fromDate}`);
    if (params.toDate)
        url.searchParams.set('soldAt', `lte.${params.toDate}`);
    if (params.minTotal != null)
        url.searchParams.set('total', `gte.${Number(params.minTotal)}`);
    if (params.maxTotal != null)
        url.searchParams.set('total', `lte.${Number(params.maxTotal)}`);
    url.searchParams.set('limit', String(params.limit ?? 100));
    url.searchParams.set('offset', String(params.offset ?? 0));
    url.searchParams.set('order', params.order || 'soldAt.desc');
    const resp = await fetch(url.toString(), { headers });
    if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`Supabase history query failed: ${resp.status} ${txt.slice(0, 500)}`);
    }
    const data = await resp.json();
    return data;
}
// Local memory query fallback
function queryMemoryHistory(params) {
    let arr = Array.isArray(MEM.HISTORY) ? MEM.HISTORY.slice() : [];
    if (params.search) {
        const s = String(params.search).toLowerCase();
        arr = arr.filter((r) => String(r.name || '').toLowerCase().includes(s) ||
            String(r.address || '').toLowerCase().includes(s) ||
            String(r.account || '').toLowerCase().includes(s) ||
            String(r.member_name || r.memberName || '').toLowerCase().includes(s) ||
            String(r.employee_username || '').toLowerCase().includes(s));
    }
    if (params.fromDate)
        arr = arr.filter((r) => (r.soldAt || r.sold_at || '') >= params.fromDate);
    if (params.toDate)
        arr = arr.filter((r) => (r.soldAt || r.sold_at || '') <= params.toDate);
    if (params.minTotal != null)
        arr = arr.filter((r) => Number(r.total || r.total_amount || 0) >= Number(params.minTotal));
    if (params.maxTotal != null)
        arr = arr.filter((r) => Number(r.total || r.total_amount || 0) <= Number(params.maxTotal));
    const order = params.order || 'soldAt.desc';
    const [col, dir] = order.split('.');
    arr.sort((a, b) => {
        const A = a[col] ?? a.soldAt ?? a.sold_at ?? '';
        const B = b[col] ?? b.soldAt ?? b.sold_at ?? '';
        if (A === B)
            return 0;
        if (dir === 'desc')
            return B > A ? 1 : -1;
        return A > B ? 1 : -1;
    });
    const offset = Number(params.offset || 0);
    const limit = Number(params.limit || 100);
    return arr.slice(offset, offset + limit);
}
const handler = async (event, context) => {
    try {
        if (event.httpMethod !== 'GET') {
            return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
        }
        const headersIn = event.headers || {};
        const auth = (headersIn['authorization'] || headersIn['Authorization'] || '').trim();
        if (!auth && process.env.SKIP_AUTH !== 'true') {
            return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
        }
        const qp = event.queryStringParameters || {};
        const search = qp.search || qp.q || null;
        const fromDate = parseDateSafe(qp.fromDate || qp.from_date);
        const toDate = parseDateSafe(qp.toDate || qp.to_date);
        const minTotalRaw = qp.minTotal !== undefined ? parseFloatSafe(qp.minTotal, NaN) : null;
        const maxTotalRaw = qp.maxTotal !== undefined ? parseFloatSafe(qp.maxTotal, NaN) : null;
        const limit = parseIntSafe(qp.limit ?? qp.size ?? 100, 100);
        const offset = parseIntSafe(qp.offset ?? 0, 0);
        const order = qp.order || 'soldAt.desc';
        const exportMode = (qp.export || '').toLowerCase();
        const params = {
            search,
            fromDate,
            toDate,
            minTotal: Number.isFinite(minTotalRaw) ? minTotalRaw : null,
            maxTotal: Number.isFinite(maxTotalRaw) ? maxTotalRaw : null,
            limit: Math.min(limit, 5000),
            offset: Math.max(0, offset),
            order
        };
        let rows = [];
        if (SUPABASE_URL && SUPABASE_SERVICE_ROLE) {
            try {
                logInfo('Querying Supabase history with params', params);
                rows = await querySupabaseHistory(params);
            }
            catch (err) {
                logWarn('Supabase history query failed, falling back to memory:', err?.message || err);
                rows = queryMemoryHistory(params);
            }
        }
        else {
            rows = queryMemoryHistory(params);
        }
        // Normalize output keys
        const normalized = rows.map((r) => {
            const amount_previous = Number(r.amount_previous ?? r.amount_prev ?? 0);
            const amount_current = Number(r.amount_current ?? r.amount_cur ?? 0);
            const total = Number(r.total ?? r.total_amount ?? amount_current ?? 0);
            return {
                id: r.id ?? r.history_id ?? null,
                key: r.key,
                account: r.account,
                provider_id: r.provider_id,
                name: r.name ?? null,
                address: r.address ?? null,
                amount_previous,
                amount_current,
                total,
                nhapAt: r.nhapAt ?? r.nhapat ?? r.nhap_at ?? null,
                xuatAt: r.xuatAt ?? r.xuat_at ?? null,
                soldAt: r.soldAt ?? r.sold_at ?? null,
                memberId: r.member_id ?? r.memberId ?? null,
                memberName: r.member_name ?? r.memberName ?? null,
                employee_username: r.employee_username ?? r.employeeUsername ?? null,
                raw: r.raw ?? null,
                created_at: r.created_at ?? null
            };
        });
        if (exportMode === 'csv') {
            const cols = ['id', 'key', 'account', 'provider_id', 'name', 'address', 'amount_previous', 'amount_current', 'total', 'soldAt', 'memberName', 'employee_username'];
            const csv = toCsv(normalized, cols);
            const headers = {
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': `attachment; filename="history-${Date.now()}.csv"`
            };
            return {
                statusCode: 200,
                headers,
                body: csv
            };
        }
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(normalized)
        };
    }
    catch (err) {
        logError('Handler error', err?.message || err);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: err?.message || 'Internal error' })
        };
    }
};
export { handler };
//# sourceMappingURL=history.js.map