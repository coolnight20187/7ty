export const config = { runtime: "edge" };

/**
 * Converted from Netlify handler to Cloudflare Pages function.
 * - Use onRequestPost({ request, env }) signature
 * - Reads env from `env`
 * - Returns JSON with same fields as original (target, sentBody, status, responseHeaders, preview, json, fetchError)
 * - Handles CORS preflight and includes Content-Type on responses
 */

export async function onRequestPost({ request, env }) {
  try {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization"
        }
      });
    }

    const TARGET = env.NEW_API_FULL_URL || env.NEW_API_BASE_URL && (env.NEW_API_BASE_URL.replace(/\/+$/, "") + (env.NEW_API_PATH || "/check-electricity")) || "https://bill.7ty.vn/api/check-electricity";

    // Build request body for upstream test
    const testBody = { contract_number: "PB02020047317", sku: "00906815" };

    // Loggable result container
    const result = { target: TARGET, sentBody: testBody };

    // Do the fetch with timeout
    const timeout = Number(env.NEW_API_TIMEOUT_MS || 60000);
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    let res;
    try {
      res = await fetch(TARGET, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "7ty-check-bills/1.0" },
        body: JSON.stringify(testBody),
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(id);
      result.fetchError = String(err?.message || err);
      return new Response(JSON.stringify(result), {
        status: 502,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    } finally {
      clearTimeout(id);
    }

    result.status = res.status;

    // collect some response headers (first-line)
    result.responseHeaders = {};
    try {
      const hdrs = res.headers;
      if (hdrs) {
        ["content-type", "server", "x-powered-by", "via"].forEach(k => {
          try {
            const v = hdrs.get ? hdrs.get(k) : undefined;
            if (v) result.responseHeaders[k] = v;
          } catch {}
        });
      }
    } catch {}

    // read text preview (limit)
    const text = await res.text();
    result.preview = (text || "").slice(0, 2000);

    // try parse json if possible
    try { result.json = JSON.parse(text); } catch {}

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err?.message || err) }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }
}
