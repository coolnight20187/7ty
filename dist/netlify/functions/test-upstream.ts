import { Handler } from "@netlify/functions";

const TARGET = process.env.NEW_API_FULL_URL || "https://bill.7ty.vn/api/check-electricity";

const handler: Handler = async (event) => {
  try {
    // Simple CORS
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body: "" };
    }

    // Build request body for upstream test
    const testBody = { contract_number: "PB02020047317", sku: "00906815" };

    // Logable result container
    const result: any = { target: TARGET, sentBody: testBody };

    // Do the fetch with timeout
    const controller = new AbortController();
    const timeout = Number(process.env.NEW_API_TIMEOUT_MS || 60000);
    const id = setTimeout(() => controller.abort(), timeout);
    let res;
    try {
      res = await fetch(TARGET, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "7ty-check-bills/1.0" },
        body: JSON.stringify(testBody),
        signal: controller.signal
      } as any);
    } catch (err: any) {
      clearTimeout(id);
      result.fetchError = String(err?.message || err);
      return { statusCode: 502, headers: { "Content-Type": "application/json" }, body: JSON.stringify(result) };
    } finally {
      clearTimeout(id);
    }

    result.status = res.status;
    // collect some response headers (first-line)
    result.responseHeaders = {};
    try {
      const hdrs = res.headers;
      if (hdrs) {
        // copy common headers
        ["content-type", "server", "x-powered-by", "via"].forEach(k => {
          const v = (hdrs as any).get ? (hdrs as any).get(k) : (hdrs as any)[k];
          if (v) result.responseHeaders[k] = v;
        });
      }
    } catch {}

    // read text preview (limit)
    const text = await res.text();
    result.preview = (text || "").slice(0, 2000);
    // try parse json if possible
    try { result.json = JSON.parse(text); } catch {}

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(result) };
  } catch (err: any) {
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: String(err?.message || err) }) };
  }
};

export { handler };
