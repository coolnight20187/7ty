/* public/app.js
   Client-side application logic for "Tra cứu & Bán Bill"
   - Works with server endpoints:
     - POST /api/check-electricity/bulk  (bulk lookup to CheckBill Pro)
     - POST /api/kho/import
     - GET  /api/kho/list
     - POST /api/kho/remove
     - POST /api/sell
     - GET  /api/history
     - GET  /api/export-excel
     - GET  /api/members, POST /api/members, PUT /api/members/:id
   - Provides:
     - Bulk lookup, de-dup, normalize upstream responses
     - Render list + grid views, pagination, sorting, column toggles
     - KHO import, list, remove
     - Pick by target, sell, history
     - Export & copy
   - Notes: keep DOM element ids in sync with public/index.html
*/

document.addEventListener('DOMContentLoaded', () => {
  // --- Utility helpers ---
  const $ = id => document.getElementById(id);
  const cls = (el, c, on = true) => el.classList[on ? 'add' : 'remove'](c);
  const toNumber = v => Number((v ?? '').toString().replace(/[^\d.-]/g, '')) || 0;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Money formatting (VND)
  function fmtMoney(v) {
    const n = toNumber(v);
    if (n === 0) return '0 ₫';
    return n.toLocaleString('vi-VN') + ' ₫';
  }
  // Date formatting helper
  function fmtDate(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return d.toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch { return iso; }
  }

  // Parse number in upstream which may return amounts in plain number (VND)
  function safeAmount(v) {
    if (v === undefined || v === null) return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : parseInt((v + '').replace(/\D/g, ''), 10) || 0;
  }

  // --- State ---
  let currentUser = null;
  let allRows = [];        // original data array (objects normalized)
  let filteredRows = [];   // rows after filter/search/hideZero
  let displayMode = 'list';// or 'grid'
  let sortKey = 'index';
  let sortDir = 1;         // 1 asc or -1 desc
  let pagination = { rowsPerPage: 15, currentPage: 1 };

  // --- Elements ---
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
    el._timer = setTimeout(() => el.classList.add('d-none'), 3500);
  }
  function showLoadingState(msg) {
    if (!resultState) return;
    resultState.innerHTML = `<div class="spinner-border text-primary" role="status" style="width:3rem;height:3rem"><span class="visually-hidden">Loading</span></div><p class="h5 mt-3">${msg}</p>`;
    resultState.classList.remove('d-none');
    listContainer.classList.add('d-none');
    gridContainer.classList.add('d-none');
  }
  function hideResultState() {
    if (!resultState) return;
    resultState.classList.add('d-none');
    resultState.innerHTML = '';
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

  // --- Normalize server-side normalized shape or upstream raw shape ---
  // server returns normalized object in `normalized` property for bulk calls, but we tolerate raw shapes too
  function normalizeRow(item) {
    // possible shapes:
    // - item.normalized (from server bulk): has keys: key, provider_id, account, name, address, amount_current, total, amount_previous, raw
    // - item: own raw from server-side fallback or legacy server.js
    if (!item) return null;
    if (item.normalized) return item.normalized;
    const keys = ['key','provider_id','account','name','address','amount_current','total','amount_previous','nhapAt','xuatAt','memberName','customer'];
    const out = {};
    keys.forEach(k => { out[k] = item[k] !== undefined ? item[k] : (item.raw && item.raw[k] !== undefined ? item.raw[k] : '') });
    // ensure numeric strings
    out.amount_current = out.amount_current == null ? '0' : String(out.amount_current);
    out.total = out.total == null ? out.amount_current || '0' : String(out.total);
    out.amount_previous = out.amount_previous == null ? '0' : String(out.amount_previous);
    out.key = out.key || `${out.provider_id || 'UNK'}::${out.account || ''}`;
    return out;
  }

  // --- Rendering ---
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

      // checkbox
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

    // toggle table visibility
    resultTable.classList.remove('d-none');
    listContainer.classList.remove('d-none');
    gridContainer.classList.add('d-none');
    applyColumnToggles();
    updateSum(rows);
  }

  function renderGridPage(rows) {
    gridContainer.innerHTML = '';
    rows.forEach(r => {
      const card = document.createElement('div');
      card.className = 'card grid-card shadow-sm';
      const h = document.createElement('div');
      h.className = 'card-header';
      h.textContent = r.name || '(Không tên)';
      const b = document.createElement('div');
      b.className = 'card-body';
      const acc = document.createElement('p');
      acc.className = 'card-text';
      acc.textContent = `Mã KH: ${r.account || ''}`;
      const addr = document.createElement('p');
      addr.className = 'card-text';
      addr.textContent = `Địa chỉ: ${r.address || ''}`;
      const total = document.createElement('p');
      total.className = 'card-total';
      total.textContent = fmtMoney(r.total || r.amount_current || 0);
      const meta = document.createElement('div');
      meta.className = 'card-footer';
      meta.innerHTML = `${r.nhapAt ? `<small>Nhập: ${fmtDate(r.nhapAt)}</small>` : ''}${r.xuatAt ? `<small class="d-block">Xuất: ${fmtDate(r.xuatAt)}</small>` : ''}${r.memberName ? `<small class="d-block">KHT: ${r.memberName}</small>` : ''}`;

      b.append(acc, addr, total);
      card.append(h, b, meta);
      gridContainer.append(card);
    });

    listContainer.classList.add('d-none');
    gridContainer.classList.remove('d-none');
  }

  function applyColumnToggles() {
    if (!resultTable) return;
    colToggles.forEach(cb => {
      const col = cb.dataset.col;
      const checked = cb.checked;
      resultTable.querySelectorAll(`[data-col="${col}"]`).forEach(el => {
        if (checked) el.classList.remove('hidden'); else el.classList.add('hidden');
      });
    });
    if (tfoot) {
      // show/hide footer columns same as header visibility of 'select' -> keep at least total visible
      tfoot.classList.remove('d-none');
    }
  }

  function renderCurrent() {
    // filter & sort then paginate and render
    const term = (searchInput && searchInput.value || '').toLowerCase().trim();
    const hideZero = hideZeroToggle && hideZeroToggle.checked;

    filteredRows = allRows.filter(r => {
      if (hideZero && safeAmount(r.total) === 0) return false;
      if (!term) return true;
      const hay = `${r.name} ${r.address} ${r.account} ${r.memberName || ''} ${r.employee_username || ''}`.toLowerCase();
      return hay.includes(term);
    });

    // sort
    const type = thead ? (thead.querySelector(`th[data-col="${sortKey}"]`)?.dataset.sort || 'text') : 'text';
    filteredRows.sort((a, b) => {
      let va = a[sortKey], vb = b[sortKey];
      if (sortKey === 'index') {
        va = allRows.indexOf(a); vb = allRows.indexOf(b);
      }
      if (type === 'money') {
        return sortDir * (safeAmount(va) - safeAmount(vb));
      } else if (type === 'date') {
        return sortDir * ((va || '').localeCompare(vb || ''));
      } else {
        return sortDir * (`${va || ''}`).localeCompare(`${vb || ''}`, 'vi', { sensitivity: 'base' });
      }
    });

    // pagination
    pagination.currentPage = Math.min(Math.max(1, pagination.currentPage), Math.ceil(filteredRows.length / pagination.rowsPerPage) || 1);
    const start = (pagination.currentPage - 1) * pagination.rowsPerPage;
    const end = start + pagination.rowsPerPage;
    const pageRows = filteredRows.slice(start, end);

    // render according to display mode
    if (displayMode === 'list') renderListPage(pageRows);
    else renderGridPage(pageRows);

    // update page info and prev/next
    const totalPages = Math.ceil(filteredRows.length / pagination.rowsPerPage) || 1;
    pageInfoEl.textContent = `Trang ${pagination.currentPage} / ${totalPages}`;
    prevPageBtn.disabled = pagination.currentPage <= 1;
    nextPageBtn.disabled = pagination.currentPage >= totalPages;
  }

  // --- Event bindings ---

  // Filter duplicates
  filterDupBtn.addEventListener('click', () => {
    const lines = accountsEl.value.split('\n').map(s => s.trim()).filter(Boolean);
    const unique = Array.from(new Set(lines));
    accountsEl.value = unique.join('\n');
    showStatus(`Đã lọc trùng: còn ${unique.length} mã`, 'info');
  });

  // Sort header clicks
  if (thead) {
    thead.addEventListener('click', e => {
      const th = e.target.closest('th[data-sort]');
      if (!th) return;
      const col = th.dataset.col;
      if (col === sortKey) sortDir *= -1; else { sortKey = col; sortDir = 1; }
      // toggle classes
      thead.querySelectorAll('th').forEach(t => t.classList.remove('sorted-asc','sorted-desc'));
      const active = thead.querySelector(`th[data-col="${sortKey}"]`);
      if (active) active.classList.add(sortDir === 1 ? 'sorted-asc' : 'sorted-desc');
      renderCurrent();
    });
  }

  // View toggles
  viewListBtn.addEventListener('click', () => {
    displayMode = 'list';
    viewListBtn.classList.add('active');
    viewGridBtn.classList.remove('active');
    renderCurrent();
  });
  viewGridBtn.addEventListener('click', () => {
    displayMode = 'grid';
    viewGridBtn.classList.add('active');
    viewListBtn.classList.remove('active');
    renderCurrent();
  });

  // Pagination controls
  rowsPerPageEl.addEventListener('change', () => {
    pagination.rowsPerPage = Number(rowsPerPageEl.value);
    pagination.currentPage = 1;
    renderCurrent();
  });
  prevPageBtn.addEventListener('click', () => {
    if (pagination.currentPage > 1) { pagination.currentPage--; renderCurrent(); }
  });
  nextPageBtn.addEventListener('click', () => {
    const totalPages = Math.ceil(filteredRows.length / pagination.rowsPerPage) || 1;
    if (pagination.currentPage < totalPages) { pagination.currentPage++; renderCurrent(); }
  });

  // Search & hide zero
  searchInput.addEventListener('input', () => { pagination.currentPage = 1; renderCurrent(); });
  hideZeroToggle.addEventListener('change', () => { pagination.currentPage = 1; renderCurrent(); });

  // Select All
  selectAllCb && selectAllCb.addEventListener('change', () => {
    const checked = selectAllCb.checked;
    tbody && tbody.querySelectorAll('input[type=checkbox][data-key]').forEach(cb => cb.checked = checked);
  });

  // Copy
  copyBtn.addEventListener('click', async () => {
    const lines = [];
    const visibleCols = Array.from(document.querySelectorAll('.col-options input[data-col]')).filter(cb => cb.checked).map(cb => cb.dataset.col);
    for (const r of filteredRows) {
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
      lines.push(parts.join('\t'));
    }
    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      showStatus('Đã sao chép vào clipboard', 'info');
    } catch (err) {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showStatus('Đã sao chép (fallback)', 'info');
    }
  });

  // Export (calls server-side /api/export-excel)
  exportBtn.addEventListener('click', () => {
    // build query from current filters
    const from = targetFrom.value || '';
    const to = targetTo.value || '';
    const url = `/api/export-excel?fromAmount=${encodeURIComponent(from)}&toAmount=${encodeURIComponent(to)}&sortBy=${encodeURIComponent(sortKey)}&sortOrder=${encodeURIComponent(sortDir===1?'asc':'desc')}`;
    window.open(url, '_blank');
    showStatus('Bắt đầu tải Excel...', 'info');
  });

  // --- Server interactions --- (bulk lookup)
  lookupBtn.addEventListener('click', async () => {
    const sku = providerEl.value;
    const codes = accountsEl.value.split('\n').map(s => s.trim()).filter(Boolean);
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
        const txt = await resp.text();
        throw new Error(txt || `Server lỗi ${resp.status}`);
      }
      const results = await resp.json();
      // results: [{account, ok, normalized, data} | {account, ok:false, error}]
      const rows = results.map(r => {
        if (r.ok && r.normalized) return normalizeRow(r);
        // r might be already normalized (legacy)
        if (r.account && r.data && r.normalized) return normalizeRow(r);
        if (r.ok && r.data && !r.normalized) {
          // server returned raw from upstream - try to normalize using client fallback
          const norm = r.normalized || {
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
        // error fallback
        return {
          key: `${sku}::${r.account}`,
          provider_id: sku,
          account: r.account,
          name: `(Mã ${r.account})`,
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
      renderCurrent();
      showStatus(`Hoàn tất tra cứu ${allRows.length} mã`, 'info');
    } catch (err) {
      console.error('Lookup error', err);
      showStatus('Lỗi khi tra cứu: ' + (err.message || err), 'warn');
      showEmptyState('Lỗi khi tra cứu, kiểm tra console để biết chi tiết');
    } finally {
      setButtonLoading(lookupBtn, false);
    }
  });

  function showEmptyState(msg) {
    if (!resultState) return;
    resultState.innerHTML = `<i class="state-icon bx bx-data"></i><p class="h5 mt-3 state-message">${msg}</p>`;
    resultState.classList.remove('d-none');
    listContainer.classList.add('d-none');
    gridContainer.classList.add('d-none');
  }

  // KHO: import selected
  khoImportBtn.addEventListener('click', async () => {
    if (!tbody) return showStatus('Không có kết quả để nhập', 'warn');
    const checked = Array.from(tbody.querySelectorAll('input[type=checkbox][data-key]:checked')).map(cb => cb.dataset.key);
    if (!checked.length) return showStatus('Chọn trước bill để nhập vào KHO', 'warn');
    const bills = checked.map(k => allRows.find(r => (r.key || r.id) === k)).filter(Boolean).map(r => ({
      ...r,
      nhapAt: new Date().toISOString()
    }));
    setButtonLoading(khoImportBtn, true);
    try {
      const resp = await fetch('/api/kho/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bills })
      });
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(txt || `Server lỗi ${resp.status}`);
      }
      const data = await resp.json();
      showStatus(`Đã nhập ${data.added || 0} bill vào KHO`, 'info');
    } catch (err) {
      showStatus('Lỗi nhập KHO: ' + (err.message || err), 'warn');
    } finally {
      setButtonLoading(khoImportBtn, false);
    }
  });

  // KHO list
  khoListBtn.addEventListener('click', async () => {
    setButtonLoading(khoListBtn, true);
    showLoadingState('Đang tải KHO...');
    try {
      const resp = await fetch('/api/kho/list');
      if (!resp.ok) throw new Error(`Status ${resp.status}`);
      const data = await resp.json();
      allRows = data.map(normalizeRow);
      pagination.currentPage = 1;
      hideResultState();
      renderCurrent();
      showStatus(`KHO: ${allRows.length} bill`, 'info');
    } catch (err) {
      console.error('KHO list error', err);
      showEmptyState('Lỗi tải KHO: ' + (err.message || err));
    } finally {
      setButtonLoading(khoListBtn, false);
    }
  });

  // KHO remove
  khoRemoveBtn.addEventListener('click', async () => {
    if (!tbody) return showStatus('Không có kết quả để xóa', 'warn');
    const checked = Array.from(tbody.querySelectorAll('input[type=checkbox][data-key]:checked')).map(cb => cb.dataset.key);
    if (!checked.length) return showStatus('Chọn bill để xóa khỏi KHO', 'warn');
    if (!confirm(`Bạn chắc chắn muốn xóa ${checked.length} bill khỏi KHO?`)) return;
    setButtonLoading(khoRemoveBtn, true);
    try {
      const resp = await fetch('/api/kho/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: checked })
      });
      if (!resp.ok) throw new Error(`Status ${resp.status}`);
      const data = await resp.json();
      showStatus(`Đã xóa ${data.removed || 0} bill khỏi KHO`, 'info');
      // refresh KHO view
      khoListBtn.click();
    } catch (err) {
      showStatus('Lỗi xóa KHO: ' + (err.message || err), 'warn');
    } finally {
      setButtonLoading(khoRemoveBtn, false);
    }
  });

  // Members CRUD (basic)
  async function refreshMembers() {
    try {
      const resp = await fetch('/api/members');
      if (!resp.ok) throw new Error(`Status ${resp.status}`);
      const data = await resp.json();
      memberSelect.innerHTML = '';
      data.forEach(m => {
        const o = new Option(`${m.name} (Z:${m.zalo || 'N/A'})`, m.id);
        memberSelect.add(o);
      });
    } catch (err) {
      console.error('Members load error', err);
    }
  }
  memberAddBtn.addEventListener('click', async () => {
    const name = prompt('Tên Khách Hàng Thẻ:')?.trim();
    if (!name) return;
    const zalo = prompt('Zalo (tùy chọn):') || '';
    const bank = prompt('Ngân hàng (tùy chọn):') || '';
    try {
      const resp = await fetch('/api/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, zalo, bank })
      });
      if (!resp.ok) throw new Error(`Status ${resp.status}`);
      await refreshMembers();
      showStatus('Đã thêm Khách Hàng Thẻ', 'info');
    } catch (err) {
      showStatus('Lỗi thêm KHT: ' + (err.message || err), 'warn');
    }
  });
  memberEditBtn.addEventListener('click', async () => {
    const id = memberSelect.value;
    if (!id) return showStatus('Chọn KHT để sửa', 'warn');
    const name = prompt('Tên mới:')?.trim();
    if (!name) return;
    const zalo = prompt('Zalo mới:') || '';
    const bank = prompt('Ngân hàng mới:') || '';
    try {
      const resp = await fetch(`/api/members/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, zalo, bank })
      });
      if (!resp.ok) throw new Error(`Status ${resp.status}`);
      await refreshMembers();
      showStatus('Cập nhật KHT thành công', 'info');
    } catch (err) {
      showStatus('Lỗi cập nhật KHT: ' + (err.message || err), 'warn');
    }
  });
  memberViewBtn.addEventListener('click', async () => {
    try {
      const resp = await fetch('/api/members');
      if (!resp.ok) throw new Error(`Status ${resp.status}`);
      const data = await resp.json();
      alert('Danh sách Khách Hàng Thẻ:\n' + data.map(d => `- ${d.name} (Z:${d.zalo||'N/A'}, B:${d.bank||'N/A'})`).join('\n'));
    } catch (err) {
      showStatus('Lỗi tải KHT: ' + (err.message || err), 'warn');
    }
  });
  memberSearch.addEventListener('keydown', e => { if (e.key === 'Enter') refreshMembers(); });

  // Pick by target (server-side helper)
  pickBtn.addEventListener('click', async () => {
    const from = Number(targetFrom.value || 0);
    const to = Number(targetTo.value || Infinity);
    if (!allRows || !allRows.length) return showStatus('Không có dữ liệu KHO để lọc', 'warn');
    // If not in KHO view, request KHO first
    // We'll rely on server-side select-by-target endpoint if exists, else local filter
    try {
      const resp = await fetch('/api/select-by-target', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: from })
      });
      if (resp.ok) {
        const data = await resp.json();
        // data.keys contains selection keys
        const keys = data.keys || [];
        // filter local allRows to selected keys and render
        allRows = allRows.filter(r => keys.includes(r.key));
        pagination.currentPage = 1;
        renderCurrent();
        showStatus(`Đã chọn ${keys.length} bill (tổng: ${fmtMoney(data.sum)})`, 'info');
        return;
      }
    } catch (err) {
      // fallback to local filtering by amount range
    }

    // Local fallback: filter by amount between from and to
    const filtered = allRows.filter(r => {
      const num = safeAmount(r.total);
      return num >= (from || 0) && num <= (to || Infinity);
    });
    allRows = filtered;
    pagination.currentPage = 1;
    renderCurrent();
    showStatus(`Đã lọc ${filtered.length} bill theo khoảng`, 'info');
  });

  // Sell
  sellBtn.addEventListener('click', async () => {
    const memberId = memberSelect.value;
    if (!memberId) return showStatus('Chọn Khách Hàng Thẻ trước khi bán', 'warn');
    const selectedKeys = Array.from(tbody.querySelectorAll('input[type=checkbox][data-key]:checked')).map(cb => cb.dataset.key);
    if (!selectedKeys.length) return showStatus('Chọn bill để bán', 'warn');
    if (!confirm(`Bạn chắc chắn muốn bán ${selectedKeys.length} bill?`)) return;
    setButtonLoading(sellBtn, true);
    try {
      const resp = await fetch('/api/sell', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId, keys: selectedKeys, soldAt: new Date().toISOString() })
      });
      if (!resp.ok) throw new Error(`Status ${resp.status}`);
      const data = await resp.json();
      showStatus(`Đã bán ${data.sold_count || 0} bill`, 'info');
      // refresh KHO
      await khoListBtn.click();
    } catch (err) {
      showStatus('Lỗi khi bán: ' + (err.message || err), 'warn');
    } finally {
      setButtonLoading(sellBtn, false);
    }
  });

  // History
  historyBtn.addEventListener('click', async () => {
    setButtonLoading(historyBtn, true);
    showLoadingState('Đang tải lịch sử giao dịch...');
    try {
      const resp = await fetch('/api/history');
      if (!resp.ok) throw new Error(`Status ${resp.status}`);
      const data = await resp.json();
      allRows = data.map(normalizeRow);
      pagination.currentPage = 1;
      hideResultState();
      renderCurrent();
      showStatus(`Lịch sử ${allRows.length} mục`, 'info');
    } catch (err) {
      showEmptyState('Lỗi tải lịch sử: ' + (err.message || err));
    } finally {
      setButtonLoading(historyBtn, false);
    }
  });

  // On initial load: refresh members
  (async () => {
    await refreshMembers();
  })();

  // Initial UI state
  function initUI() {
    // apply column toggles default
    applyColumnToggles();
    // initial pagination
    pagination.rowsPerPage = Number(rowsPerPageEl.value || 15);
    // initial view
    displayMode = 'list';
    viewListBtn.classList.add('active');
    viewGridBtn.classList.remove('active');
  }
  initUI();

  // --- Utility: normalizeRow wrapper (handles server normalized or direct) ---
  function normalizeRow(raw) {
    // If server returned { normalized: { ... } } earlier we normalized in bulk handler; but ensure shape
    if (!raw) return null;
    if (raw.normalized) return raw.normalized;
    // If raw is already normalized-like (has key/account/total)
    if (raw.key && raw.account && raw.total !== undefined) return raw;
    // else possible upstream raw shape: data.data.bills[0] etc.
    if (raw.data && raw.data.data && Array.isArray(raw.data.data.bills)) {
      const bill = raw.data.data.bills[0] || {};
      const amount = safeAmount(bill.moneyAmount || 0);
      return {
        key: `${raw.sku || raw.provider_id || 'UNK'}::${raw.account || raw.contract_number || ''}`,
        provider_id: raw.sku || raw.provider_id || '',
        account: raw.account || raw.contract_number || '',
        name: bill.customerName || raw.name || `(Mã ${raw.account || raw.contract_number || ''})`,
        address: bill.address || raw.address || '',
        amount_current: String(amount),
        total: String(amount),
        amount_previous: '0',
        raw
      };
    }
    // fallback generic
    return {
      key: raw.key || `${raw.provider_id||'UNK'}::${raw.account||raw.contract_number||''}`,
      provider_id: raw.provider_id || raw.sku || '',
      account: raw.account || raw.contract_number || '',
      name: raw.name || `(Mã ${raw.account || raw.contract_number || ''})`,
      address: raw.address || '',
      amount_current: String(raw.amount_current || raw.total || 0),
      total: String(raw.total || raw.amount_current || 0),
      amount_previous: String(raw.amount_previous || 0),
      raw
    };
  }

  // Expose renderCurrent to global for debugging
  window.renderCurrent = renderCurrent;

}); // end DOMContentLoaded
