export const config = { runtime: "edge" };

/**
 * POST /api/check-electricity/bulk
 * Body: { contract_numbers: string[], sku: string }
 *
 * Env used (set in Pages -> Project -> Environment variables & secrets):
 * - NEW_API_BASE_URL (e.g., https://bill.7ty.vn/api)
 * - NEW_API_PATH (e.g., /check-electricity)
 * - NEW_API_TIMEOUT_MS (ms)
 * - NEW_API_MAX_RETRIES
 * - NEW_API_CONCURRENCY
 * - SKIP_AUTH (set "true" to bypass Authorization during testing)
 * - LOG_LEVEL ("debug" to enable debug logs)
 */

export async function onRequestPost({ request, env }) {
  const headersJson = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
  try {
    // Simple CORS preflight is handled by Pages automatically for OPTIONS,
    // but respond here if browser sends OPTIONS as POST fallback
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" } });
    }

    const LOG_LEVEL = (env.LOG_LEVEL || "info").toLowerCase();
    const log = {
      debug: (...args) => { if (LOG_LEVEL === "debug") console.debug("[bulk]", ...args); },
      info: (...args) => { if (["debug","info"].includes(LOG_LEVEL)) console.info("[bulk]", ...args); },
      warn: (...args) => console.warn("[bulk]", ...args),
      error: (...args) => console.error("[bulk]", ...args)
    };

    // Auth (optional)
    const auth = request.headers.get("authorization") || "";
    if (!auth && env.SKIP_AUTH !== "true") {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: headersJson });
    }

    // Parse body
    let body;
    try { body = await request.json(); } catch (e) {
      log.warn("Invalid JSON body", e?.message || e);
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: headersJson });
    }

    const contract_numbers = Array.isArray(body.contract_numbers) ? body.contract_numbers.map(v => String(v).trim()).filter(Boolean) : [];
    const sku = String(body.sku || body.provider_id || "").trim();

    if (!contract_numbers.length) return new Response(JSON.stringify({ error: "Thiếu contract_numbers (mảng)" }), { status: 400, headers: headersJson });
    if (!sku) return new Response(JSON.stringify({ error: "Thiếu sku (provider identifier)" }), { status: 400, headers: headersJson });

    // Config with env fallbacks
    const NEW_API_BASE_URL = env.NEW_API_BASE_URL || "https://bill.7ty.vn/api";
    const NEW_API_PATH = env.NEW_API_PATH || "/check-electricity";
    const NEW_API_TIMEOUT_MS = Number(env.NEW_API_TIMEOUT_MS || 60000);
    const NEW_API_MAX_RETRIES = Number(env.NEW_API_MAX_RETRIES || 3);
    const NEW_API_CONCURRENCY = Math.max(1, Number(env.NEW_API_CONCURRENCY || 1));

    function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
    function safeNumber(v){ const n = Number(v); return Number.isFinite(n) ? n : 0; }
    function joinUrl(base, path) {
      if (!base) return path;
      try { if (/^https?:\/\//i.test(base)) return new URL(path, base).toString(); } catch {}
      return (base.replace(/\/+$/,"") + "/" + path.replace(/^\/+/,"")).replace(/([^:])\/{2,}/g,"$1/");
    }

    async function fetchWithTimeoutAndRetry(url, init = {}, timeout = NEW_API_TIMEOUT_MS, retries = NEW_API_MAX_RETRIES) {
      async function attempt(remaining) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeout);
        try {
          const r = await fetch(url, { ...init, signal: controller.signal });
          const text = await r.text();
          if (!r.ok) {
            const snippet = text ? String(text).slice(0,1000) : `Status ${r.status}`;
            const err = new Error(`Upstream ${r.status}: ${snippet}`);
            err.status = r.status; err.preview = snippet; err.fatal = (r.status >= 400 && r.status < 500 && r.status !== 429);
            log.warn("Upstream non-ok", r.status, snippet.slice(0,200));
            throw err;
          }
          try { return JSON.parse(text || "{}"); } catch(parseErr) {
            const preview = text ? String(text).slice(0,1000) : "<empty>";
            const err = new Error("Upstream returned non-JSON");
            err.status = r.status; err.preview = preview; err.fatal = true;
            log.warn("Upstream invalid JSON", preview.slice(0,200));
            throw err;
          }
        } catch(err) {
          if (err && err.fatal) throw err;
          clearTimeout(id);
          if (remaining <= 0) throw err;
          const base = 700;
          const backoff = Math.min(base * Math.pow(2, NEW_API_MAX_RETRIES - remaining), 10000);
          log.debug(`Fetch error, retry in ${backoff}ms`, err?.message || err);
          await sleep(backoff + Math.floor(Math.random()*200));
          return attempt(remaining - 1);
        } finally {
          clearTimeout(id);
        }
      }
      return attempt(retries);
    }

    function normalizeCheckBillResponse(resp, account, skuLocal) {
      try {
        if (resp?.data?.response_text && typeof resp.data.response_text === "string") {
          try { resp.data.parsed_response_text = JSON.parse(resp.data.response_text); } catch { resp.data.parsed_response_text = resp.data.response_text; }
        }
        const topSuccess = !!resp?.success;
        const data = resp?.data || {};
        const dd = data?.data || {};
        const bills = Array.isArray(dd?.bills) ? dd.bills : [];

        if (topSuccess && data?.success && bills.length > 0) {
          const bill = bills[0];
          const money = safeNumber(bill.moneyAmount ?? bill.money_amount ?? bill.amount ?? 0);
          return { key: `${skuLocal}::${account}`, provider_id: skuLocal, account, name: bill.customerName || bill.customer_name || "-", address: bill.address || "-", month: bill.month || "", amount_current: String(money), total: String(money), amount_previous: "0", raw: resp };
        }

        let reason = "";
        if (data?.parsed_response_text) {
          const pr = data.parsed_response_text;
          if (typeof pr === "string") reason = pr.slice(0,400);
          else if (pr && typeof pr === "object") reason = pr?.error?.message || pr?.message || JSON.stringify(pr).slice(0,400);
          else reason = String(pr).slice(0,400);
        }
        if (!reason && resp?.error) reason = typeof resp.error === "string" ? resp.error : JSON.stringify(resp.error).slice(0,400);
        if (!reason && data?.status_code) reason = `Upstream status ${data.status_code}`;

        if (data?.status_code === 400) {
          const addressMsg = reason || "Không nợ cước / không có dữ liệu";
          return { key: `${skuLocal}::${account}`, provider_id: skuLocal, account, name: `(Mã ${account})`, address: addressMsg, month: "", amount_current: "0", total: "0", amount_previous: "0", raw: resp };
        }

        if (!reason) reason = "Không nợ cước / không có dữ liệu";
        return { key: `${skuLocal}::${account}`, provider_id: skuLocal, account, name: `(Mã ${account})`, address: reason, month: "", amount_current: "0", total: "0", amount_previous: "0", raw: resp };
      } catch(e) {
        return { key: `${skuLocal}::${account}`, provider_id: skuLocal, account, name: `(Mã ${account})`, address: "Lỗi parse", month: "", amount_current: "0", total: "0", amount_previous: "0", raw: resp };
      }
    }

    const fullUrl = joinUrl(NEW_API_BASE_URL, NEW_API_PATH);
    log.info(`Calling upstream ${fullUrl} for ${contract_numbers.length} accounts (concurrency=${NEW_API_CONCURRENCY})`);

    const results = [];
    for (let i=0; i<contract_numbers.length; i += NEW_API_CONCURRENCY) {
      const chunk = contract_numbers.slice(i, i + NEW_API_CONCURRENCY);
      const part = await Promise.all(chunk.map(async (acc) => {
        try {
          const reqBody = { contract_number: acc, sku };
          log.debug("Upstream request", acc, reqBody);
          const upstream = await fetchWithTimeoutAndRetry(fullUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", "User-Agent": "7ty-check-bills/1.0" },
            body: JSON.stringify(reqBody)
          }, NEW_API_TIMEOUT_MS, NEW_API_MAX_RETRIES);

          if (upstream && upstream.data && Number(upstream.data.status_code) === 400) {
            return { account: acc, ok: true, normalized: { key: `${sku}::${acc}`, provider_id: sku, account: acc, name: `(Mã ${acc})`, address: upstream.data.parsed_response_text || upstream.data.response_text || "Không nợ cước / không có dữ liệu", month: "", amount_current: "0", total: "0", amount_previous: "0", raw: upstream }, raw: upstream };
          }

          const normalized = normalizeCheckBillResponse(upstream, acc, sku);
          return { account: acc, ok: true, normalized, raw: upstream };
        } catch (err) {
          const upstreamStatus = err && err.status ? err.status : undefined;
          const preview = err && err.preview ? err.preview : (err && err.message ? String(err.message).slice(0,400) : undefined);
          log.warn(`Account ${acc} error:`, upstreamStatus || preview || err);

          if (Number(upstreamStatus) === 400) {
            return { account: acc, ok: true, normalized: { key: `${sku}::${acc}`, provider_id: sku, account: acc, name: `(Mã ${acc})`, address: preview || "Không nợ cước", month: "", amount_current: "0", total: "0", amount_previous: "0", raw: err.raw || null }, raw: err.raw || null };
          }

          return { account: acc, ok: false, error: preview ? `${preview}` : (err && err.message ? err.message : "Upstream error"), upstreamStatus: upstreamStatus ? Number(upstreamStatus) : undefined };
        }
      }));
      results.push(...part);
    }

    return new Response(JSON.stringify(results), { status: 200, headers: headersJson });

  } catch (err) {
    console.error("Handler fatal error", err?.message || err);
    return new Response(JSON.stringify({ error: err?.message || "Internal error" }), { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }});
  }
}
