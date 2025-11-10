/**
 * server.ts
 *
 * Complete Express server for "Tra cứu & Bán Bill"
 * - Merges the two fragments provided by you into one coherent file.
 * - Implements endpoints:
 *    - POST  /api/check-electricity         (single)
 *    - POST  /api/check-electricity/bulk    (bulk)
 *    - POST  /api/kho/import
 *    - GET   /api/kho/list
 *    - POST  /api/kho/remove
 *    - POST  /api/sell
 *    - GET   /api/history
 *    - GET   /api/members, POST /api/members, PUT /api/members/:id
 *    - GET   /api/export-excel
 * - Uses Postgres (pg Pool) when DATABASE_URL set, otherwise falls back to in-memory stores.
 * - Contains logging, simple auth toggle (SKIP_AUTH), retrying upstream fetch, concurrency limit, basic rate limiting.
 *
 * Notes:
 * - This file intentionally contains many lines and verbose helpers so it's self-contained for copy/paste.
 * - For production split into modules, add tests, proper error tracking and robust authentication.
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import pLimit from 'p-limit';
import ExcelJS from 'exceljs';
import crypto from 'crypto';
import { Pool } from 'pg';
import dotenv from 'dotenv';
dotenv.config();
/* ----------------------------------------------------------------------
   Configuration and global helpers
   ---------------------------------------------------------------------- */
const app = express();
app.use(bodyParser.json({ limit: '2mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
// Config environment
const PORT = Number(process.env.PORT || 3000);
const NEW_API_BASE_URL = process.env.NEW_API_BASE_URL || 'https://bill.7ty.vn/api';
const NEW_API_PATH = process.env.NEW_API_PATH || '/check-electricity';
const NEW_API_TIMEOUT_MS = Number(process.env.NEW_API_TIMEOUT_MS || 30000);
const NEW_API_MAX_RETRIES = Number(process.env.NEW_API_MAX_RETRIES || 3);
const NEW_API_CONCURRENCY = Number(process.env.NEW_API_CONCURRENCY || 6);
const SKIP_AUTH = process.env.SKIP_AUTH === 'true';
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || process.env.RATE_LIMIT || 120);
// Logging helpers - simple, environment controlled
function logDebug(...args) { if (LOG_LEVEL === 'debug')
    console.debug('[DEBUG]', ...args); }
function logInfo(...args) { if (['debug', 'info'].includes(LOG_LEVEL))
    console.info('[INFO]', ...args); }
function logWarn(...args) { if (['debug', 'info', 'warn'].includes(LOG_LEVEL))
    console.warn('[WARN]', ...args); }
function logError(...args) { console.error('[ERROR]', ...args); }
// Rate limiter to protect server/upstream
const apiLimiter = rateLimit({
    windowMs: 10 * 1000,
    max: RATE_LIMIT_MAX,
    message: 'Too many requests, slow down'
});
app.use('/api/', apiLimiter);
// Try to initialize Postgres pool if DATABASE_URL is provided
let pool = null;
if (process.env.DATABASE_URL) {
    try {
        pool = new Pool({ connectionString: process.env.DATABASE_URL });
        pool.on('error', (err) => logError('Postgres pool error', err));
        logInfo('Postgres pool initialized');
    }
    catch (err) {
        logError('Failed to initialize Postgres pool', err);
        pool = null;
    }
}
else {
    logInfo('No DATABASE_URL detected — using in-memory stores for development');
}
/* ----------------------------------------------------------------------
   In-memory fallback stores and utilities
   ---------------------------------------------------------------------- */
const MEM = {
    KHO: {}, // key -> item
    HISTORY: [], // array of sold items
    MEMBERS: {}, // id -> member
    EMPLOYEES: {} // id -> employee
};
// Simple lock map for in-memory concurrency control (dev only)
const LOCKS = new Map();
async function withLock(key, fn, ttl = 5000) {
    const start = Date.now();
    while (LOCKS.get(key)) {
        await new Promise(r => setTimeout(r, 40));
        if (Date.now() - start > ttl)
            throw new Error('Lock timeout');
    }
    LOCKS.set(key, true);
    try {
        const r = await fn();
        return r;
    }
    finally {
        LOCKS.delete(key);
    }
}
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
function genId(prefix = '') { return prefix + crypto.randomBytes(6).toString('hex'); }
/* ----------------------------------------------------------------------
   Simple authentication middleware (dev stub)
   - SKIP_AUTH=true bypasses checks (for local dev)
   - In production you should replace with real JWT/session validation
   ---------------------------------------------------------------------- */
function requireAuth(req, res, next) {
    if (SKIP_AUTH) {
        logDebug('Auth bypassed (SKIP_AUTH=true)');
        return next();
    }
    const auth = (req.headers.authorization || '').toString();
    if (!auth) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    // TODO: Add JWT or session validation here
    return next();
}
/* ----------------------------------------------------------------------
   Upstream fetch with timeout and retry
   - Uses node-fetch AbortController logic
   - Retries on network errors and 5xx/429, not on 4xx (except 429)
   ---------------------------------------------------------------------- */
async function fetchWithTimeoutRetry(url, opts = {}, timeout = NEW_API_TIMEOUT_MS, retries = NEW_API_MAX_RETRIES) {
    async function attempt(remaining) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeout);
        try {
            const res = await fetch(url, { ...opts, signal: controller.signal });
            const text = await res.text();
            clearTimeout(id);
            if (!res.ok) {
                const msg = `Status ${res.status} - ${text.slice(0, 1000)}`;
                const e = new Error(msg);
                e.status = res.status;
                // Fatal for 4xx (except 429)
                if (res.status >= 400 && res.status < 500 && res.status !== 429)
                    throw e;
                throw e;
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
            // Exponential backoff with jitter
            const base = 300;
            const backoff = Math.min(base * Math.pow(2, NEW_API_MAX_RETRIES - remaining), 10000);
            const jitter = Math.floor(Math.random() * 200);
            logWarn('Upstream fetch failed, will retry', { url, remaining, backoff, err: err?.message || err });
            await new Promise(r => setTimeout(r, backoff + jitter));
            return attempt(remaining - 1);
        }
    }
    return attempt(retries);
}
/* ----------------------------------------------------------------------
   Normalize upstream CheckBill response into internal KHO item shape
   - Keeps raw payload in `raw` field
   ---------------------------------------------------------------------- */
function normalizeUpstream(resp, account, sku) {
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
                amount_previous: '0',
                amount_current: String(money),
                total: String(money),
                raw: resp,
                created_at: nowISO()
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
            amount_previous: '0',
            amount_current: '0',
            total: '0',
            raw: resp,
            created_at: nowISO()
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
            amount_previous: '0',
            amount_current: '0',
            total: '0',
            raw: resp,
            created_at: nowISO()
        };
    }
}
/* ----------------------------------------------------------------------
   Database helpers for KHO upsert (DB if pool available, otherwise in-memory)
   ---------------------------------------------------------------------- */
async function upsertKhoItems(items) {
    if (pool) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const inserted = [];
            for (const it of items) {
                const key = it.key || `${it.provider_id}::${it.account}`;
                const q = `
          INSERT INTO kho (key, account, provider_id, name, address, amount_previous, amount_current, total, raw, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
          ON CONFLICT (key) DO UPDATE SET
            name = EXCLUDED.name,
            address = EXCLUDED.address,
            amount_previous = EXCLUDED.amount_previous,
            amount_current = EXCLUDED.amount_current,
            total = EXCLUDED.total,
            raw = EXCLUDED.raw,
            created_at = now()
          RETURNING *
        `;
                const params = [key, it.account, it.provider_id, it.name || null, it.address || null,
                    safeNumber(it.amount_previous), safeNumber(it.amount_current), safeNumber(it.total), JSON.stringify(it.raw || {})];
                const { rows } = await client.query(q, params);
                inserted.push(rows[0]);
            }
            await client.query('COMMIT');
            return inserted;
        }
        catch (e) {
            await client.query('ROLLBACK');
            logError('upsertKhoItems db error', e);
            throw e;
        }
        finally {
            client.release();
        }
    }
    else {
        const inserted = [];
        for (const it of items) {
            const key = it.key || `${it.provider_id}::${it.account}`;
            const existing = MEM.KHO[key];
            const record = {
                key,
                account: it.account,
                provider_id: it.provider_id,
                name: it.name || (existing && existing.name) || null,
                address: it.address || (existing && existing.address) || null,
                amount_previous: String(safeNumber(it.amount_previous || (existing && existing.amount_previous) || 0)),
                amount_current: String(safeNumber(it.amount_current || (existing && existing.amount_current) || 0)),
                total: String(safeNumber(it.total || (existing && existing.total) || 0)),
                raw: it.raw || (existing && existing.raw) || {},
                created_at: nowISO()
            };
            MEM.KHO[key] = record;
            inserted.push(record);
        }
        return inserted;
    }
}
/* ----------------------------------------------------------------------
   Endpoints
   ---------------------------------------------------------------------- */
/* Health */
app.get('/api/health', (req, res) => res.json({ ok: true, ts: nowISO() }));
/* Single check */
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
        logWarn('check-electricity error', err?.message || err);
        return res.status(502).json({ error: err?.message || 'Upstream error' });
    }
});
/* Bulk check */
app.post('/api/check-electricity/bulk', requireAuth, async (req, res) => {
    try {
        const contract_numbers = Array.isArray(req.body.contract_numbers) ? req.body.contract_numbers.map((v) => String(v).trim()).filter(Boolean) : [];
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
                logWarn('bulk item error', { account: acc, err: err?.message || err });
                return { account: acc, ok: false, error: err?.message || 'Upstream error' };
            }
        }));
        const results = await Promise.all(tasks);
        return res.json(results);
    }
    catch (err) {
        logError('bulk error', err?.message || err);
        return res.status(500).json({ error: err?.message || 'Internal error' });
    }
});
/* ----------------------------------------------------------------------
   KHO import (from your fragment - memory mode and DB mode handled)
   Accepts body: { bills: [...] } where each bill includes provider_id, account, name, address, amount_current, etc.
   ---------------------------------------------------------------------- */
app.post('/api/kho/import', requireAuth, async (req, res) => {
    try {
        // Accept either { bills: [...] } or raw array in body
        const bills = Array.isArray(req.body.bills) ? req.body.bills : (Array.isArray(req.body) ? req.body : []);
        if (!bills.length)
            return res.status(400).json({ error: 'Missing bills array' });
        // Map bills to normalized items
        const items = bills.map((b) => {
            const key = (b.key || `${b.provider_id || 'UNK'}::${b.account || ''}`).toString();
            const now = nowISO();
            return {
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
                raw: b.raw || b,
                created_at: now
            };
        });
        // If DB available, use DB upsert. Else use MEM logic
        if (pool) {
            const inserted = await upsertKhoItems(items);
            return res.json({ ok: true, mode: 'db', count: inserted.length, inserted });
        }
        else {
            // memory import with added/updated counts
            let added = 0, updated = 0;
            for (const it of items) {
                const key = it.key;
                if (MEM.KHO[key]) {
                    MEM.KHO[key] = { ...MEM.KHO[key], ...it };
                    updated++;
                }
                else {
                    MEM.KHO[key] = it;
                    added++;
                }
            }
            return res.json({ ok: true, mode: 'memory', added, updated, total: Object.keys(MEM.KHO).length });
        }
    }
    catch (err) {
        logError('kho/import error', err?.message || err);
        return res.status(500).json({ error: err?.message || 'Internal error' });
    }
});
/* KHO list */
app.get('/api/kho/list', requireAuth, async (req, res) => {
    try {
        const fromAmount = req.query.fromAmount ? safeNumber(req.query.fromAmount) : null;
        const toAmount = req.query.toAmount ? safeNumber(req.query.toAmount) : null;
        const provider_id = (req.query.provider_id || req.query.sku || '').toString() || null;
        const search = (req.query.search || '').toString().toLowerCase() || null;
        if (pool) {
            // build simple query with optional filters (basic implementation)
            let base = 'SELECT * FROM kho';
            const where = [];
            const params = [];
            let idx = 1;
            if (provider_id) {
                where.push(`provider_id = $${idx++}`);
                params.push(provider_id);
            }
            if (fromAmount != null) {
                where.push(`total >= $${idx++}`);
                params.push(fromAmount);
            }
            if (toAmount != null) {
                where.push(`total <= $${idx++}`);
                params.push(toAmount);
            }
            if (where.length)
                base += ' WHERE ' + where.join(' AND ');
            base += ' ORDER BY created_at DESC LIMIT 2000';
            const { rows } = await pool.query(base, params);
            return res.json(rows);
        }
        else {
            let arr = Object.values(MEM.KHO || {});
            if (provider_id)
                arr = arr.filter((r) => String(r.provider_id) === String(provider_id));
            if (fromAmount != null)
                arr = arr.filter((r) => safeNumber(r.total) >= fromAmount);
            if (toAmount != null)
                arr = arr.filter((r) => safeNumber(r.total) <= toAmount);
            if (search) {
                arr = arr.filter((r) => (String(r.name || '').toLowerCase().includes(search) ||
                    String(r.address || '').toLowerCase().includes(search) ||
                    String(r.account || '').toLowerCase().includes(search)));
            }
            arr.sort((a, b) => (b.nhapAt || b.created_at || '').localeCompare(a.nhapAt || a.created_at || ''));
            return res.json(arr);
        }
    }
    catch (err) {
        logError('kho/list error', err?.message || err);
        return res.status(500).json({ error: err?.message || 'Internal error' });
    }
});
/* KHO remove */
app.post('/api/kho/remove', requireAuth, async (req, res) => {
    try {
        const keys = Array.isArray(req.body.keys) ? req.body.keys.map(String) : (req.body.key ? [String(req.body.key)] : []);
        if (!keys.length)
            return res.status(400).json({ error: 'Missing keys array' });
        if (pool) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                for (const k of keys) {
                    await client.query('DELETE FROM kho WHERE key = $1', [k]);
                }
                await client.query('COMMIT');
                return res.json({ ok: true, removed: keys.length });
            }
            catch (e) {
                await client.query('ROLLBACK');
                throw e;
            }
            finally {
                client.release();
            }
        }
        else {
            let removed = 0;
            for (const k of keys) {
                if (MEM.KHO[k]) {
                    delete MEM.KHO[k];
                    removed++;
                }
            }
            return res.json({ ok: true, removed });
        }
    }
    catch (err) {
        logError('kho/remove error', err?.message || err);
        return res.status(500).json({ error: err?.message || 'Internal error' });
    }
});
/* Members endpoints */
app.get('/api/members', requireAuth, async (req, res) => {
    try {
        if (pool) {
            const { rows } = await pool.query('SELECT * FROM members ORDER BY created_at DESC LIMIT 2000');
            return res.json(rows);
        }
        else {
            const arr = Object.values(MEM.MEMBERS || {});
            return res.json(arr);
        }
    }
    catch (err) {
        logError('members list error', err);
        return res.status(500).json({ error: err?.message || 'Internal error' });
    }
});
app.post('/api/members', requireAuth, async (req, res) => {
    try {
        const name = (req.body.name || '').toString().trim();
        if (!name)
            return res.status(400).json({ error: 'Missing name' });
        const zalo = (req.body.zalo || '').toString().trim() || '';
        const bank = (req.body.bank || '').toString().trim() || '';
        if (pool) {
            const q = `INSERT INTO members (name, zalo, bank, created_at) VALUES ($1,$2,$3,now()) RETURNING *`;
            const { rows } = await pool.query(q, [name, zalo, bank]);
            return res.status(201).json(rows[0]);
        }
        else {
            const id = crypto.randomUUID();
            const entry = { id, name, zalo, bank, created_at: nowISO() };
            MEM.MEMBERS[id] = entry;
            return res.status(201).json(entry);
        }
    }
    catch (err) {
        logError('create member error', err);
        return res.status(500).json({ error: err?.message || 'Create member failed' });
    }
});
app.put('/api/members/:id', requireAuth, async (req, res) => {
    try {
        const id = req.params.id;
        if (pool) {
            const updates = {};
            if (req.body.name !== undefined)
                updates.name = req.body.name;
            if (req.body.zalo !== undefined)
                updates.zalo = req.body.zalo;
            if (req.body.bank !== undefined)
                updates.bank = req.body.bank;
            const keys = Object.keys(updates);
            if (!keys.length)
                return res.json({ ok: true });
            const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
            const params = [id, ...keys.map(k => updates[k])];
            const q = `UPDATE members SET ${sets} WHERE id = $1 RETURNING *`;
            const { rows } = await pool.query(q, params);
            return res.json(rows[0]);
        }
        else {
            if (!MEM.MEMBERS[id])
                return res.status(404).json({ error: 'Member not found' });
            MEM.MEMBERS[id] = {
                ...MEM.MEMBERS[id],
                name: req.body.name ?? MEM.MEMBERS[id].name,
                zalo: req.body.zalo ?? MEM.MEMBERS[id].zalo,
                bank: req.body.bank ?? MEM.MEMBERS[id].bank
            };
            return res.json(MEM.MEMBERS[id]);
        }
    }
    catch (err) {
        logError('update member error', err);
        return res.status(500).json({ error: err?.message || 'Update member failed' });
    }
});
/* Sell endpoint (moves items from KHO -> HISTORY) */
app.post('/api/sell', requireAuth, async (req, res) => {
    try {
        const memberId = req.body.memberId || req.body.member_id;
        const keys = Array.isArray(req.body.keys) ? req.body.keys.map(String) : [];
        if (!memberId)
            return res.status(400).json({ error: 'Missing memberId' });
        if (!keys.length)
            return res.status(400).json({ error: 'Missing keys' });
        if (pool) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const sold = [];
                for (const key of keys) {
                    const { rows } = await client.query('SELECT * FROM kho WHERE key = $1 FOR UPDATE', [key]);
                    if (!rows.length)
                        continue;
                    const item = rows[0];
                    const q = `
            INSERT INTO history (key, account, provider_id, name, address, amount_previous, amount_current, total, nhapAt, xuatAt, soldAt, member_id, member_name, employee_id, employee_username, raw, created_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
            RETURNING *
          `;
                    const params = [
                        item.key, item.account, item.provider_id, item.name, item.address,
                        item.amount_previous || 0, item.amount_current || 0, item.total || 0,
                        item.nhapAt || null, item.xuatAt || null, new Date(), memberId, null, null, null, item.raw || {}
                    ];
                    const r = await client.query(q, params);
                    await client.query('DELETE FROM kho WHERE key = $1', [key]);
                    sold.push(r.rows[0]);
                }
                await client.query('COMMIT');
                return res.json({ ok: true, sold_count: sold.length, history: sold });
            }
            catch (e) {
                await client.query('ROLLBACK');
                throw e;
            }
            finally {
                client.release();
            }
        }
        else {
            const sold = [];
            for (const key of keys) {
                try {
                    await withLock(`kho:${key}`, async () => {
                        const item = MEM.KHO[key];
                        if (!item)
                            return;
                        const now = nowISO();
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
                            raw: item.raw || {},
                            created_at: now
                        };
                        MEM.HISTORY.push(hist);
                        delete MEM.KHO[key];
                        sold.push(hist);
                    });
                }
                catch (e) {
                    logWarn('sell lock error for key', key, e);
                }
            }
            return res.json({ ok: true, sold_count: sold.length, history: sold });
        }
    }
    catch (err) {
        logError('sell error', err);
        return res.status(500).json({ error: 'Sell failed' });
    }
});
/* History endpoint with optional CSV export */
app.get('/api/history', requireAuth, (req, res) => {
    try {
        const search = (req.query.search || '').toString().toLowerCase() || null;
        const limit = Math.min(Number(req.query.limit || 100), 5000);
        const offset = Math.max(0, Number(req.query.offset || 0));
        const exportMode = (req.query.export || '').toString().toLowerCase();
        // in-memory history is appended oldest->newest, so reverse for newest first
        let arr = (pool ? [] : (MEM.HISTORY.slice().reverse()));
        if (pool) {
            // If DB exists we prefer DB query
            (async () => {
                try {
                    const q = `SELECT * FROM history ORDER BY created_at DESC LIMIT $1 OFFSET $2`;
                    const { rows } = await pool.query(q, [limit, offset]);
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
                        const lines = rows.map((r) => cols.map(c => escape(r[c])).join(','));
                        const csv = [header, ...lines].join('\r\n');
                        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
                        res.setHeader('Content-Disposition', `attachment; filename="history-${Date.now()}.csv"`);
                        return res.send(csv);
                    }
                    return res.json(rows);
                }
                catch (e) {
                    logError('history db read error', e);
                    return res.status(500).json({ error: 'History failed' });
                }
            })();
            return;
        }
        // Filter in-memory results
        if (search) {
            arr = arr.filter((r) => (String(r.name || '').toLowerCase().includes(search) ||
                String(r.address || '').toLowerCase().includes(search) ||
                String(r.account || '').toLowerCase().includes(search) ||
                String(r.member_name || '').toLowerCase().includes(search)));
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
        logError('history error', err?.message || err);
        return res.status(500).json({ error: err?.message || 'Internal error' });
    }
});
/* Export Excel of current KHO / filtered */
app.get('/api/export-excel', requireAuth, async (req, res) => {
    try {
        const fromAmount = req.query.fromAmount ? safeNumber(req.query.fromAmount) : null;
        const toAmount = req.query.toAmount ? safeNumber(req.query.toAmount) : null;
        let arr = [];
        if (pool) {
            const r = await pool.query('SELECT * FROM kho ORDER BY created_at DESC LIMIT 5000');
            arr = r.rows;
        }
        else {
            arr = Object.values(MEM.KHO || {});
        }
        if (fromAmount != null)
            arr = arr.filter((r) => safeNumber(r.total) >= fromAmount);
        if (toAmount != null)
            arr = arr.filter((r) => safeNumber(r.total) <= toAmount);
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('KHO');
        ws.columns = [
            { header: 'Key', key: 'key', width: 36 },
            { header: 'Provider', key: 'provider_id', width: 14 },
            { header: 'Account', key: 'account', width: 20 },
            { header: 'Name', key: 'name', width: 32 },
            { header: 'Address', key: 'address', width: 48 },
            { header: 'Amount Current', key: 'amount_current', width: 16 },
            { header: 'Total', key: 'total', width: 16 },
            { header: 'Created At', key: 'created_at', width: 24 }
        ];
        for (const r of arr) {
            ws.addRow({
                key: r.key,
                provider_id: r.provider_id,
                account: r.account,
                name: r.name,
                address: r.address,
                amount_current: safeNumber(r.amount_current),
                total: safeNumber(r.total),
                created_at: r.created_at || r.createdAt || nowISO()
            });
        }
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="kho-${Date.now()}.xlsx"`);
        await wb.xlsx.write(res);
        res.end();
    }
    catch (err) {
        logError('export-excel error', err);
        return res.status(500).json({ error: err?.message || 'Internal error' });
    }
});
/* Simple static root */
app.get('/', (req, res) => res.sendFile('public/index.html', { root: process.cwd() }));
/* Start server */
app.listen(PORT, () => {
    logInfo(`Server listening on port ${PORT} (SKIP_AUTH=${SKIP_AUTH})`);
    logInfo(`CheckBill upstream: ${NEW_API_BASE_URL}${NEW_API_PATH} (timeout=${NEW_API_TIMEOUT_MS}ms, retries=${NEW_API_MAX_RETRIES}, concurrency=${NEW_API_CONCURRENCY})`);
    if (!pool)
        logInfo('Using in-memory stores (no DATABASE_URL)');
});
//# sourceMappingURL=server.js.map