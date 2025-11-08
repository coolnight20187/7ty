/**
 * netlify/functions/get-bills.ts
 *
 * Bulk check bills with concurrency, timeout/retry, input validation and logging.
 *
 * Expected env:
 * - NEW_API_BASE_URL, NEW_API_PATH, NEW_API_TIMEOUT_MS, NEW_API_MAX_RETRIES, NEW_API_CONCURRENCY
 * - SKIP_AUTH (optional)
 * - LOG_LEVEL (optional: debug|info|warn|error)
 */

import { Handler } from '@netlify/functions';
import pLimit from 'p-limit';

const NEW_API_BASE_URL = process.env.NEW_API_BASE_URL || 'https://bill.7ty.vn/api';
const NEW_API_PATH = process.env.NEW_API_PATH || '/check-electricity';
const NEW_API_TIMEOUT_MS = Number(process.env.NEW_API_TIMEOUT_MS || 30000);
const NEW_API_MAX_RETRIES = Number(process.env.NEW_API_MAX_RETRIES || 3);
const NEW_API_CONCURRENCY = Number(process.env.NEW_API_CONCURRENCY || 6);
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();

function logDebug(...args: any[]) { if (LOG_LEVEL === 'debug') console.debug('[get-bills]', ...args); }
function logInfo(...args: any[]) { if (['debug','info'].includes(LOG_LEVEL)) console.info('[get-bills]', ...args); }
function logWarn(...args: any[]) { if (['debug','info','warn'].includes(LOG_LEVEL)) console.warn('[get-bills]', ...args); }
function logError(...args: any[]) { console.error('[get-bills]', ...args); }

function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }
function safeNumber(v: any) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

async function fetchWithTimeoutAndRetry(url: string, opts: RequestInit = {}, timeout = NEW_API_TIMEOUT_MS, retries = NEW_API_MAX_RETRIES): Promise<any> {
  async function attempt(remaining: number): Promise<any> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      const text = await res.text();
      clearTimeout(id);

      if (!res.ok) {
        const snippet = text ? text.slice(0, 1000) : `Status ${res.status}`;
        const err = new Error(`Upstream ${res.status}: ${snippet}`);
        if (res.status >= 400 && res.status < 500 && res.status !== 429) throw err;
        throw err;
      }

      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        try {
          return JSON.parse(text);
        } catch (e) {
          throw new Error('Upstream returned non-JSON response');
        }
      }
      return JSON.parse(text);
    } catch (err: any) {
      clearTimeout(id);
      if (remaining <= 0) throw err;
      const base = 700;
      const backoff = Math.min(base * Math.pow(2, NEW_API_MAX_RETRIES - remaining), 10000);
      logDebug(`Fetch error, retry in ${backoff}ms; remaining=${remaining}`, err?.message || err);
      await sleep(backoff + Math.floor(Math.random() * 200));
      return attempt(remaining - 1);
    }
  }
  return attempt(retries);
}

function normalizeCheckBillResponse(resp: any, account: string, sku: string) {
  try {
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
        name: bill.customerName || bill.customer_name || '-',
        address: bill.address || '-',
        month: bill.month || '',
        amount_current: String(money),
        total: String(money),
        amount_previous: '0',
        raw: resp
      };
    }
    const reason = resp?.error ? (typeof resp.error === 'string' ? resp.error : JSON.stringify(resp.error).slice(0,200)) : 'Không nợ cước / không có dữ liệu';
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
  } catch (err) {
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

const handler: Handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    // Header lookup case-insensitive
    const headers = Object.keys(event.headers || {}).reduce<Record<string,string>>((acc, k) => {
      acc[k.toLowerCase()] = (event.headers as any)[k];
      return acc;
    }, {});
    const auth = (headers['authorization'] || '').toString().trim();
    if (!auth && process.env.SKIP_AUTH !== 'true') {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    // Parse body safely
    let body: any = {};
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch (err) {
      logWarn('Invalid JSON body', err?.message || err);
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    const contract_numbers = Array.isArray(body.contract_numbers) ? body.contract_numbers.map((v: any) => String(v)).map((s: string) => s.trim()).filter(Boolean) : [];
    const sku = (body.sku || body.provider_id || '').toString().trim();

    if (!contract_numbers.length) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Thiếu contract_numbers (mảng)'} ) };
    }
    if (!sku) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Thiếu sku (provider identifier)'} ) };
    }

    const limit = pLimit(NEW_API_CONCURRENCY);
    const url = new URL(NEW_API_PATH, NEW_API_BASE_URL).toString();

    logInfo(`Bulk call: accounts=${contract_numbers.length} sku=${sku} concurrency=${NEW_API_CONCURRENCY}`);

    const tasks = contract_numbers.map((acc: string) => limit(async () => {
      try {
        logDebug('Calling upstream for', acc);
        const upstream = await fetchWithTimeoutAndRetry(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contract_number: acc, sku })
        }, NEW_API_TIMEOUT_MS, NEW_API_MAX_RETRIES);

        const normalized = normalizeCheckBillResponse(upstream, acc, sku);
        return { account: acc, ok: true, normalized, raw: upstream };
      } catch (err: any) {
        logWarn(`Account ${acc} error:`, err?.message || err);
        return { account: acc, ok: false, error: err?.message || 'Upstream error' };
      }
    }));

    const results = await Promise.all(tasks);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(results)
    };
  } catch (err: any) {
    logError('Handler fatal error', err?.message || err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err?.message || 'Internal error' })
    };
  }
};

export { handler };
