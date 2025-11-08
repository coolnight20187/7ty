/**
 * server.ts
 *
 * Express server implementation for "Tra cứu & Bán Bill"
 * - Provides REST endpoints used by frontend and Netlify function equivalents:
 *    - POST  /api/check-electricity         (single)
 *    - POST  /api/check-electricity/bulk    (bulk)
 *    - POST  /api/kho/import
 *    - GET   /api/kho/list
 *    - POST  /api/kho/remove
 *    - POST  /api/sell
 *    - GET   /api/history
 *    - GET   /api/members, POST /api/members, PUT /api/members/:id
 *    - GET   /api/export-excel
 * - Designed to run as a standalone Node server (useful for local dev and VPS)
 * - Uses in-memory fallback stores when DATABASE_URL / SUPABASE are not configured
 *
 * Notes:
 * - This file keeps logic simple and readable; for production split into modules.
 * - Ensure environment variables are set (see .env.example or README).
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import pLimit from 'p-limit';
import ExcelJS from 'exceljs';
import crypto from 'crypto';
const app = express();
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
// Basic rate limiter to protect upstream
const apiLimiter = rateLimit({
    windowMs: 10 * 1000,
    max: Number(process.env.RATE_LIMIT || 60),
    message: 'Too many requests, slow down'
});
app.use('/api/', apiLimiter);
// Config
const NEW_API_BASE_URL = process.env.NEW_API_BASE_URL || 'https://bill.7ty.vn/api';
const NEW_API_PATH = process.env.NEW_API_PATH || '/check-electricity';
const NEW_API_TIMEOUT_MS = Number(process.env.NEW_API_TIMEOUT_MS || 30000);
const NEW_API_MAX_RETRIES = Number(process.env.NEW_API_MAX_RETRIES || 3);
const NEW_API_CONCURRENCY = Number(process.env.NEW_API_CONCURRENCY || 6);
const SKIP_AUTH = process.env.SKIP_AUTH === 'true';
// Simple logger
function log(...args) { if ((process.env.LOG_LEVEL || 'info') !== 'silent')
    console.log(...args); }
// In-memory stores (dev fallback)
const MEM = {
    KHO: {}, // key -> item
    HISTORY: [], // array of sold items
    MEMBERS: {}, // id -> member
    EMPLOYEES: {} // id -> employee
};
// Utilities
function safeNumber(v) {
    if (v == null)
        return 0;
    const n = Number(v);
    if (Number.isFinite(n))
        return n;
    const s = String(v).replace(/[^\d.-]/g, '');
    const n2 = Number(s);
    return Number.isFinite(n2) ? n2 : 0;
}
function nowISO() { return new Date().toISOString(); }
// Simple auth middleware (dev stub)
function requireAuth(req, res, next) {
    if (SKIP_AUTH)
        return next();
    const auth = (req.headers.authorization || '').toString();
    if (!auth)
        return res.status(401).json({ error: 'Unauthorized' });
    // In production verify JWT or session
    return next();
}
// Fetch with timeout + retries
async function fetchWithTimeoutRetry(url, opts = {}, timeout = NEW_API_TIMEOUT_MS, retries = NEW_API_MAX_RETRIES) {
    async function attempt(remaining) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeout);
        try {
            const res = await fetch(url, { ...opts, signal: controller.signal });
            const text = await res.text();
            clearTimeout(id);
            if (!res.ok) {
                const err = new Error(`Status ${res.status} - ${text.slice(0, 500)}`);
                if (res.status >= 400 && res.status < 500 && res.status !== 429)
                    throw err;
                throw err;
            }
            const ct = res.headers.get('content-type') || '';
            if (!ct.includes('application/json')) {
                try {
                    return JSON.parse(text);
                }
                catch {
                    throw new Error('Upstream non-json');
                }
            }
            return JSON.parse(text);
        }
        catch (err) {
            clearTimeout(id);
            if (remaining <= 0)
                throw err;
            const base = 500;
            const backoff = Math.min(base * Math.pow(2, NEW_API_MAX_RETRIES - remaining), 8000);
            await new Promise(r => setTimeout(r, backoff + Math.floor(Math.random() * 200)));
            return attempt(remaining - 1);
        }
    }
    return attempt(retries);
}
function normalizeUpstream(resp, account, sku) {
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
        const reason = resp?.error ? (typeof resp.error === 'string' ? resp.error : JSON.stringify(resp.error).slice(0, 200)) : 'No debt / no data';
        return {
            key: `${sku}::${account}`,
            provider_id: sku,
            account,
            name: `(Mã ${account})`,
            address: reason,
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
            address: 'Parse error',
            month: '',
            amount_current: '0',
            total: '0',
            amount_previous: '0',
            raw: resp
        };
    }
}
// Endpoints
app.get('/api/health', (req, res) => res.json({ ok: true, ts: nowISO() }));
// Single check
app.post('/api/check-electricity', requireAuth, async (req, res) => {
    try {
        const contract_number = (req.body.contract_number || req.body.contractNumber || req.body.account || '').toString().trim();
        const sku = (req.body.sku || req.body.provider_id || '').toString().trim();
        if (!contract_number || !sku)
            return res.status(400).json({ error: 'Missing contract_number or sku' });
        const url = new URL(NEW_API_PATH, NEW_API_BASE_URL).toString();
        const upstream = await fetchWithTimeoutRetry(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contract_number, sku })
        });
        const normalized = normalizeUpstream(upstream, contract_number, sku);
        return res.json({ raw: upstream, normalized });
    }
    catch (err) {
        log('check-electricity error', err?.message || err);
        return res.status(502).json({ error: err?.message || 'Upstream error' });
    }
});
// Bulk check
app.post('/api/check-electricity/bulk', requireAuth, async (req, res) => {
    try {
        const contract_numbers = Array.isArray(req.body.contract_numbers) ? req.body.contract_numbers.map((v) => String(v)).map((s) => s.trim()).filter(Boolean) : [];
        const sku = (req.body.sku || req.body.provider_id || '').toString().trim();
        if (!sku)
            return res.status(400).json({ error: 'Missing sku' });
        if (!contract_numbers.length)
            return res.status(400).json({ error: 'Missing contract_numbers array' });
        const limit = pLimit(NEW_API_CONCURRENCY);
        const url = new URL(NEW_API_PATH, NEW_API_BASE_URL).toString();
        const tasks = contract_numbers.map((acc) => limit(async () => {
            try {
                const upstream = await fetchWithTimeoutRetry(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ contract_number: acc, sku })
                });
                const normalized = normalizeUpstream(upstream, acc, sku);
                return { account: acc, ok: true, normalized, raw: upstream };
            }
            catch (err) {
                return { account: acc, ok: false, error: err?.message || 'Upstream error' };
            }
        }));
        const results = await Promise.all(tasks);
        return res.json(results);
    }
    catch (err) {
        log('bulk error', err?.message || err);
        return res.status(500).json({ error: err?.message || 'Internal error' });
    }
});
// KHO import
app.post('/api/kho/import', requireAuth, async (req, res) => {
    try {
        const bills = Array.isArray(req.body.bills) ? req.body.bills : [];
        if (!bills.length)
            return res.status(400).json({ error: 'Missing bills array' });
        let added = 0, updated = 0;
        for (const b of bills) {
            const key = (b.key || `${b.provider_id || 'UNK'}::${b.account || ''}`).toString();
            const now = nowISO();
            const item = {
                key,
                account: b.account || '',
                provider_id: b.provider_id || '',
                name: b.name || '',
                address: b.address || '',
                amount_previous: safeNumber(b.amount_previous),
                amount_current: safeNumber(b.amount_current),
                total: safeNumber(b.total ?? b.amount_current),
                nhapAt: b.nhapAt || now,
                customer: b.customer || null,
                raw: b.raw || null,
                created_at: now
            };
            if (MEM.KHO[key]) {
                MEM.KHO[key] = { ...MEM.KHO[key], ...item };
                updated++;
            }
            else {
                MEM.KHO[key] = item;
                added++;
            }
        }
        return res.json({ ok: true, mode: 'memory', added, updated, total: Object.keys(MEM.KHO).length });
    }
    catch (err) {
        log('kho/import error', err?.message || err);
        return res.status(500).json({ error: err?.message || 'Internal error' });
    }
});
// KHO list
app.get('/api/kho/list', requireAuth, (req, res) => {
    try {
        const fromAmount = req.query.fromAmount ? safeNumber(req.query.fromAmount) : null;
        const toAmount = req.query.toAmount ? safeNumber(req.query.toAmount) : null;
        const provider_id = (req.query.provider_id || req.query.sku || '').toString() || null;
        const search = (req.query.search || '').toString().toLowerCase() || null;
        let arr = Object.values(MEM.KHO || {});
        if (provider_id)
            arr = arr.filter((r) => String(r.provider_id) === String(provider_id));
        if (fromAmount != null)
            arr = arr.filter((r) => safeNumber(r.total) >= fromAmount);
        if (toAmount != null)
            arr = arr.filter((r) => safeNumber(r.total) <= toAmount);
        if (search) {
            arr = arr.filter((r) => (String(r.name || '').toLowerCase().includes(search)
                || String(r.address || '').toLowerCase().includes(search)
                || String(r.account || '').toLowerCase().includes(search)));
        }
        // sort by nhapAt desc
        arr.sort((a, b) => (b.nhapAt || b.created_at || '').localeCompare(a.nhapAt || a.created_at || ''));
        return res.json(arr);
    }
    catch (err) {
        log('kho/list error', err?.message || err);
        return res.status(500).json({ error: err?.message || 'Internal error' });
    }
});
// KHO remove
app.post('/api/kho/remove', requireAuth, (req, res) => {
    try {
        const keys = Array.isArray(req.body.keys) ? req.body.keys.map(String) : [];
        if (!keys.length)
            return res.status(400).json({ error: 'Missing keys array' });
        let removed = 0;
        for (const k of keys) {
            if (MEM.KHO[k]) {
                delete MEM.KHO[k];
                removed++;
            }
        }
        return res.json({ ok: true, removed });
    }
    catch (err) {
        log('kho/remove error', err?.message || err);
        return res.status(500).json({ error: err?.message || 'Internal error' });
    }
});
// Members endpoints
app.get('/api/members', requireAuth, (req, res) => {
    try {
        const arr = Object.values(MEM.MEMBERS || {});
        return res.json(arr);
    }
    catch (err) {
        return res.status(500).json({ error: err?.message || 'Internal error' });
    }
});
app.post('/api/members', requireAuth, (req, res) => {
    try {
        const name = (req.body.name || '').toString().trim();
        if (!name)
            return res.status(400).json({ error: 'Missing name' });
        const id = crypto.randomUUID();
        const entry = { id, name, zalo: req.body.zalo || '', bank: req.body.bank || '', created_at: nowISO() };
        MEM.MEMBERS[id] = entry;
        return res.status(201).json(entry);
    }
    catch (err) {
        return res.status(500).json({ error: err?.message || 'Internal error' });
    }
});
app.put('/api/members/:id', requireAuth, (req, res) => {
    try {
        const id = req.params.id;
        if (!MEM.MEMBERS[id])
            return res.status(404).json({ error: 'Member not found' });
        MEM.MEMBERS[id] = { ...MEM.MEMBERS[id], name: req.body.name ?? MEM.MEMBERS[id].name, zalo: req.body.zalo ?? MEM.MEMBERS[id].zalo, bank: req.body.bank ?? MEM.MEMBERS[id].bank };
        return res.json(MEM.MEMBERS[id]);
    }
    catch (err) {
        return res.status(500).json({ error: err?.message || 'Internal error' });
    }
});
// Sell endpoint
app.post('/api/sell', requireAuth, (req, res) => {
    try {
        const memberId = req.body.memberId || req.body.member_id;
        const keys = Array.isArray(req.body.keys) ? req.body.keys.map(String) : [];
        if (!memberId)
            return res.status(400).json({ error: 'Missing memberId' });
        if (!keys.length)
            return res.status(400).json({ error: 'Missing keys' });
        const sold = [];
        const now = nowISO();
        for (const key of keys) {
            const item = MEM.KHO[key];
            if (!item)
                continue;
            const hist = {
                id: crypto.randomUUID(),
                key: item.key,
                account: item.account,
                provider_id: item.provider_id,
                name: item.name,
                address: item.address,
                amount_previous: item.amount_previous ?? 0,
                amount_current: item.amount_current ?? 0,
                total: item.total ?? item.amount_current ?? 0,
                nhapAt: item.nhapAt ?? item.created_at ?? null,
                xuatAt: now,
                soldAt: now,
                member_id: memberId,
                member_name: (MEM.MEMBERS[memberId]?.name) || null,
                employee_id: null,
                employee_username: null,
                raw: item.raw || null,
                created_at: now
            };
            MEM.HISTORY.push(hist);
            delete MEM.KHO[key];
            sold.push(hist);
        }
        return res.json({ ok: true, sold_count: sold.length, sold });
    }
    catch (err) {
        log('sell error', err?.message || err);
        return res.status(500).json({ error: err?.message || 'Internal error' });
    }
});
// History list & CSV export
app.get('/api/history', requireAuth, (req, res) => {
    try {
        const search = (req.query.search || '').toString().toLowerCase() || null;
        const limit = Number(req.query.limit || 100);
        const offset = Number(req.query.offset || 0);
        const exportMode = (req.query.export || '').toString().toLowerCase();
        let arr = MEM.HISTORY.slice().reverse(); // newest first
        if (search) {
            arr = arr.filter((r) => (String(r.name || '').toLowerCase().includes(search)
                || String(r.address || '').toLowerCase().includes(search)
                || String(r.account || '').toLowerCase().includes(search)
                || String(r.member_name || '').toLowerCase().includes(search)));
        }
        const slice = arr.slice(offset, offset + limit);
        if (exportMode === 'csv') {
            const cols = ['id', 'key', 'account', 'provider_id', 'name', 'address', 'amount_previous', 'amount_current', 'total', 'soldAt', 'member_name', 'employee_username'];
            const escape = (v) => {
                if (v == null)
                    return '';
                const s = String(v);
                if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r'))
                    return `"${s.replace(/"/g, '""')}"`;
                return s;
            };
            const header = cols.join(',');
            const lines = slice.map((r) => cols.map(c => escape(r[c])).join(','));
            const csv = [header, ...lines].join('\r\n');
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="history-${Date.now()}.csv"`);
            return res.send(csv);
        }
        return res.json(slice);
    }
    catch (err) {
        log('history error', err?.message || err);
        return res.status(500).json({ error: err?.message || 'Internal error' });
    }
});
// Export Excel of current KHO/filtered
app.get('/api/export-excel', requireAuth, async (req, res) => {
    try {
        const fromAmount = req.query.fromAmount ? safeNumber(req.query.fromAmount) : null;
        const toAmount = req.query.toAmount ? safeNumber(req.query.toAmount) : null;
        let arr = Object.values(MEM.KHO || {});
        if (fromAmount != null)
            arr = arr.filter((r) => safeNumber(r.total) >= fromAmount);
        if (toAmount != null)
            arr = arr.filter((r) => safeNumber(r.total) <= toAmount);
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('KHO');
        ws.columns = [
            { header: 'Key', key: 'key', width: 28 },
            { header: 'Account', key: 'account', width: 20 },
            { header: 'Provider', key: 'provider_id', width: 14 },
            { header: 'Name', key: 'name', width: 30 },
            { header: 'Address', key: 'address', width: 40 },
            { header: 'Amount Current', key: 'amount_current', width: 18 },
            { header: 'Total', key: 'total', width: 18 },
            { header: 'NhapAt', key: 'nhapAt', width: 22 }
        ];
        arr.forEach((r) => {
            ws.addRow({
                key: r.key,
                account: r.account,
                provider_id: r.provider_id,
                name: r.name,
                address: r.address,
                amount_current: safeNumber(r.amount_current),
                total: safeNumber(r.total),
                nhapAt: r.nhapAt
            });
        });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="kho-${Date.now()}.xlsx"`);
        await wb.xlsx.write(res);
        res.end();
    }
    catch (err) {
        log('export-excel error', err?.message || err);
        return res.status(500).json({ error: err?.message || 'Internal error' });
    }
});
// Simple static index fallback
app.get('/', (req, res) => res.sendFile('public/index.html', { root: process.cwd() }));
// Start server
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
    log(`Server listening on port ${PORT} (SKIP_AUTH=${SKIP_AUTH})`);
});
//# sourceMappingURL=server.js.map