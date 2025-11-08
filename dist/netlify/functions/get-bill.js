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
// If you're using Deno-based Edge functions, replace imports and handler signature as needed.
const NEW_API_BASE_URL = process.env.NEW_API_BASE_URL || 'https://bill.7ty.vn/api';
const NEW_API_PATH = process.env.NEW_API_PATH || '/check-electricity';
const NEW_API_TIMEOUT_MS = Number(process.env.NEW_API_TIMEOUT_MS || 30000);
const NEW_API_MAX_RETRIES = Number(process.env.NEW_API_MAX_RETRIES || 3);
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
function logDebug(...args) {
    if (LOG_LEVEL === 'debug')
        console.debug('[get-bill]', ...args);
}
function logInfo(...args) {
    if (['debug', 'info'].includes(LOG_LEVEL))
        console.info('[get-bill]', ...args);
}
function logWarn(...args) {
    if (['debug', 'info', 'warn'].includes(LOG_LEVEL))
        console.warn('[get-bill]', ...args);
}
function logError(...args) {
    console.error('[get-bill]', ...args);
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
function safeNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}
function normalizeCheckBillResponse(resp, account, sku) {
    try {
        const topSuccess = !!resp?.success;
        const data = resp?.data || {};
        const innerSuccess = !!data?.success;
        const dd = data?.data || {};
        const bills = Array.isArray(dd?.bills) ? dd.bills : [];
        if (topSuccess && innerSuccess && bills.length > 0) {
            const bill = bills[0];
            const money = safeNumber(bill.moneyAmount ?? bill.money_amount ?? 0);
            return {
                key: `${sku}::${account}`,
                provider_id: sku,
                account,
                name: bill.customerName || bill.customer_name || '-',
                address: bill.address || '-',
                month: bill.month || '',
                amount_current: String(money),
                total: String(money),
                amount_previous: '0',
                raw: resp
            };
        }
        const reason = resp?.error ? (typeof resp.error === 'string' ? resp.error : JSON.stringify(resp.error).slice(0, 200)) : 'Không nợ cước / không có dữ liệu';
        return {
            key: `${sku}::${account}`,
            provider_id: sku,
            account,
            name: `(Mã ${account})`,
            address: reason || 'Không nợ cước',
            month: '',
            amount_current: '0',
            total: '0',
            amount_previous: '0',
            raw: resp
        };
    }
    catch (err) {
        return {
            key: `${sku}::${account}`,
            provider_id: sku,
            account,
            name: `(Mã ${account})`,
            address: 'Lỗi parse',
            month: '',
            amount_current: '0',
            total: '0',
            amount_previous: '0',
            raw: resp
        };
    }
}
async function fetchWithTimeoutAndRetry(url, opts = {}, timeout = NEW_API_TIMEOUT_MS, retries = NEW_API_MAX_RETRIES) {
    async function attempt(remaining) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeout);
        try {
            const res = await fetch(url, { ...opts, signal: controller.signal });
            const text = await res.text();
            clearTimeout(id);
            if (!res.ok) {
                const snippet = text ? text.slice(0, 800) : `Status ${res.status}`;
                const err = new Error(`Upstream ${res.status}: ${snippet}`);
                // do not retry on 4xx except 429
                if (res.status >= 400 && res.status < 500 && res.status !== 429) {
                    throw err;
                }
                throw err;
            }
            const ct = res.headers.get('content-type') || '';
            if (!ct.includes('application/json')) {
                // try parse anyway
                try {
                    return JSON.parse(text);
                }
                catch (e) {
                    throw new Error('Upstream returned non-JSON response');
                }
            }
            return JSON.parse(text);
        }
        catch (err) {
            clearTimeout(id);
            if (remaining <= 0)
                throw err;
            const base = 700;
            const backoff = Math.min(base * Math.pow(2, NEW_API_MAX_RETRIES - remaining), 10000);
            logDebug(`fetch error, will retry in ${backoff}ms; remaining=${remaining}`, err?.message || err);
            await sleep(backoff + Math.floor(Math.random() * 200));
            return attempt(remaining - 1);
        }
    }
    return attempt(retries);
}
const handler = async (event) => {
    try {
        if (event.httpMethod !== 'POST') {
            return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
        }
        // Basic auth check placeholder: you should validate Authorization header (JWT/Supabase) before proceeding
        const auth = (event.headers['authorization'] || event.headers['Authorization'] || '').trim();
        if (!auth && process.env.SKIP_AUTH !== 'true') {
            return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
        }
        let body = {};
        try {
            body = event.body ? JSON.parse(event.body) : {};
        }
        catch (err) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
        }
        const contract_number = (body.contract_number || body.contractNumber || body.account || '').toString().trim();
        const sku = (body.sku || body.provider_id || '').toString().trim();
        if (!contract_number || !sku) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Thiếu contract_number hoặc sku' }) };
        }
        const url = new URL(NEW_API_PATH, NEW_API_BASE_URL).toString();
        logInfo('Calling upstream', url, 'contract_number=', contract_number, 'sku=', sku);
        const upstream = await fetchWithTimeoutAndRetry(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contract_number, sku })
        }, NEW_API_TIMEOUT_MS, NEW_API_MAX_RETRIES);
        // Normalize and return both raw and normalized
        const normalized = normalizeCheckBillResponse(upstream, contract_number, sku);
        const payload = { raw: upstream, normalized };
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        };
    }
    catch (err) {
        logError('Handler error', err?.message || err);
        return {
            statusCode: 502,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: err?.message || 'Upstream error' })
        };
    }
};
export { handler };
//# sourceMappingURL=get-bill.js.map