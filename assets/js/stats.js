/* ============================================================
   통계 — 월별 카테고리/지출자 분해 + 커플 정산
   ============================================================ */
(async function () {
  try { await Core.init({ page: 'stats' }); } catch (e) { return; }

  const els = {
    monthLabel: document.getElementById('monthLabel'),
    total: document.getElementById('total'),
    prevM: document.getElementById('prevM'),
    nextM: document.getElementById('nextM'),
    payerSplit: document.getElementById('payerSplit'),
    settle: document.getElementById('settle'),
    catBars: document.getElementById('catBars')
  };

  let cursor = new Date(Core.todayKST() + 'T00:00:00');
  els.prevM.addEventListener('click', () => { cursor.setMonth(cursor.getMonth() - 1); load(); });
  els.nextM.addEventListener('click', () => { cursor.setMonth(cursor.getMonth() + 1); load(); });
  await load();

  async function load() {
    const y = cursor.getFullYear(), m = String(cursor.getMonth() + 1).padStart(2, '0');
    els.monthLabel.textContent = `${y}년 ${m}월`;
    let r;
    try { r = await API.list({ period: 'range', from: `${y}-${m}-01`, to: `${y}-${m}-31` }); }
    catch (e) { Core.toast('불러오기 실패'); return; }
    if (!r || !r.ok) return;
    render(r.summary);
  }

  function render(sum) {
    els.total.textContent = Core.won(sum.total);
    renderPayers(sum.byPayer, sum.total);
    renderCats(sum.byCategory, sum.total);
  }

  function renderPayers(byPayer, total) {
    const members = Core.state.members.map(x => x.name);
    const names = members.length ? members : Object.keys(byPayer).filter(Boolean);
    els.payerSplit.innerHTML = names.map(n => {
      const v = byPayer[n] || 0;
      const pct = total ? Math.round(v / total * 100) : 0;
      const emoji = (Core.state.members.find(x => x.name === n) || {}).emoji || '👤';
      return `<div class="stat-card card">
        <div class="stat-label">${emoji} ${esc(n)}</div>
        <div class="stat-value" style="font-size:1.3rem">${Core.won(v)}</div>
        <div class="stat-label">${pct}%</div>
      </div>`;
    }).join('');

    // 커플 정산: 두 명이면 차액의 절반만큼 정산
    if (names.length === 2) {
      const a = byPayer[names[0]] || 0, b = byPayer[names[1]] || 0;
      const diff = Math.abs(a - b) / 2;
      if (diff < 1) { els.settle.innerHTML = '정산 완료 — 양쪽 지출이 같아요 🎉'; return; }
      const more = a > b ? names[1] : names[0];   // 덜 낸 사람이
      const to = a > b ? names[0] : names[1];     // 더 낸 사람에게
      els.settle.innerHTML = `<b>${esc(more)}</b> → <b>${esc(to)}</b> 에게 <b>${Core.won(Math.round(diff))}</b> 주면 정산 ✓`;
    } else { els.settle.innerHTML = ''; }
  }

  function renderCats(byCat, total) {
    const entries = Object.keys(byCat).map(k => [k, byCat[k]]).filter(e => e[1] > 0).sort((a, b) => b[1] - a[1]);
    if (!entries.length) { els.catBars.innerHTML = '<div class="empty">데이터가 없어요</div>'; return; }
    const max = entries[0][1];
    els.catBars.innerHTML = entries.map(([cat, v]) => {
      const w = Math.round(v / max * 100);
      const pct = total ? Math.round(v / total * 100) : 0;
      return `<div class="bar-row">
        <div class="bar-label">${Core.catEmoji(cat)} ${esc(cat)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${w}%"></div></div>
        <div class="bar-val">${Core.won(v)}<br><span style="color:var(--text-tertiary);font-weight:400">${pct}%</span></div>
      </div>`;
    }).join('');
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
})();
