/* public/app.js
   Complete client-side application logic for "Tra cứu & Bán Bill"
   Combined from user-provided parts 1-4 and extended for robustness.
   Responsibilities:
   - Bulk lookup (/api/check-electricity/bulk)
   - KHO import/list/remove (/api/kho/*)
   - Sell (/api/sell)
   - History (/api/history)
   - Members CRUD (/api/members)
   - Export / copy / pagination / sorting / column toggles / list & grid views
   Notes:
   - Keep index.html and style.css element IDs in sync with this script.
   - Expected server endpoints under /api/*.
*/

document.addEventListener('DOMContentLoaded', () => {
  // --- Utilities ---
  const $ = id => document.getElementById(id);
  const cls = (el, c, on = true) => el && el.classList[on ? 'add' : 'remove'](c);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const toNumber = v => Number((v ?? '').toString().replace(/[^\d.-]/g, '')) || 0;

  function safeAmount(v) {
    if (v === undefined || v === null) return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : parseInt((v + '').replace(/\D/g, ''), 10) || 0;
  }

  function fmtMoney(v) {
    const n = toNumber(v);
    if (!Number.isFinite(n) || n === 0) return '0 ₫';
    return n.toLocaleString('vi-VN') + ' ₫';
  }

  function fmtDate(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return d.toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch {
      return iso;
    }
  }

  function jsonSafe(obj) {
    try { return JSON.stringify(obj); } catch { return String(obj); }
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  // --- State ---
  let currentUser = null;
  let allRows = [];        // canonical normalized rows (source of truth)
  let filteredRows = [];   // rows after search/hideZero
  let displayMode = 'list';// 'list' or 'grid'
  let sortKey = 'index';
  let sortDir = 1;         // 1 asc or -1 desc
  let pagination = { rowsPerPage: 15, currentPage: 1 };

  // --- DOM elements ---
  const providerEl = $('provider');
  const accountsEl = $('accounts');
  const filterDupBtn = $('filterDupBtn');
  const lookupBtn = $('lookupBulkBtn');
  const khoImportBtn = $('khoImportBtn');
  const khoListBtn = $('khoListBtn');
  const khoRemoveBtn = $('khoRemoveBtn');
  const memberAddBtn = $('memberAddBtn');
  const memberEditBtn = $('memberEditBtn');
  const memberViewBtn = $('memberViewBtn');
  const memberSearch = $('memberSearch');
  const memberSelect = $('memberSelect');
  const targetFrom = $('targetFrom');
  const targetTo = $('targetTo');
  const pickBtn = $('pickBtn');
  const sellBtn = $('sellBtn');
  const historyBtn = $('historyBtn');

  const searchInput = $('searchInput');
  const hideZeroToggle = $('hideZeroToggle');
  const exportBtn = $('exportCsvBtn');
  const copyBtn = $('copyBtn');
  const selectAllCb = $('selectAllCb');

  const rowsPerPageEl = $('rowsPerPage');
  const prevPageBtn = $('prevPageBtn');
  const nextPageBtn = $('nextPageBtn');
  const pageInfoEl = $('pageInfo');
  const viewListBtn = $('viewListBtn');
  const viewGridBtn = $('viewGridBtn');

  const resultState = $('resultState');
  const listContainer = $('listContainer');
  const gridContainer = $('gridContainer');
  const resultTable = $('resultTable');
  const thead = resultTable ? resultTable.querySelector('thead') : null;
  const tbody = resultTable ? resultTable.querySelector('tbody') : null;
  const tfoot = resultTable ? resultTable.querySelector('tfoot') : null;
  const sumTotalEl = $('sumTotal');

  const colToggles = Array.from(document.querySelectorAll('.col-options input[data-col]'));

  // --- UI helpers ---
  function showStatus(msg, type = 'info') {
    const el = $('status');
    if (!el) return;
    el.textContent = msg;
    el.className = 'alert ' + (type === 'warn' ? 'alert-danger' : 'alert-success') + ' shadow-sm';
    el.classList.remove('d-none');
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.add('d-none'), 3000);
  }

  function setButtonLoading(btn, loading) {
    if (!btn) return;
    if (loading) {
      btn.disabled = true;
      btn.classList.add('is-loading');
    } else {
      btn.disabled = false;
      btn.classList.remove('is-loading');
    }
  }

  function showLoadingState(msg) {
    if (!resultState) return;
    resultState.innerHTML = `<div class="spinner-border text-primary" role="status" style="width:3rem;height:3rem"><span class="visually-hidden">Loading</span></div><p class="h5 mt-3">${escapeHtml(msg)}</p>`;
    resultState.classList.remove('d-none');
    listContainer && listContainer.classList.add('d-none');
    gridContainer && gridContainer.classList.add('d-none');
  }

  function hideResultState() {
    if (!resultState) return;
    resultState.classList.add('d-none');
    resultState.innerHTML = '';
  }

  function showEmptyState(msg) {
    if (!resultState) return;
    resultState.innerHTML = `<i class="state-icon bx bx-data"></i><p class="h5 mt-3 state-message">${escapeHtml(msg)}</p>`;
    resultState.classList.remove('d-none');
    listContainer && listContainer.classList.add('d-none');
    gridContainer && gridContainer.classList.add('d-none');
  }

  function apiGet(path) {
    return fetch('/api' + path, { cache: 'no-store' }).then(async res => {
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `Status ${res.status}`);
      }
      return res.json();
    });
  }

  function apiPost(path, body) {
    return fetch('/api' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(async res => {
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `Status ${res.status}`);
      }
      return res.json();
    });
  }

  // --- Normalization helpers ---
  // Normalize various upstream/raw shapes into { key, provider_id, account, name, address, amount_previous, amount_current, total, nhapAt, xuatAt, memberName, employee_username, raw }
  function normalizeUpstreamItem(sku, account, upstream) {
    const raw = upstream || {};
    const out = {};
    out.account = account || raw.account || raw.contract_number || raw.cust || '';
    out.provider_id = sku || raw.sku || raw.provider || raw.provider_id || '';
    out.amount_previous = safeAmount(raw.amount_previous ?? raw.prev ?? raw.previous ?? 0);
    out.amount_current = safeAmount(raw.amount_current ?? raw.curr ?? raw.current ?? raw.amount ?? 0);
    out.total = safeAmount(raw.total ?? raw.amount_current ?? raw.amount ?? out.amount_current);
    out.name = (raw.name || raw.customer || raw.cust_name || '').toString().trim();
    out.address = (raw.address || raw.addr || raw.location || '').toString().trim();
    out.key = `${out.provider_id}::${out.account}`;
    out.nhapAt = raw.nhapAt || raw.created_at || null;
    out.xuatAt = raw.xuatAt || raw.xuat_at || null;
    out.memberName = raw.memberName || raw.member_name || raw.customer || '';
    out.employee_username = raw.employee_username || raw.sold_by || '';
    out.raw = raw;
    return out;
  }

  // compatible normalizeRow used by server responses
  function normalizeRow(item) {
    if (!item) return null;
    if (item.normalized) return item.normalized;
    // if item already has expected keys
    if (item.key && (item.total !== undefined || item.amount_current !== undefined)) return item;
    // if nested data from upstream
    if (item.data && item.data.data && Array.isArray(item.data.data.bills)) {
      const bill = item.data.data.bills[0] || {};
      const amount = safeAmount(bill.moneyAmount || 0);
      return {
        key: `${item.sku || item.provider_id || 'UNK'}::${item.account || item.contract_number || ''}`,
        provider_id: item.sku || item.provider_id || '',
        account: item.account || item.contract_number || '',
        name: bill.customerName || item.name || `(Mã ${item.account || item.contract_number || ''})`,
        address: bill.address || item.address || '',
        amount_current: String(amount),
        total: String(amount),
        amount_previous: '0',
        nhapAt: item.nhapAt || item.created_at || null,
        xuatAt: item.xuatAt || item.xuat_at || null,
        raw: item
      };
    }
    // fallback generic mapping
    return {
      key: item.key || `${item.provider_id || 'UNK'}::${item.account || item.contract_number || ''}`,
      provider_id: item.provider_id || item.sku || '',
      account: item.account || item.contract_number || '',
      name: item.name || `(Mã ${item.account || item.contract_number || ''})`,
      address: item.address || '',
      amount_current: String(item.amount_current || item.total || 0),
      total: String(item.total || item.amount_current || 0),
      amount_previous: String(item.amount_previous || 0),
      nhapAt: item.nhapAt || item.created_at || null,
      xuatAt: item.xuatAt || item.xuat_at || null,
      memberName: item.memberName || item.member_name || '',
      employee_username: item.employee_username || '',
      raw: item
    };
  }

  // --- Apply filters, sort, pagination, render ---
  function applyFiltersAndSort() {
    const q = (searchInput && searchInput.value || '').trim().toLowerCase();
    const hideZero = hideZeroToggle && hideZeroToggle.checked;

    filteredRows = allRows.filter(r => {
      if (hideZero && safeAmount(r.total) === 0) return false;
      if (!q) return true;
      const hay = `${r.key} ${r.account} ${r.name} ${r.address} ${r.memberName || ''} ${r.employee_username || ''}`.toLowerCase();
      return hay.includes(q);
    }).map((r, idx) => Object.assign({ index: idx + 1 }, r));

    // determine type for sort
    let sortType = 'text';
    if (thead) {
      const activeTh = thead.querySelector(`th[data-col="${sortKey}"]`);
      sortType = activeTh ? (activeTh.dataset.sort || 'text') : 'text';
    }
    filteredRows.sort((a, b) => {
      let va = a[sortKey], vb = b[sortKey];
      if (sortKey === 'index') {
        va = allRows.indexOf(a); vb = allRows.indexOf(b);
      }
      if (sortType === 'money') return sortDir * (safeAmount(va) - safeAmount(vb));
      if (sortType === 'date') return sortDir * ((new Date(va).getTime() || 0) - (new Date(vb).getTime() || 0));
      return sortDir * (`${va || ''}`).localeCompare(`${vb || ''}`, 'vi', { sensitivity: 'base' });
    });

    renderCurrent();
  }

  function renderCurrent() {
    const rowsPerPage = Number(rowsPerPageEl?.value || pagination.rowsPerPage || 15);
    const totalRows = filteredRows.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / rowsPerPage));
    pagination.rowsPerPage = rowsPerPage;
    if (pagination.currentPage > totalPages) pagination.currentPage = totalPages;
    if (pagination.currentPage < 1) pagination.currentPage = 1;
    const start = (pagination.currentPage - 1) * rowsPerPage;
    const pageRows = filteredRows.slice(start, start + rowsPerPage);

    // update sum for page
    const pageTotal = pageRows.reduce((s, r) => s + safeAmount(r.total || r.amount_current || 0), 0);
    if (sumTotalEl) sumTotalEl.textContent = fmtMoney(pageTotal);

    // update page info
    if (pageInfoEl) pageInfoEl.textContent = `Trang ${pagination.currentPage} / ${totalPages}`;

    if (displayMode === 'list') {
      renderListPage(pageRows);
    } else {
      renderGridPage(pageRows);
    }

    // prev/next buttons
    if (prevPageBtn) prevPageBtn.disabled = pagination.currentPage <= 1;
    if (nextPageBtn) nextPageBtn.disabled = pagination.currentPage >= totalPages;
  }

  // --- Render list/grid functions (detailed) ---
  function updateSum(rows) {
    const sum = rows.reduce((s, r) => s + safeAmount(r.total), 0);
    if (sumTotalEl) sumTotalEl.textContent = fmtMoney(sum);
  }

  function renderListPage(rows) {
    if (!tbody || !resultTable) return;
    tbody.innerHTML = '';
    const startIdx = (pagination.currentPage - 1) * pagination.rowsPerPage;
    rows.forEach((r, i) => {
      const idx = startIdx + i + 1;
      const tr = document.createElement('tr');

      // select checkbox
      const tdSel = document.createElement('td');
      tdSel.dataset.col = 'select';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'form-check-input';
      cb.dataset.key = r.key || r.id || '';
      tdSel.append(cb);
      tr.append(tdSel);

      const cells = [
        { col: 'index', text: idx },
        { col: 'name', text: r.name || '-' },
        { col: 'address', text: r.address || '-' },
        { col: 'account', text: r.account || '' },
        { col: 'prev', text: fmtMoney(r.amount_previous || r.prev || '0') },
        { col: 'curr', text: fmtMoney(r.amount_current || r.curr || '0') },
        { col: 'total', text: fmtMoney(r.total || r.amount_current || '0') },
        { col: 'nhap', text: fmtDate(r.nhapAt || r.nhapat || r.nhap || '') },
        { col: 'xuat', text: fmtDate(r.xuatAt || r.xuatat || r.xuat || '') },
        { col: 'member', text: r.memberName || r.membername || '' },
        { col: 'employee', text: r.employee_username || '' }
      ];

      cells.forEach(c => {
        const td = document.createElement('td');
        td.dataset.col = c.col;
        td.textContent = c.text;
        if (c.col === 'total') td.classList.add('money');
        tr.append(td);
      });

      tbody.append(tr);
    });

    resultTable.classList.remove('d-none');
    listContainer.classList.remove('d-none');
    gridContainer.classList.add('d-none');
    applyColumnToggles();
    updateSum(rows);

    // row checkbox toggles selected class
    tbody.querySelectorAll('input.form-check-input[data-key]').forEach(cb => {
      cb.addEventListener('change', () => {
        const tr = cb.closest('tr');
        if (cb.checked) tr.classList.add('selected'); else tr.classList.remove('selected');
      });
    });
  }

  function renderGridPage(rows) {
    gridContainer.innerHTML = '';
    rows.forEach(r => {
      const card = document.createElement('div');
      card.className = 'card grid-card shadow-sm animated-pop';
      const h = document.createElement('div');
      h.className = 'card-header';
      h.textContent = r.name || '(Không tên)';
      const b = document.createElement('div');
      b.className = 'card-body';
      const acc = document.createElement('p');
      acc.className = 'card-text';
      acc.textContent = `Mã KH: ${r.account || ''}`;
      const addr = document.createElement('p');
      addr.className = 'card-text truncate-2';
      addr.textContent = `Địa chỉ: ${r.address || ''}`;
      const total = document.createElement('div');
      total.className = 'card-total';
      total.textContent = fmtMoney(r.total || r.amount_current || 0);
      const meta = document.createElement('div');
      meta.className = 'card-footer';
      meta.innerHTML = `${r.nhapAt ? `<small>Nhập: ${fmtDate(r.nhapAt)}</small>` : ''}${r.xuatAt ? `<small class="d-block">Xuất: ${fmtDate(r.xuatAt)}</small>` : ''}${r.memberName ? `<small class="d-block">KHT: ${escapeHtml(r.memberName)}</small>` : ''}`;

      // action buttons container
      const actions = document.createElement('div');
      actions.className = 'mt-2 row-actions';
      actions.innerHTML = `<button class="btn btn-sm btn-outline-primary btn-copy-key" data-key="${escapeHtml(r.key)}" title="Sao chép key"><i class="bx bx-copy"></i></button>
                           <button class="btn btn-sm btn-outline-success btn-import-one" data-key="${escapeHtml(r.key)}" title="Nhập vào KHO"><i class="bx bx-import"></i></button>`;
      b.append(acc, addr, total, actions);
      card.append(h, b, meta);
      gridContainer.append(card);
    });

    listContainer.classList.add('d-none');
    gridContainer.classList.remove('d-none');

    // bind actions
    gridContainer.querySelectorAll('.btn-copy-key').forEach(b => b.addEventListener('click', async (e) => {
      const key = e.currentTarget.dataset.key;
      try { await navigator.clipboard.writeText(key); showStatus('Đã sao chép ' + key); } catch { showStatus('Không thể sao chép', 'warn'); }
    }));
    gridContainer.querySelectorAll('.btn-import-one').forEach(b => b.addEventListener('click', async (e) => {
      const key = e.currentTarget.dataset.key;
      const item = allRows.find(x => x.key === key);
      if (!item) return showStatus('Không tìm thấy item', 'warn');
      try {
        const res = await apiPost('/kho/import', { bills: [item] });
        showStatus(`Đã nhập 1 mục (${item.key})`);
      } catch (err) { showStatus('Import lỗi: ' + err.message, 'warn'); }
    }));
  }

  // --- Column toggles ---
  function applyColumnToggles() {
    if (!resultTable) return;
    colToggles.forEach(cb => {
      const col = cb.dataset.col;
      const checked = cb.checked;
      resultTable.querySelectorAll(`[data-col="${col}"]`).forEach(el => {
        if (checked) el.classList.remove('hidden'); else el.classList.add('hidden');
      });
    });
    if (tfoot) tfoot.classList.remove('d-none');
  }
  colToggles.forEach(inp => inp.addEventListener('change', applyColumnToggles));

  // --- Sorting via header ---
  if (thead) {
    thead.querySelectorAll('th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.col;
        if (!col) return;
        if (sortKey === col) sortDir *= -1; else { sortKey = col; sortDir = 1; }
        thead.querySelectorAll('th').forEach(t => t.classList.remove('sorted-asc', 'sorted-desc'));
        th.classList.add(sortDir === 1 ? 'sorted-asc' : 'sorted-desc');
        applyFiltersAndSort();
      });
    });
  }

  // --- Pagination controls ---
  rowsPerPageEl && rowsPerPageEl.addEventListener('change', () => { pagination.rowsPerPage = Number(rowsPerPageEl.value); pagination.currentPage = 1; renderCurrent(); });
  prevPageBtn && prevPageBtn.addEventListener('click', () => { if (pagination.currentPage > 1) { pagination.currentPage--; renderCurrent(); } });
  nextPageBtn && nextPageBtn.addEventListener('click', () => {
    const totalPages = Math.max(1, Math.ceil(filteredRows.length / (pagination.rowsPerPage || 15)));
    if (pagination.currentPage < totalPages) { pagination.currentPage++; renderCurrent(); }
  });

  // --- View toggles ---
  viewListBtn && viewListBtn.addEventListener('click', () => { displayMode = 'list'; viewListBtn.classList.add('active'); viewGridBtn.classList.remove('active'); renderCurrent(); });
  viewGridBtn && viewGridBtn.addEventListener('click', () => { displayMode = 'grid'; viewGridBtn.classList.add('active'); viewListBtn.classList.remove('active'); renderCurrent(); });

  // --- Search & hide zero ---
  searchInput && searchInput.addEventListener('input', () => { pagination.currentPage = 1; applyFiltersAndSort(); });
  hideZeroToggle && hideZeroToggle.addEventListener('change', () => { pagination.currentPage = 1; applyFiltersAndSort(); });

  // --- Copy visible rows (Part 3) ---
  copyBtn && copyBtn.addEventListener('click', async () => {
    try {
      const visibleCols = Array.from(document.querySelectorAll('.col-options input[data-col]')).filter(cb => cb.checked).map(cb => cb.dataset.col);
      const lines = filteredRows.map(r => {
        const parts = [];
        for (const col of visibleCols) {
          switch (col) {
            case 'index': parts.push(String(allRows.indexOf(r) + 1)); break;
            case 'name': parts.push(r.name || ''); break;
            case 'address': parts.push(r.address || ''); break;
            case 'account': parts.push(r.account || ''); break;
            case 'prev': parts.push(fmtMoney(r.amount_previous || '0')); break;
            case 'curr': parts.push(fmtMoney(r.amount_current || '0')); break;
            case 'total': parts.push(fmtMoney(r.total || '0')); break;
            case 'nhap': parts.push(fmtDate(r.nhapAt || '')); break;
            case 'xuat': parts.push(fmtDate(r.xuatAt || '')); break;
            case 'member': parts.push(r.memberName || ''); break;
            case 'employee': parts.push(r.employee_username || ''); break;
            default: parts.push(''); break;
          }
        }
        return parts.join('\t');
      }).join('\n');

      await navigator.clipboard.writeText(lines);
      showStatus('Đã sao chép vào clipboard', 'info');
    } catch (err) {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = lines || '';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showStatus('Đã sao chép (fallback)', 'info');
    }
  });

  // --- Export (server-side) ---
  exportBtn && exportBtn.addEventListener('click', () => {
    const from = encodeURIComponent(targetFrom?.value || '');
    const to = encodeURIComponent(targetTo?.value || '');
    const url = `/api/export-excel?fromAmount=${from}&toAmount=${to}&sortBy=${encodeURIComponent(sortKey)}&sortOrder=${encodeURIComponent(sortDir === 1 ? 'asc' : 'desc')}`;
    window.open(url, '_blank');
    showStatus('Bắt đầu tải Excel...', 'info');
  });

  // --- Bulk lookup (Part 1/3) ---
  lookupBtn && lookupBtn.addEventListener('click', async () => {
    const sku = providerEl?.value;
    const codes = (accountsEl?.value || '').split('\n').map(s => s.trim()).filter(Boolean);
    if (!codes.length) { showStatus('Vui lòng nhập mã hợp đồng (một mã mỗi dòng).', 'warn'); return; }
    setButtonLoading(lookupBtn, true);
    showLoadingState(`Đang tra cứu ${codes.length} mã...`);
    try {
      const resp = await fetch('/api/check-electricity/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contract_numbers: codes, sku })
      });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        throw new Error(txt || `Server lỗi ${resp.status}`);
      }
      const results = await resp.json();
      const rows = results.map((r, i) => {
        // r may be { ok, normalized, data, error, account }
        if (r.ok && r.normalized) return normalizeRow(r);
        if (r.ok && r.data && !r.normalized) {
          const norm = {
            key: `${sku}::${r.account}`,
            provider_id: sku,
            account: r.account,
            name: r.data?.data?.bills?.[0]?.customerName || `(Mã ${r.account})`,
            address: r.data?.data?.bills?.[0]?.address || '',
            amount_current: String(safeAmount(r.data?.data?.bills?.[0]?.moneyAmount || 0)),
            total: String(safeAmount(r.data?.data?.bills?.[0]?.moneyAmount || 0)),
            amount_previous: '0',
            raw: r.data
          };
          return norm;
        }
        // fallback error row
        return {
          key: `${sku}::${r.account || ('line' + i)}`,
          provider_id: sku,
          account: r.account || '',
          name: `(Mã ${r.account || (i+1)})`,
          address: r.error || 'Lỗi tra cứu',
          amount_current: '0',
          amount_previous: '0',
          total: '0',
          raw: r
        };
      });

      allRows = rows.map(normalizeRow);
      pagination.currentPage = 1;
      hideResultState();
      applyFiltersAndSort();
      showStatus(`Hoàn tất tra cứu ${allRows.length} mã`, 'info');
    } catch (err) {
      console.error('Lookup error', err);
      showStatus('Lỗi khi tra cứu: ' + (err.message || err), 'warn');
      showEmptyState('Lỗi khi tra cứu, kiểm tra console để biết chi tiết');
    } finally {
      setButtonLoading(lookupBtn, false);
    }
  });

  // --- KHO import selected (Part 3) ---
  khoImportBtn && khoImportBtn.addEventListener('click', async () => {
    if (!tbody) return showStatus('Không có kết quả để nhập', 'warn');
    const checked = Array.from(tbody.querySelectorAll('input[type=checkbox][data-key]:checked')).map(cb => cb.dataset.key);
    if (!checked.length) return showStatus('Chọn trước bill để nhập vào KHO', 'warn');
    const bills = checked.map(k => allRows.find(r => (r.key || r.id) === k)).filter(Boolean).map(r => ({ ...r, nhapAt: new Date().toISOString() }));
    setButtonLoading(khoImportBtn, true);
    try {
      const resp = await fetch('/api/kho/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bills })
      });
      if (!resp.ok) { const txt = await resp.text().catch(()=>''); throw new Error(txt || `Status ${resp.status}`); }
      const data = await resp.json();
      showStatus(`Đã nhập ${data.added || data.count || bills.length} bill vào KHO`, 'info');
    } catch (err) {
      showStatus('Lỗi nhập KHO: ' + (err.message || err), 'warn');
    } finally { setButtonLoading(khoImportBtn, false); }
  });

  // --- KHO list (Part 3) ---
  khoListBtn && khoListBtn.addEventListener('click', async () => {
    setButtonLoading(khoListBtn, true);
    showLoadingState('Đang tải KHO...');
    try {
      const resp = await fetch('/api/kho/list');
      if (!resp.ok) throw new Error(`Status ${resp.status}`);
      const data = await resp.json();
      allRows = data.map(normalizeRow);
      pagination.currentPage = 1;
      hideResultState();
      applyFiltersAndSort();
      showStatus(`KHO: ${allRows.length} bill`, 'info');
    } catch (err) {
      console.error('KHO list error', err);
      showEmptyState('Lỗi tải KHO: ' + (err.message || err));
    } finally {
      setButtonLoading(khoListBtn, false);
    }
  });

  // --- KHO remove selected (Part 4) ---
  khoRemoveBtn && khoRemoveBtn.addEventListener('click', async () => {
    if (!tbody) return showStatus('Không có kết quả để xóa', 'warn');
    const checked = Array.from(tbody.querySelectorAll('input[type=checkbox][data-key]:checked')).map(cb => cb.dataset.key);
    if (!checked.length) return showStatus('Chọn bill để xóa khỏi KHO', 'warn');
    if (!confirm(`Bạn chắc chắn muốn xóa ${checked.length} bill khỏi KHO?`)) return;
    setButtonLoading(khoRemoveBtn, true);
    try {
      const resp = await fetch('/api/kho/remove', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: checked })
      });
      if (!resp.ok) throw new Error(`Status ${resp.status}`);
      const data = await resp.json();
      showStatus(`Đã xóa ${data.removed || 0} bill khỏi KHO`, 'info');
      // refresh KHO view
      khoListBtn && khoListBtn.click();
    } catch (err) {
      showStatus('Lỗi xóa KHO: ' + (err.message || err), 'warn');
    } finally {
      setButtonLoading(khoRemoveBtn, false);
    }
  });

  // --- Members CRUD (Part 4) ---
  async function refreshMembers() {
    try {
      const resp = await fetch('/api/members');
      if (!resp.ok) throw new Error(`Status ${resp.status}`);
      const data = await resp.json();
      if (memberSelect) {
        memberSelect.innerHTML = '';
        data.forEach(m => {
          const o = new Option(`${m.name} (Z:${m.zalo || 'N/A'})`, m.id);
          memberSelect.add(o);
        });
      }
    } catch (err) {
      console.error('Members load error', err);
    }
  }

  memberAddBtn && memberAddBtn.addEventListener('click', async () => {
    const name = prompt('Tên Khách Hàng Thẻ:')?.trim();
    if (!name) return;
    const zalo = prompt('Zalo (tùy chọn):') || '';
    const bank = prompt('Ngân hàng (tùy chọn):') || '';
    try {
      const resp = await fetch('/api/members', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, zalo, bank })
      });
      if (!resp.ok) throw new Error(`Status ${resp.status}`);
      await refreshMembers();
      showStatus('Đã thêm Khách Hàng Thẻ', 'info');
    } catch (err) {
      showStatus('Lỗi thêm KHT: ' + (err.message || err), 'warn');
    }
  });

  memberEditBtn && memberEditBtn.addEventListener('click', async () => {
    const id = memberSelect?.value;
    if (!id) return showStatus('Chọn KHT để sửa', 'warn');
    const name = prompt('Tên mới:')?.trim(); if (!name) return;
    const zalo = prompt('Zalo mới:') || '';
    const bank = prompt('Ngân hàng mới:') || '';
    try {
      const resp = await fetch(`/api/members/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, zalo, bank })
      });
      if (!resp.ok) throw new Error(`Status ${resp.status}`);
      await refreshMembers();
      showStatus('Cập nhật KHT thành công', 'info');
    } catch (err) {
      showStatus('Lỗi cập nhật KHT: ' + (err.message || err), 'warn');
    }
  });

  memberViewBtn && memberViewBtn.addEventListener('click', async () => {
    try {
      const resp = await fetch('/api/members');
      if (!resp.ok) throw new Error(`Status ${resp.status}`);
      const data = await resp.json();
      alert('Danh sách Khách Hàng Thẻ:\n' + data.map(d => `- ${d.name} (Z:${d.zalo||'N/A'}, B:${d.bank||'N/A'})`).join('\n'));
    } catch (err) {
      showStatus('Lỗi tải KHT: ' + (err.message || err), 'warn');
    }
  });

  memberSearch && memberSearch.addEventListener('keydown', e => { if (e.key === 'Enter') refreshMembers(); });

  // --- Pick by target (Part 4) ---
  pickBtn && pickBtn.addEventListener('click', async () => {
    const from = Number(targetFrom.value || 0);
    const to = Number(targetTo.value || Infinity);
    if (!allRows || !allRows.length) return showStatus('Không có dữ liệu KHO để lọc', 'warn');

    // try server-side select-by-target then fallback to client filtering
    try {
      const resp = await fetch('/api/select-by-target', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: from })
      });
      if (resp.ok) {
        const data = await resp.json();
        const keys = data.keys || [];
        allRows = allRows.filter(r => keys.includes(r.key));
        pagination.currentPage = 1;
        applyFiltersAndSort();
        showStatus(`Đã chọn ${keys.length} bill (tổng: ${fmtMoney(data.sum || 0)})`, 'info');
        return;
      }
    } catch (err) {
      // ignore and fallback
    }

    // client-side fallback
    const filtered = allRows.filter(r => {
      const num = safeAmount(r.total);
      return num >= (from || 0) && num <= (to || Infinity);
    });
    allRows = filtered;
    pagination.currentPage = 1;
    applyFiltersAndSort();
    showStatus(`Đã lọc ${filtered.length} bill theo khoảng`, 'info');
  });

  // --- Sell (Part 4) ---
  sellBtn && sellBtn.addEventListener('click', async () => {
    const memberId = memberSelect?.value;
    if (!memberId) return showStatus('Chọn Khách Hàng Thẻ trước khi bán', 'warn');
    if (!tbody) return showStatus('Không tìm thấy bảng kết quả', 'warn');
    const selectedKeys = Array.from(tbody.querySelectorAll('input[type=checkbox][data-key]:checked')).map(cb => cb.dataset.key);
    if (!selectedKeys.length) return showStatus('Chọn bill để bán', 'warn');
    if (!confirm(`Bạn chắc chắn muốn bán ${selectedKeys.length} bill?`)) return;
    setButtonLoading(sellBtn, true);
    try {
      const resp = await fetch('/api/sell', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId, keys: selectedKeys, soldAt: new Date().toISOString() })
      });
      if (!resp.ok) throw new Error(`Status ${resp.status}`);
      const data = await resp.json();
      showStatus(`Đã bán ${data.sold_count || 0} bill`, 'info');
      // refresh KHO
      khoListBtn && khoListBtn.click();
    } catch (err) {
      showStatus('Lỗi khi bán: ' + (err.message || err), 'warn');
    } finally {
      setButtonLoading(sellBtn, false);
    }
  });

  // --- History (Part 4) ---
  historyBtn && historyBtn.addEventListener('click', async () => {
    setButtonLoading(historyBtn, true);
    showLoadingState('Đang tải lịch sử giao dịch...');
    try {
      const resp = await fetch('/api/history');
      if (!resp.ok) throw new Error(`Status ${resp.status}`);
      const data = await resp.json();
      allRows = data.map(normalizeRow);
      pagination.currentPage = 1;
      hideResultState();
      applyFiltersAndSort();
      showStatus(`Lịch sử ${allRows.length} mục`, 'info');
    } catch (err) {
      showEmptyState('Lỗi tải lịch sử: ' + (err.message || err));
    } finally {
      setButtonLoading(historyBtn, false);
    }
  });

  // --- Initial load ---
  (async function initialLoad() {
    try {
      await refreshMembers();
      // optionally pre-load KHO providers for filter UI
      await loadKhoProviders();
    } catch (e) {
      console.warn('initialLoad', e);
    } finally {
      // UI init
      initUI();
      applyColumnToggles();
    }
  })();

  async function loadKhoProviders() {
    try {
      const arr = await apiGet('/kho/list');
      const providers = Array.from(new Set(arr.map(r => r.provider_id))).filter(Boolean).sort();
      const sel = document.getElementById('khoProviderFilter');
      if (sel) sel.innerHTML = '<option value="">— Tất cả nhà cung cấp —</option>' + providers.map(p => `<option value="${p}">${p}</option>`).join('');
    } catch (err) {
      // ignore
    }
  }

  // --- Initial UI & helpers ---
  function initUI() {
    pagination.rowsPerPage = Number(rowsPerPageEl?.value || 15);
    displayMode = 'list';
    viewListBtn && viewListBtn.classList.add('active');
    viewGridBtn && viewGridBtn.classList.remove('active');
    applyColumnToggles();
  }

  // --- Small developer helpers/expose ---
  window.__checkbill = {
    getState: () => ({ allRows, filteredRows, pagination, sortKey, sortDir, displayMode }),
    reloadMembers: refreshMembers,
    refreshKho: () => khoListBtn && khoListBtn.click(),
    refreshHistory: () => historyBtn && historyBtn.click(),
    renderCurrent: () => applyFiltersAndSort()
  };

  // keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); accountsEl && accountsEl.focus(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'g') { e.preventDefault(); viewGridBtn && viewGridBtn.click(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'l') { e.preventDefault(); viewListBtn && viewListBtn.click(); }
  });

  // expose renderCurrent for debugging
  window.renderCurrent = renderCurrent;

}); // DOMContentLoaded end
