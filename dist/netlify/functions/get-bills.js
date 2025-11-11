/**
 * netlify/functions/get-bills.ts
 *
 * Robust Netlify Function to bulk-check bills (POST).
 * - Handles CORS preflight (OPTIONS)
 * - Validates input (contract_numbers array + sku)
 * - Calls upstream with concurrency, timeout, retry/backoff
 * - Normalizes upstream responses into consistent shape
 * - Returns array of results: { account, ok: true, normalized, raw } | { account, ok: false, error, upstreamStatus }
 *
 * Deploy:
 * - Place at netlify/functions/get-bills.ts
 * - Ensure netlify.toml or _redirects maps /api/* -> /.netlify/functions/:splat
 * - Ensure Netlify build step compiles TypeScript (tsc) or use JS version
 * - Set env vars as needed (NEW_API_BASE_URL, NEW_API_PATH, NEW_API_TIMEOUT_MS, NEW_API_MAX_RETRIES, NEW_API_CONCURRENCY)
 */
const pLimit = require("p-limit");
/* Config (override via Netlify env) */
const NEW_API_BASE_URL = process.env.NEW_API_BASE_URL || "https://bill.7ty.vn/api";
const NEW_API_PATH = process.env.NEW_API_PATH || "/check-electricity";
const NEW_API_TIMEOUT_MS = Number(process.env.NEW_API_TIMEOUT_MS || 30000);
const NEW_API_MAX_RETRIES = Number(process.env.NEW_API_MAX_RETRIES || 3);
const NEW_API_CONCURRENCY = Number(process.env.NEW_API_CONCURRENCY || 6);
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
/* Simple logging helpers */
function logDebug(...args) { if (LOG_LEVEL === "debug")
    console.debug("[get-bills]", ...args); }
function logInfo(...args) { if (["debug", "info"].includes(LOG_LEVEL))
    console.info("[get-bills]", ...args); }
function logWarn(...args) { if (["debug", "info", "warn"].includes(LOG_LEVEL))
    console.warn("[get-bills]", ...args); }
function logError(...args) { console.error("[get-bills]", ...args); }
function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }
function safeNumber(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
/* Ensure every response includes string headers to satisfy HandlerResponse typing */
const COMMON_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
};
/* Safe header getter (works with various fetch Response header implementations) */
function getHeaderSafe(headersLike, name) {
    try {
        if (!headersLike)
            return "";
        if (typeof headersLike.get === "function")
            return headersLike.get(name) || "";
        const lower = name.toLowerCase();
        for (const k of Object.keys(headersLike)) {
            if (k.toLowerCase() === lower)
                return headersLike[k];
        }
        return "";
    }
    catch {
        return "";
    }
}
/* fetch + timeout + retry/backoff (throws UpstreamError on failure) */
async function fetchWithTimeoutAndRetry(url, opts = {}, timeout = NEW_API_TIMEOUT_MS, retries = NEW_API_MAX_RETRIES) {
    async function attempt(remaining) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeout);
        try {
            const res = await fetch(url, { ...opts, signal: controller.signal });
            const text = await res.text();
            if (!res.ok) {
                const snippet = text ? String(text).slice(0, 1000) : `Status ${res.status}`;
                const err = Object.assign(new Error(`Upstream ${res.status}: ${snippet}`), {
                    status: res.status,
                    preview: snippet,
                    fatal: (res.status >= 400 && res.status < 500 && res.status !== 429)
                });
                // log limited preview for debug
                logWarn('Upstream non-ok response', { status: res.status, preview: snippet.slice(0, 400) });
                throw err;
            }
            // Try parse JSON (most upstreams return JSON)
            try {
                return JSON.parse(text || "{}");
            }
            catch (parseErr) {
                const preview = text ? String(text).slice(0, 1000) : "<empty>";
                const err = Object.assign(new Error("Upstream returned non-JSON/invalid JSON"), { status: res.status, preview, fatal: true });
                logWarn("Upstream invalid JSON", { preview });
                throw err;
            }
        }
        catch (errAny) {
            const err = errAny;
            if (err?.fatal)
                throw err;
            clearTimeout(id);
            if (remaining <= 0)
                throw err;
            const base = 700;
            const backoff = Math.min(base * Math.pow(2, NEW_API_MAX_RETRIES - remaining), 10000);
            logDebug(`Fetch error for ${url}; retry in ${backoff}ms; remaining=${remaining}`, err?.message || err);
            await sleep(backoff + Math.floor(Math.random() * 200));
            return attempt(remaining - 1);
        }
        finally {
            clearTimeout(id);
        }
    }
    return attempt(retries);
}
/* Normalize upstream response into consistent bill shape */
function normalizeCheckBillResponse(resp, account, sku) {
    try {
        if (resp?.data?.response_text && typeof resp.data.response_text === "string") {
            try {
                resp.data.parsed_response_text = JSON.parse(resp.data.response_text);
            }
            catch {
                resp.data.parsed_response_text = resp.data.response_text;
            }
        }
        const topSuccess = !!resp?.success;
        const data = resp?.data || {};
        const innerSuccess = !!data?.success;
        const dd = data?.data || {};
        const bills = Array.isArray(dd?.bills) ? dd.bills : [];
        if (topSuccess && innerSuccess && bills.length > 0) {
            const bill = bills[0];
            const money = safeNumber(bill.moneyAmount ?? bill.money_amount ?? bill.amount ?? 0);
            return {
                key: `${sku}::${account}`,
                provider_id: sku,
                account,
                name: bill.customerName || bill.customer_name || "-",
                address: bill.address || "-",
                month: bill.month || "",
                amount_current: String(money),
                total: String(money),
                amount_previous: "0",
                raw: resp
            };
        }
        // Build concise reason text
        let reason = "";
        if (data?.parsed_response_text) {
            const pr = data.parsed_response_text;
            if (typeof pr === "string")
                reason = pr.slice(0, 400);
            else if (pr && typeof pr === "object")
                reason = pr?.error?.message || pr?.message || JSON.stringify(pr).slice(0, 400);
            else
                reason = String(pr).slice(0, 400);
        }
        if (!reason && resp?.error)
            reason = typeof resp.error === "string" ? resp.error : JSON.stringify(resp.error).slice(0, 400);
        if (!reason && data?.status_code)
            reason = `Upstream status ${data.status_code}`;
        // If upstream indicates 400 (client-level: no debt / invalid input), treat as no-debt result
        if (data?.status_code === 400) {
            const addressMsg = reason || "Không nợ cước / không có dữ liệu";
            return {
                key: `${sku}::${account}`,
                provider_id: sku,
                account,
                name: `(Mã ${account})`,
                address: addressMsg,
                month: "",
                amount_current: "0",
                total: "0",
                amount_previous: "0",
                raw: resp
            };
        }
        if (!reason)
            reason = "Không nợ cước / không có dữ liệu";
        return {
            key: `${sku}::${account}`,
            provider_id: sku,
            account,
            name: `(Mã ${account})`,
            address: reason,
            month: "",
            amount_current: "0",
            total: "0",
            amount_previous: "0",
            raw: resp
        };
    }
    catch (err) {
        return {
            key: `${sku}::${account}`,
            provider_id: sku,
            account,
            name: `(Mã ${account})`,
            address: "Lỗi parse",
            month: "",
            amount_current: "0",
            total: "0",
            amount_previous: "0",
            raw: resp
        };
    }
}
/* Handler */
const handler = async (event) => {
    try {
        // CORS preflight
        if (event.httpMethod === "OPTIONS") {
            return {
                statusCode: 204,
                headers: {
                    "Content-Type": "text/plain",
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type, Authorization"
                },
                body: ""
            };
        }
        if (event.httpMethod !== "POST") {
            return {
                statusCode: 405,
                headers: COMMON_HEADERS,
                body: JSON.stringify({ error: "Method not allowed" })
            };
        }
        // Normalize headers (case-insensitive)
        const headers = Object.keys(event.headers || {}).reduce((acc, k) => {
            acc[k.toLowerCase()] = event.headers[k];
            return acc;
        }, {});
        const auth = (headers["authorization"] || "").toString().trim();
        if (!auth && process.env.SKIP_AUTH !== "true") {
            return {
                statusCode: 401,
                headers: COMMON_HEADERS,
                body: JSON.stringify({ error: "Unauthorized" })
            };
        }
        // Parse body
        let body = {};
        try {
            body = event.body ? JSON.parse(event.body) : {};
        }
        catch (err) {
            logWarn("Invalid JSON body", err?.message || err);
            return {
                statusCode: 400,
                headers: COMMON_HEADERS,
                body: JSON.stringify({ error: "Invalid JSON body" })
            };
        }
        const contract_numbers = Array.isArray(body.contract_numbers)
            ? body.contract_numbers.map((v) => String(v)).map((s) => s.trim()).filter(Boolean)
            : [];
        const sku = (body.sku || body.provider_id || "").toString().trim();
        if (!contract_numbers.length) {
            return {
                statusCode: 400,
                headers: COMMON_HEADERS,
                body: JSON.stringify({ error: "Thiếu contract_numbers (mảng)" })
            };
        }
        if (!sku) {
            return {
                statusCode: 400,
                headers: COMMON_HEADERS,
                body: JSON.stringify({ error: "Thiếu sku (provider identifier)" })
            };
        }
        const limit = pLimit(NEW_API_CONCURRENCY);
        const url = new URL(NEW_API_PATH, NEW_API_BASE_URL).toString();
        logInfo(`Bulk call: accounts=${contract_numbers.length} sku=${sku} concurrency=${NEW_API_CONCURRENCY}`);
        const tasks = contract_numbers.map((acc) => limit(async () => {
            try {
                logDebug("Calling upstream for", acc);
                const upstream = await fetchWithTimeoutAndRetry(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "User-Agent": "7ty-check-bills/1.0" },
                    body: JSON.stringify({ contract_number: acc, sku })
                }, NEW_API_TIMEOUT_MS, NEW_API_MAX_RETRIES);
                const normalized = normalizeCheckBillResponse(upstream, acc, sku);
                return { account: acc, ok: true, normalized, raw: upstream };
            }
            catch (errAny) {
                const err = errAny;
                const upstreamStatus = err?.status || (err?.message?.match?.(/Upstream (\d{3})/) || [])[1];
                const preview = err?.preview || (typeof err?.message === "string" ? err.message.slice(0, 400) : undefined);
                logWarn(`Account ${acc} error:`, upstreamStatus || err?.message || err);
                // If upstream returned 400 as a captured error, treat as no-debt safe result
                if (Number(upstreamStatus) === 400) {
                    return {
                        account: acc,
                        ok: true,
                        normalized: {
                            key: `${sku}::${acc}`,
                            provider_id: sku,
                            account: acc,
                            name: `(Mã ${acc})`,
                            address: preview || "Không nợ cước",
                            month: "",
                            amount_current: "0",
                            total: "0",
                            amount_previous: "0",
                            raw: errAny?.raw || null
                        },
                        raw: errAny?.raw || null
                    };
                }
                return {
                    account: acc,
                    ok: false,
                    error: preview ? `${preview}` : (err?.message || "Upstream error"),
                    upstreamStatus: upstreamStatus ? Number(upstreamStatus) : undefined
                };
            }
        }));
        const results = await Promise.all(tasks);
        return {
            statusCode: 200,
            headers: COMMON_HEADERS,
            body: JSON.stringify(results)
        };
    }
    catch (err) {
        logError("Handler fatal error", err?.message || err);
        return {
            statusCode: 500,
            headers: COMMON_HEADERS,
            body: JSON.stringify({ error: err?.message || "Internal error" })
        };
    }
};
export { handler };
//# sourceMappingURL=get-bills.js.map