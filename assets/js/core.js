/* ============================================================
   공통 모듈 — 헤더/탭바 렌더, PIN 게이트, 유틸, 설정 캐시
   각 페이지는 Core.init({ page, onReady }) 로 부팅합니다.
   ============================================================ */
const Core = (() => {
  const state = { members: [], categories: [], payments: [], catMap: {} };

  // ── 포맷 유틸 ──
  const won = (n) => '₩' + (Number(n) || 0).toLocaleString('ko-KR');
  const todayKST = () => {
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
    return f.format(new Date()); // yyyy-mm-dd
  };
  function fmtDate(d) {
    const t = todayKST();
    if (d === t) return '오늘';
    const y = new Date(t); y.setDate(y.getDate() - 1);
    const yest = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(y);
    if (d === yest) return '어제';
    const m = String(d).slice(5);
    return m.replace('-', '월 ') + '일';
  }
  const catEmoji = (name) => state.catMap[name] || '📦';

  // ── 토스트 ──
  let toastEl;
  function toast(msg, ms = 1800) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'toast'; document.body.appendChild(toastEl); }
    toastEl.textContent = msg; toastEl.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => toastEl.classList.remove('show'), ms);
  }

  // ── 헤더 + 탭바 ──
  function renderChrome(page, headerExtra) {
    const app = document.querySelector('.app');
    const header = document.createElement('header');
    header.className = 'app-header';
    header.innerHTML = `<h1>가계부</h1><div class="header-sum" id="headerSum">${headerExtra || ''}</div>`;
    app.prepend(header);

    const tabs = [
      { id: 'index',    href: 'index.html',    ico: '🎙️', label: '입력' },
      { id: 'history',  href: 'history.html',  ico: '📜', label: '내역' },
      { id: 'stats',    href: 'stats.html',    ico: '📊', label: '통계' },
      { id: 'payments', href: 'payments.html', ico: '💳', label: '결제' },
      { id: 'settings', href: 'settings.html', ico: '⚙️', label: '설정' }
    ];
    const bar = document.createElement('nav');
    bar.className = 'tab-bar';
    bar.innerHTML = tabs.map(t =>
      `<a class="tab-item ${t.id === page ? 'active' : ''}" href="${t.href}">
         <span class="tab-ico">${t.ico}</span><span>${t.label}</span></a>`).join('');
    document.body.appendChild(bar);
  }

  // ── PIN 게이트 ──
  function showPinGate() {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'pin-overlay';
      ov.innerHTML = `
        <div class="pin-box card">
          <div class="pin-logo">가계부</div>
          <p>PIN을 입력하세요</p>
          <input id="pinInput" type="password" inputmode="numeric" maxlength="8" autocomplete="off" />
          <div class="pin-error" id="pinError"></div>
          <button class="btn" id="pinBtn" style="width:100%;margin-top:14px;">열기</button>
        </div>`;
      document.body.appendChild(ov);
      const input = ov.querySelector('#pinInput');
      const errEl = ov.querySelector('#pinError');
      const btn = ov.querySelector('#pinBtn');
      input.focus();

      async function submit() {
        const pin = input.value.trim();
        if (!pin) return;
        btn.disabled = true; errEl.textContent = '확인 중…';
        try {
          const cfg = await API.verifyPin(pin);
          if (cfg) { applyConfig(cfg); cacheConfig(cfg); ov.remove(); resolve(true); }
          else { errEl.textContent = 'PIN이 올바르지 않습니다'; input.value = ''; btn.disabled = false; }
        } catch (e) {
          errEl.textContent = '연결 실패: ' + (e.message || e); btn.disabled = false;
        }
      }
      btn.addEventListener('click', submit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    });
  }

  function applyConfig(cfg) {
    state.members = cfg.members || [];
    state.categories = cfg.categories || [];
    state.payments = cfg.payments || [];
    state.catMap = {};
    state.categories.forEach(c => { state.catMap[c.name] = c.emoji || '📦'; });
  }

  // ── 기기 사용자(지출자 자동 구분) ──
  const DEV_KEY = 'ledger_device_owner';
  function getDeviceOwner() { return localStorage.getItem(DEV_KEY) || ''; }
  function setDeviceOwner(n) { if (n) localStorage.setItem(DEV_KEY, n); else localStorage.removeItem(DEV_KEY); }
  function ensureDeviceOwner() {
    return new Promise((resolve) => {
      const names = state.members.map(m => m.name);
      const cur = getDeviceOwner();
      if (!names.length) { resolve(); return; }
      if (cur && names.indexOf(cur) >= 0) { resolve(); return; }
      if (names.length === 1) { setDeviceOwner(names[0]); resolve(); return; }
      const ov = document.createElement('div');
      ov.className = 'pin-overlay';
      ov.innerHTML = `<div class="pin-box card">
        <div class="pin-logo">👋</div>
        <p>이 기기는 누가 사용하나요?<br><span style="font-size:0.75rem">선택하면 지출자가 자동 입력됩니다 (설정에서 변경 가능)</span></p>
        <div id="ownerBtns" style="display:flex;flex-direction:column;gap:10px;margin-top:16px"></div></div>`;
      document.body.appendChild(ov);
      const box = ov.querySelector('#ownerBtns');
      state.members.forEach(m => {
        const b = document.createElement('button');
        b.className = 'btn'; b.style.width = '100%';
        b.textContent = (m.emoji || '👤') + ' ' + m.name;
        b.addEventListener('click', () => { setDeviceOwner(m.name); ov.remove(); resolve(); });
        box.appendChild(b);
      });
    });
  }

  // ── 설정 캐시(빠른 시작) ──
  const CFG_KEY = 'ledger_config_cache';
  function cacheConfig(cfg) { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (_) {} }
  function loadCachedConfig() { try { return JSON.parse(localStorage.getItem(CFG_KEY)); } catch (_) { return null; } }
  function revalidateConfig() {
    API.config().then(cfg => {
      if (cfg && cfg.ok) { applyConfig(cfg); cacheConfig(cfg); }
      else if (cfg && cfg.error === 'unauthorized') { API.clearPin(); location.reload(); }
    }).catch(() => {});
  }

  // ── 부팅 ──
  async function init({ page, headerExtra }) {
    // 서비스워커 등록(PWA/오프라인) + TTS 설정 반영
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('service-worker.js').catch(() => {});
    }
    const ttsPref = localStorage.getItem('ledger_tts');
    if (ttsPref !== null && window.LEDGER_CONFIG) window.LEDGER_CONFIG.tts = ttsPref === '1';

    if (!API.configured()) {
      document.body.innerHTML = '<div style="padding:40px;text-align:center;color:#a55">' +
        '⚠️ <b>assets/js/config.js</b> 의 GAS_URL을 설정하세요.<br>README 참고.</div>';
      throw new Error('not_configured');
    }
    renderChrome(page, headerExtra);

    // 빠른 시작: PIN + 캐시가 있으면 즉시 시작, 백그라운드에서 검증·갱신
    const cached = loadCachedConfig();
    if (API.getPin() && cached && cached.ok) {
      applyConfig(cached);
      revalidateConfig();
      await ensureDeviceOwner();
      API.flushQueue();
      return state;
    }

    // 캐시 없음/미인증 → 1회 블로킹 인증
    let authed = false;
    if (API.getPin()) {
      try {
        const cfg = await API.config();
        if (cfg && cfg.ok) { applyConfig(cfg); cacheConfig(cfg); authed = true; }
        else API.clearPin();
      } catch (_) { /* 네트워크 문제 → PIN 게이트로 */ }
    }
    if (!authed) await showPinGate();
    await ensureDeviceOwner();
    API.flushQueue();
    return state;
  }

  return { state, init, won, todayKST, fmtDate, catEmoji, toast, getDeviceOwner, setDeviceOwner };
})();
