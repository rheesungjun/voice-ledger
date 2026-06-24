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
      b.addEventListener('click', () => onDelete(b.dataset.del)));
    els.list.querySelectorAll('[data-amt]').forEach(b =>
      b.addEventListener('click', () => onEditAmount(b.dataset.amt)));
  }

  function itemHtml(r) {
    return `<div class="expense-item">
      <span class="emoji">${Core.catEmoji(r.category)}</span>
      <div class="ei-main">
        <div class="ei-title">${esc(r.item || r.store || r.category)}</div>
        <div class="ei-sub">${esc(r.store || r.category)}${r.payment_method ? ' · 💳' + esc(r.payment_method) : ''} ${r.payer ? '· <span class="payer-chip">' + esc(r.payer) + '</span>' : ''}</div>
      </div>
      <div class="ei-amount" data-amt="${r.id}">${Core.won(r.amount)}</div>
      <button class="del" data-del="${r.id}" title="삭제">🗑️</button>
    </div>`;
  }

  async function onDelete(id) {
    if (!confirm('이 지출을 삭제할까요?')) return;
    try { await API.remove(id); all = all.filter(r => r.id !== id); render(); recalcTotal(); Core.toast('삭제됨'); }
    catch (e) { Core.toast('삭제 실패'); }
  }
  async function onEditAmount(id) {
    const r = all.find(x => x.id === id); if (!r) return;
    const v = prompt('금액(원)', r.amount);
    if (v === null) return;
    const amt = Math.round(Number(String(v).replace(/[^\d]/g, '')));
    if (!amt) return;
    try { await API.update(id, { amount: amt }); r.amount = amt; render(); recalcTotal(); Core.toast('수정됨'); }
    catch (e) { Core.toast('수정 실패'); }
  }
  function recalcTotal() {
    els.monthTotal.textContent = Core.won(all.reduce((s, r) => s + r.amount, 0));
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
})();
