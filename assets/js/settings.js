/* ============================================================
   설정 — 연결 상태 / TTS / 오프라인 큐 / 구성원·카테고리 / 로그아웃
   ============================================================ */
(async function () {
  let cfg;
  try { cfg = await Core.init({ page: 'settings' }); } catch (e) { return; }

  const $ = (id) => document.getElementById(id);

  // 연결 상태
  try {
    const r = await API.config();
    $('connStatus').innerHTML = r && r.ok
      ? `<span class="dot ok"></span>연결됨 · v${r.schema_version}`
      : `<span class="dot bad"></span>오류`;
  } catch (e) { $('connStatus').innerHTML = '<span class="dot bad"></span>연결 실패'; }

  // TTS 토글
  const ttsToggle = $('ttsToggle');
  ttsToggle.checked = !!LEDGER_CONFIG.tts;
  ttsToggle.addEventListener('change', () => {
    LEDGER_CONFIG.tts = ttsToggle.checked;
    localStorage.setItem('ledger_tts', ttsToggle.checked ? '1' : '0');
    Core.toast(ttsToggle.checked ? '음성 응답 켜짐' : '음성 응답 꺼짐');
  });

  // 오프라인 큐
  function refreshQueue() { $('queueCount').textContent = API.queueSize() + '건'; }
  refreshQueue();
  $('syncBtn').addEventListener('click', async () => {
    $('syncBtn').disabled = true;
    try { const r = await API.flushQueue(); Core.toast(`동기화: ${r.flushed}건 전송`); }
    catch (e) { Core.toast('동기화 실패'); }
    refreshQueue(); $('syncBtn').disabled = false;
  });

  // 구성원 / 카테고리
  $('memberList').innerHTML = (cfg.members || []).map(m =>
    `<span class="tag">${m.emoji || '👤'} ${esc(m.name)}</span>`).join('') || '<span class="desc">없음</span>';
  $('catList').innerHTML = (cfg.categories || []).map(c =>
    `<span class="tag">${c.emoji || '📦'} ${esc(c.name)}</span>`).join('') || '<span class="desc">없음</span>';

  // 로그아웃
  $('logoutBtn').addEventListener('click', () => {
    if (!confirm('PIN을 지우고 잠글까요?')) return;
    API.clearPin();
    location.href = 'index.html';
  });

  $('appVer').textContent = 'Voice Ledger v1.0';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
})();
