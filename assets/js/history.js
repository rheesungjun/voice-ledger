/* ============================================================
   내역 — 월별 조회 + 카테고리/지출자 필터 + 수정/삭제
   ============================================================ */
(async function () {
  try { await Core.init({ page: 'history' }); } catch (e) { return; }

  const els = {
    monthLabel: document.getElementById('monthLabel'),
    monthTotal: document.getElementById('monthTotal'),
    prevM: document.getElementById('prevM'),
    nextM: document.getElementById('nextM'),
    payerFilter: document.getElementById('payerFilter'),
    catFilter: document.getElementById('catFilter'),
    list: document.getElementById('list')
  };

  let cursor = new Date(Core.todayKST() + 'T00:00:00');
  const filter = { payer: null, category: null };
  let all = [];

  els.prevM.addEventListener('click', () => { cursor.setMonth(cursor.getMonth() - 1); load(); });
  els.nextM.addEventListener('click', () => { cursor.setMonth(cursor.getMonth() + 1); load(); });

  // 수정 모달
  const $ = (id) => document.getElementById(id);
  let editingId = null;
  const overlay = $('editOverlay');
  $('eCancel').addEventListener('click', closeEdit);
  $('eSave').addEventListener('click', saveEdit);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeEdit(); });

  buildFilters();
  await load();

  function ym() {
    const y = cursor.getFullYear();
    const m = String(cursor.getMonth() + 1).padStart(2, '0');
    return { y, m, str: `${y}-${m}` };
  }

  async function load() {
    const { y, m, str } = ym();
    els.monthLabel.textContent = `${y}년 ${m}월`;
    const apply = (r) => {
      if (!r || !r.ok) return;
      all = r.expenses;
      els.monthTotal.textContent = Core.won(r.summary.total);
      render();
    };
    try { await API.listSWR({ period: 'range', from: `${str}-01`, to: `${str}-31` }, apply); }
    catch (e) { Core.toast('불러오기 실패'); }
  }

  function buildFilters() {
    const payers = Core.state.members.map(x => x.name);
    els.payerFilter.innerHTML =
      chip('전체', filter.payer === null, 'p', '') +
      payers.map(p => chip(p, filter.payer === p, 'p', p)).join('');
    const cats = Core.state.categories.map(x => x.name);
    els.catFilter.innerHTML =
      chip('전체 카테고리', filter.category === null, 'c', '') +
      cats.map(c => chip(Core.catEmoji(c) + ' ' + c, filter.category === c, 'c', c)).join('');

    els.payerFilter.querySelectorAll('.filter-chip').forEach(el =>
      el.addEventListener('click', () => { filter.payer = el.dataset.val || null; buildFilters(); render(); }));
    els.catFilter.querySelectorAll('.filter-chip').forEach(el =>
      el.addEventListener('click', () => { filter.category = el.dataset.val || null; buildFilters(); render(); }));
  }
  function chip(label, active, kind, val) {
    return `<span class="filter-chip ${active ? 'active' : ''}" data-kind="${kind}" data-val="${val}">${label}</span>`;
  }

  function render() {
    let rows = all.slice();
    if (filter.payer) rows = rows.filter(r => r.payer === filter.payer);
    if (filter.category) rows = rows.filter(r => r.category === filter.category);

    if (!rows.length) { els.list.innerHTML = '<div class="empty">내역이 없어요</div>'; return; }

    // 날짜별 그룹
    const groups = {};
    rows.forEach(r => { (groups[r.date] = groups[r.date] || []).push(r); });
    const dates = Object.keys(groups).sort((a, b) => b.localeCompare(a));

    els.list.innerHTML = dates.map(d => {
      const items = groups[d];
      const dayTotal = items.reduce((s, r) => s + r.amount, 0);
      return `<div class="day-group">
        <div class="day-head"><span>${Core.fmtDate(d)}</span><span>${Core.won(dayTotal)}</span></div>
        <div class="expense-list">${items.map(itemHtml).join('')}</div>
      </div>`;
    }).join('');

    els.list.querySelectorAll('[data-del]').forEach(b =>
      b.addEventListener('click', (ev) => { ev.stopPropagation(); onDelete(b.dataset.del); }));
    els.list.querySelectorAll('[data-edit]').forEach(b =>
      b.addEventListener('click', () => openEdit(b.dataset.edit)));
  }

  function itemHtml(r) {
    return `<div class="expense-item">
      <span class="emoji" data-edit="${r.id}">${Core.catEmoji(r.category)}</span>
      <div class="ei-main" data-edit="${r.id}">
        <div class="ei-title">${esc(r.item || r.store || r.category)}</div>
        <div class="ei-sub">${esc(r.store || r.category)}${r.payment_method ? ' · 💳' + esc(r.payment_method) : ''} ${r.payer ? '· <span class="payer-chip">' + esc(r.payer) + '</span>' : ''}</div>
      </div>
      <div class="ei-amount" data-edit="${r.id}">${Core.won(r.amount)}</div>
      <button class="del" data-del="${r.id}" title="삭제">🗑️</button>
    </div>`;
  }

  async function onDelete(id) {
    if (!confirm('이 지출을 삭제할까요?')) return;
    try { await API.remove(id); all = all.filter(r => r.id !== id); render(); recalcTotal(); Core.toast('삭제됨'); }
    catch (e) { Core.toast('삭제 실패'); }
  }
  function opt(val, label, sel) { return `<option value="${esc(val)}" ${sel ? 'selected' : ''}>${esc(label)}</option>`; }

  function openEdit(id) {
    const r = all.find(x => x.id === id); if (!r) return;
    editingId = id;
    $('eCategory').innerHTML = Core.state.categories.map(c =>
      opt(c.name, Core.catEmoji(c.name) + ' ' + c.name, c.name === r.category)).join('');
    $('ePayer').innerHTML = '<option value="">미지정</option>' + Core.state.members.map(m =>
      opt(m.name, (m.emoji || '👤') + ' ' + m.name, m.name === r.payer)).join('');
    $('ePayment').innerHTML = '<option value="">미지정</option>' + Core.state.payments.map(p =>
      opt(p.name, p.name, p.name === r.payment_method)).join('');
    if (r.payment_method && !Core.state.payments.some(p => p.name === r.payment_method)) {
      $('ePayment').insertAdjacentHTML('beforeend', opt(r.payment_method, r.payment_method, true));
    }
    $('eItem').value = r.item || '';
    $('eAmount').value = r.amount || 0;
    $('eDate').value = r.date || '';
    $('eStore').value = r.store || '';
    $('eRegion').value = r.region || '';
    $('eMemo').value = r.memo || '';
    overlay.classList.add('show');
  }

  function closeEdit() { overlay.classList.remove('show'); editingId = null; }

  async function saveEdit() {
    if (!editingId) return;
    const r = all.find(x => x.id === editingId); if (!r) { closeEdit(); return; }
    const fields = {
      item: $('eItem').value.trim(),
      amount: Math.round(Number(String($('eAmount').value).replace(/[^\d]/g, ''))) || 0,
      date: $('eDate').value || r.date,
      category: $('eCategory').value,
      payer: $('ePayer').value,
      payment_method: $('ePayment').value,
      store: $('eStore').value.trim(),
      region: $('eRegion').value.trim(),
      memo: $('eMemo').value.trim()
    };
    $('eSave').disabled = true;
    try {
      await API.update(editingId, fields);
      Object.assign(r, fields);
      closeEdit(); render(); recalcTotal(); Core.toast('수정됨 ✓');
    } catch (e) { Core.toast('수정 실패'); }
    $('eSave').disabled = false;
  }
  function recalcTotal() {
    els.monthTotal.textContent = Core.won(all.reduce((s, r) => s + r.amount, 0));
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
})();
