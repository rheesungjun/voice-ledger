/* ============================================================
   대화 화면 — 음성 대화 루프(VAD 무음 자동종료 + TTS) + 텍스트 입력
   ============================================================ */
(async function () {
  let els = {};
  // 대화 상태 (프론트가 보유 → GAS는 무상태)
  const conv = { active: false, busy: false, history: [], pending: [], pendingOps: { edits: [], deletes: [] } };
  // 오디오 자원
  let stream = null, audioCtx = null, analyser = null, vadRAF = null, recorder = null, chunks = [];

  // ── 부팅 ──
  try { await Core.init({ page: 'index' }); }
  catch (e) { return; }

  els = {
    convArea: document.getElementById('convArea'),
    todayList: document.getElementById('todayList'),
    todayTotal: document.getElementById('todayTotal'),
    micBtn: document.getElementById('micBtn'),
    textInput: document.getElementById('textInput'),
    endChip: document.getElementById('endChip')
  };

  els.micBtn.addEventListener('click', () => conv.active ? endConversation() : startConversation());
  els.endChip.addEventListener('click', endConversation);
  els.textInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitText(); });

  await refreshToday();

  // ════════════════ 텍스트 단일 턴 ════════════════
  async function submitText() {
    const t = els.textInput.value.trim();
    if (!t || conv.busy) return;
    els.textInput.value = '';
    addBubble('user', t);
    setMic('processing');
    await sendTurn({ text: t, source: 'text' });
    setMic('idle');
  }

  // ════════════════ 음성 대화 루프 ════════════════
  async function startConversation() {
    if (conv.active) return;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) { Core.toast('마이크 권한이 필요해요'); return; }

    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);

    conv.active = true;
    els.endChip.classList.remove('hidden');
    addStatus('대화를 시작합니다. 말씀하세요 🎙️');
    listenTurn();
  }

  function listenTurn() {
    if (!conv.active) return;
    setMic('listening');
    chunks = [];
    const mime = pickMime();
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch (e) { recorder = new MediaRecorder(stream); }
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = onTurnRecorded;
    recorder.start();
    runVAD();
  }

  // 무음 자동 종료 (Web Audio RMS 감시)
  function runVAD() {
    const buf = new Uint8Array(analyser.fftSize);
    const { silenceMs, threshold, maxMs } = LEDGER_CONFIG.VAD;
    let spoke = false, silenceStart = null;
    const startAt = performance.now();
    cancelAnimationFrame(vadRAF);
    (function tick() {
      if (!recorder || recorder.state !== 'recording') return;
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / buf.length);
      const now = performance.now();
      if (rms > threshold) { spoke = true; silenceStart = null; }
      else if (spoke) {
        if (silenceStart === null) silenceStart = now;
        else if (now - silenceStart > silenceMs) { stopTurn(); return; }
      }
      if (now - startAt > maxMs) { stopTurn(); return; }
      vadRAF = requestAnimationFrame(tick);
    })();
  }

  function stopTurn() {
    cancelAnimationFrame(vadRAF);
    if (recorder && recorder.state === 'recording') recorder.stop();
  }

  async function onTurnRecorded() {
    const type = (recorder && recorder.mimeType) || 'audio/webm';
    const blob = new Blob(chunks, { type });
    if (blob.size < 1400) { if (conv.active) listenTurn(); return; } // 너무 짧음 → 재청취
    setMic('processing');
    const b64 = await blobToB64(blob);
    await sendTurn({ audio_base64: b64, mime: type.split(';')[0], source: 'voice' });
  }

  // ════════════════ 턴 전송 + 응답 처리 ════════════════
  async function sendTurn(input) {
    conv.busy = true;
    let out;
    try {
      out = await API.converse(Object.assign(
        { history: conv.history.slice(-8), pending: conv.pending, device_owner: Core.getDeviceOwner() }, input));
    } catch (e) {
      conv.busy = false;
      Core.toast('인식 실패: ' + (e.message || e));
      if (conv.active) listenTurn();
      return;
    }
    conv.busy = false;
    if (!out || !out.ok) { Core.toast('처리 실패'); if (conv.active) listenTurn(); return; }

    if (out.transcript && input.source === 'voice') addBubble('user', out.transcript);
    if (out.reply) addBubble('bot', out.reply);
    conv.history.push({ user: out.transcript || input.text || '', assistant: out.reply, intent: out.intent });

    // 의도별 반영
    if (out.intent === 'cancel') {
      conv.pending = []; conv.pendingOps = { edits: [], deletes: [] };
    } else if (out.intent === 'edit' || out.intent === 'delete') {
      conv.pendingOps = { edits: out.edits || [], deletes: out.deletes || [] };
      if (out.items && out.items.length) conv.pending = out.items;
    } else {
      conv.pending = out.items || conv.pending;
    }
    const owner = Core.getDeviceOwner();
    if (owner) conv.pending.forEach(it => { if (!it.payer) it.payer = owner; });
    renderPending();

    // 종료 키워드
    if (/(끝|종료|그만|마칠|닫아)/.test(out.transcript || '')) {
      await speak('기록을 마칠게요'); endConversation(); return;
    }
    // 확정 의도 → 미저장 항목 + 수정/삭제 제안 모두 적용
    if (out.intent === 'confirm') { await confirmAll(); return; }

    // 응답 읽고 다시 듣기 (대화 모드일 때만)
    if (conv.active) { await speak(out.reply || '네'); listenTurn(); }
    else { setMic('idle'); }
  }

  // ════════════════ 저장 ════════════════
  async function confirmAll() {
    const items = conv.pending.filter(validItem).map(toAppendItem);
    const edits = (conv.pendingOps.edits || []).filter(e => e && e.id && e.fields && Object.keys(e.fields).length);
    const deletes = (conv.pendingOps.deletes || []).filter(d => d && (d.id || typeof d === 'string'));
    if (!items.length && !edits.length && !deletes.length) {
      await speak('처리할 내용이 없어요');
      if (conv.active) listenTurn(); else setMic('idle');
      return;
    }
    let failed = 0;
    try { if (items.length) await API.append(items); }
    catch (e) { await speak('오프라인이라 새 지출은 임시 저장했어요.'); }
    for (const e of edits) { try { await API.update(e.id, e.fields); } catch (_) { failed++; } }
    for (const d of deletes) { try { await API.remove(d.id || d); } catch (_) { failed++; } }

    conv.pending = []; conv.pendingOps = { edits: [], deletes: [] };
    renderPending();
    await refreshToday();
    const n = items.length + edits.length + deletes.length;
    await speak(failed ? '일부는 처리하지 못했어요' : (n > 1 ? n + '건 처리했어요' : '처리했어요'));
    Core.toast(failed ? '일부 실패' : '완료 ✓');
    if (conv.active) listenTurn(); else setMic('idle');
  }

  function endConversation() {
    conv.active = false;
    cancelAnimationFrame(vadRAF);
    if (recorder && recorder.state === 'recording') recorder.stop();
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    if (window.speechSynthesis) speechSynthesis.cancel();
    els.endChip.classList.add('hidden');
    setMic('idle');
  }

  // ════════════════ TTS ════════════════
  function speak(text) {
    return new Promise((resolve) => {
      if (!LEDGER_CONFIG.tts || !('speechSynthesis' in window) || !text) { resolve(); return; }
      setMic('speaking');
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ko-KR'; u.rate = 1.05;
      u.onend = resolve; u.onerror = resolve;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
      setTimeout(resolve, 6000); // 안전장치(음성 없음/멈춤 대비)
    });
  }

  // ════════════════ 렌더링 ════════════════
  function addBubble(who, text) {
    const b = document.createElement('div');
    b.className = 'bubble ' + who; b.textContent = text;
    els.convArea.appendChild(b); scrollToBottom();
  }
  function addStatus(text) {
    const s = document.createElement('div');
    s.className = 'status-pill'; s.textContent = text;
    els.convArea.appendChild(s); scrollToBottom();
  }
  function scrollToBottom() { window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); }

  function renderPending() {
    const old = document.getElementById('pendingWrap');
    if (old) old.remove();
    const ops = conv.pendingOps || { edits: [], deletes: [] };
    const opCount = (ops.edits ? ops.edits.length : 0) + (ops.deletes ? ops.deletes.length : 0);
    if (!conv.pending.length && !opCount) return;

    const wrap = document.createElement('div');
    wrap.id = 'pendingWrap'; wrap.className = 'pending-wrap';

    // 새 지출(미저장) 카드
    conv.pending.forEach((it, idx) => {
      const card = document.createElement('div');
      card.className = 'pending-card';
      const review = (it.needs_review || it.amount == null || !it.item)
        ? '<span class="review">확인필요</span>' : '';
      card.innerHTML = `
        <span class="emoji">${Core.catEmoji(it.category)}</span>
        <div class="pc-main">
          <div class="pc-title" data-edit="item">${escape(it.item || '(내용?)')}</div>
          <div class="pc-sub">
            <span data-edit="store">🏪 ${escape(it.store || '가게?')}</span> ·
            <span data-edit="region">📍 ${escape(it.region || '지역?')}</span> ·
            <span data-edit="payment_method">💳 ${escape(it.payment_method || '수단?')}</span>
          </div>
          <div class="pc-sub">
            <span data-edit="category">${escape(it.category || '기타')}</span> ·
            <span class="payer-chip" data-edit="payer">${escape(it.payer || '?')}</span> ·
            ${Core.fmtDate(it.date)} ${review}
          </div>
        </div>
        <span class="pc-amt" data-edit="amount">${it.amount != null ? Core.won(it.amount) : '?'}</span>
        <button class="pc-x" title="삭제">✕</button>`;
      card.querySelector('.pc-x').addEventListener('click', () => { conv.pending.splice(idx, 1); renderPending(); });
      card.querySelectorAll('[data-edit]').forEach(el =>
        el.addEventListener('click', () => editField(idx, el.dataset.edit)));
      wrap.appendChild(card);
    });

    // 저장된 내역 수정 제안
    (ops.edits || []).forEach((e) => {
      const card = document.createElement('div');
      card.className = 'pending-card op-edit';
      card.innerHTML = `<span class="emoji">✏️</span>
        <div class="pc-main"><div class="pc-title">수정 · ${escape(e.label || e.id)}</div>
        <div class="pc-sub">${escape(fieldsSummary(e.fields))}</div></div>`;
      wrap.appendChild(card);
    });
    // 저장된 내역 삭제 제안
    (ops.deletes || []).forEach((d) => {
      const card = document.createElement('div');
      card.className = 'pending-card op-del';
      card.innerHTML = `<span class="emoji">🗑️</span>
        <div class="pc-main"><div class="pc-title">삭제 · ${escape(d.label || d.id)}</div></div>`;
      wrap.appendChild(card);
    });

    const total = conv.pending.reduce((s, it) => s + (Number(it.amount) || 0), 0);
    const count = conv.pending.length + opCount;
    const totalLabel = conv.pending.length ? ' ' + Core.won(total) : '';
    const actions = document.createElement('div');
    actions.className = 'pending-actions';
    actions.innerHTML =
      `<button class="btn btn-ghost btn-sm" id="pendClear">취소</button>
       <button class="btn btn-sm" id="pendSave">확인 (${count}건${totalLabel})</button>`;
    wrap.appendChild(actions);
    els.convArea.appendChild(wrap);
    document.getElementById('pendSave').addEventListener('click', confirmAll);
    document.getElementById('pendClear').addEventListener('click', () => {
      conv.pending = []; conv.pendingOps = { edits: [], deletes: [] }; renderPending();
    });
    scrollToBottom();
  }

  function fieldsSummary(f) {
    if (!f) return '';
    const p = [];
    if (f.amount != null) p.push('금액→' + Core.won(f.amount));
    if (f.category) p.push('분류→' + f.category);
    if (f.item) p.push('내용→' + f.item);
    if (f.payer) p.push('지출자→' + f.payer);
    if (f.date) p.push('날짜→' + f.date);
    if (f.payment_method) p.push('결제→' + f.payment_method);
    if (f.memo) p.push('메모→' + f.memo);
    return p.join(' · ');
  }

  // 탭으로 필드 수정 (음성 수정도 가능하지만 수동 보정용)
  function editField(idx, field) {
    const it = conv.pending[idx];
    if (field === 'payer') {
      const names = Core.state.members.map(m => m.name);
      if (!names.length) return;
      const cur = names.indexOf(it.payer);
      it.payer = names[(cur + 1) % names.length]; // 순환 토글
    } else if (field === 'amount') {
      const v = prompt('금액(원)', it.amount || '');
      if (v !== null) it.amount = Math.round(Number(v.replace(/[^\d]/g, ''))) || it.amount;
    } else if (field === 'category') {
      const cats = Core.state.categories.map(c => c.name);
      const cur = cats.indexOf(it.category);
      it.category = cats[(cur + 1) % cats.length];
    } else if (field === 'item') {
      const v = prompt('내용', it.item || '');
      if (v !== null) it.item = v.trim();
    } else if (field === 'store') {
      const v = prompt('가게 상호명', it.store || '');
      if (v !== null) it.store = v.trim();
    } else if (field === 'region') {
      const v = prompt('지역', it.region || '');
      if (v !== null) it.region = v.trim();
    } else if (field === 'payment_method') {
      const pays = Core.state.payments.map(p => p.name);
      if (pays.length) { const cur = pays.indexOf(it.payment_method); it.payment_method = pays[(cur + 1) % pays.length]; }
      else { const v = prompt('지불수단', it.payment_method || ''); if (v !== null) it.payment_method = v.trim(); }
    }
    it.needs_review = false;
    renderPending();
  }

  async function refreshToday() {
    const draw = (r) => {
      if (!r || !r.ok) return;
      els.todayTotal.textContent = Core.won(r.summary.total);
      els.todayList.innerHTML = r.expenses.length
        ? r.expenses.map(rowHtml).join('')
        : '<div class="empty">아직 오늘 지출이 없어요</div>';
    };
    try { await API.listSWR({ period: 'today' }, draw); }
    catch (e) { /* 캐시 없음 + 네트워크 실패 */ }
  }

  function rowHtml(r) {
    const sub = [escape(r.store || r.category)];
    if (r.payment_method) sub.push('💳' + escape(r.payment_method));
    return `<div class="expense-item">
      <span class="emoji">${Core.catEmoji(r.category)}</span>
      <div class="ei-main">
        <div class="ei-title">${escape(r.item || r.store || r.category)}</div>
        <div class="ei-sub">${sub.join(' · ')} ${r.payer ? '· <span class="payer-chip">' + escape(r.payer) + '</span>' : ''}</div>
      </div>
      <div class="ei-amount">${Core.won(r.amount)}</div>
    </div>`;
  }

  // ════════════════ 유틸 ════════════════
  function setMic(state) {
    els.micBtn.className = 'mic-btn' + (state && state !== 'idle' ? ' ' + state : '');
    els.micBtn.textContent = state === 'listening' ? '⏹️' : (state === 'processing' ? '…' : (state === 'speaking' ? '🔊' : '🎙️'));
  }
  function validItem(it) { return it && it.amount != null && Number(it.amount) > 0 && it.item; }
  function toAppendItem(it) {
    return {
      date: it.date, amount: Math.round(Number(it.amount)), category: it.category || '기타',
      item: it.item, store: it.store || '', region: it.region || '',
      payer: it.payer || '', payment_method: it.payment_method || '',
      memo: it.memo || '', source: it.source || 'voice', raw_text: it.raw_text || ''
    };
  }
  function pickMime() {
    const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
    return cands.find(c => MediaRecorder.isTypeSupported(c)) || '';
  }
  function blobToB64(blob) {
    return new Promise((res) => {
      const r = new FileReader();
      r.onloadend = () => res(String(r.result).split(',')[1]);
      r.readAsDataURL(blob);
    });
  }
  function escape(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
})();
