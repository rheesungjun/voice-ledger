/* ============================================================
   결제수단 — 카드별 월 실적(사용액/목표) 진행률 + 추가/수정/삭제
   카드 혜택 실적을 채우기 위한 관리용
   ============================================================ */
(async function () {
  try { await Core.init({ page: 'payments' }); } catch (e) { return; }

  const $ = (id) => document.getElementById(id);
  let cursor = new Date(Core.todayKST() + 'T00:00:00');
  let byPayment = {};

  $('prevM').addEventListener('click', () => { cursor.setMonth(cursor.getMonth() - 1); load(); });
  $('nextM').addEventListener('click', () => { cursor.setMonth(cursor.getMonth() + 1); load(); });
  $('pAdd').addEventListener('click', addOrUpdate);

  await load();

  function ym() {
    const y = cursor.getFullYear(), m = String(cursor.getMonth() + 1).padStart(2, '0');
    return { y, m, str: `${y}-${m}` };
  }

  async function load() {
    const { y, m, str } = ym();
    $('monthLabel').textContent = `${y}년 ${m}월`;
    try {
      const r = await API.list({ period: 'range', from: `${str}-01`, to: `${str}-31` });
      byPayment = (r && r.ok && r.summary.byPayment) || {};
    } catch (e) { Core.toast('불러오기 실패'); byPayment = {}; }
    render();
  }

  async function refreshMethods() {
    const cfg = await API.config();
    if (cfg && cfg.ok) Core.state.payments = cfg.payments || [];
  }

  function render() {
    const methods = Core.state.payments.slice();
    const known = {};
    methods.forEach(m => { known[m.name] = true; });
    // 등록 안 됐지만 사용된 수단도 표시
    Object.keys(byPayment).forEach(name => {
      if (name && !known[name]) methods.push({ name, type: '기타', target: 0, benefit: '', note: '' });
    });

    if (!methods.length) { $('payList').innerHTML = '<div class="empty">등록된 지불수단이 없어요. 위에서 추가하세요.</div>'; return; }

    $('payList').innerHTML = methods.map(cardHtml).join('');
    $('payList').querySelectorAll('[data-edit]').forEach(b =>
      b.addEventListener('click', () => fillForm(b.dataset.edit)));
    $('payList').querySelectorAll('[data-del]').forEach(b =>
      b.addEventListener('click', () => onDelete(b.dataset.del)));
  }

  function cardHtml(m) {
    const spend = byPayment[m.name] || 0;
    const target = Number(m.target) || 0;
    const pct = target ? Math.min(100, Math.round(spend / target * 100)) : 0;
    const remain = Math.max(target - spend, 0);
    const done = target > 0 && spend >= target;
    const bar = target
      ? `<div class="bar-track"><div class="bar-fill ${done ? 'done' : ''}" style="width:${pct}%"></div></div>
         <div class="pay-meta">
           <span>사용 <b>${Core.won(spend)}</b> / 목표 ${Core.won(target)}</span>
           <span>${done ? '<span class="badge-done">실적 달성 ✓</span>' : '남은 ' + Core.won(remain)}</span>
         </div>`
      : `<div class="pay-meta" style="margin-top:8px"><span>이번 달 사용 <b>${Core.won(spend)}</b></span><span>실적 목표 없음</span></div>`;
    return `<div class="card pay-card">
      <div class="pay-head">
        <div><span class="pay-name">${esc(m.name)}</span><span class="pay-type">${esc(m.type || '')}</span></div>
        <div class="pay-actions">
          <button data-edit="${esc(m.name)}" title="수정">✏️</button>
          <button data-del="${esc(m.name)}" title="삭제">🗑️</button>
        </div>
      </div>
      ${bar}
      ${m.benefit ? `<div class="pay-benefit">🎁 ${esc(m.benefit)}</div>` : ''}
    </div>`;
  }

  function fillForm(name) {
    const m = Core.state.payments.find(x => x.name === name) || { name, type: '카드', target: 0, benefit: '' };
    $('pName').value = m.name;
    $('pType').value = m.type || '카드';
    $('pTarget').value = m.target || '';
    $('pBenefit').value = m.benefit || '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function addOrUpdate() {
    const name = $('pName').value.trim();
    if (!name) { Core.toast('이름을 입력하세요'); return; }
    const payment = {
      name,
      type: $('pType').value,
      target: Math.round(Number(String($('pTarget').value).replace(/[^\d]/g, ''))) || 0,
      benefit: $('pBenefit').value.trim()
    };
    $('pAdd').disabled = true;
    try {
      const r = await API.paymentSave(payment);
      if (r && r.ok) {
        await refreshMethods();
        $('pName').value = ''; $('pTarget').value = ''; $('pBenefit').value = '';
        render(); Core.toast('저장됨 ✓');
      } else { Core.toast('저장 실패'); }
    } catch (e) { Core.toast('저장 실패'); }
    $('pAdd').disabled = false;
  }

  async function onDelete(name) {
    if (!confirm(`'${name}' 지불수단을 삭제할까요? (기록된 지출은 유지됩니다)`)) return;
    try {
      await API.paymentDelete(name);
      await refreshMethods();
      render(); Core.toast('삭제됨');
    } catch (e) { Core.toast('삭제 실패'); }
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
})();
