/* ============================================================
   GAS 클라이언트 + 오프라인 큐
   - CORS preflight 회피: Content-Type을 text/plain 으로 전송
   - PIN은 localStorage 에 보관(앱 재방문 시 자동 인증)
   ============================================================ */
const API = (() => {
  const cfg = window.LEDGER_CONFIG;
  const PIN_KEY = 'ledger_pin';
  const QUEUE_KEY = 'ledger_outbox';

  const getPin = () => localStorage.getItem(PIN_KEY) || '';
  const setPin = (p) => localStorage.setItem(PIN_KEY, p);
  const clearPin = () => localStorage.removeItem(PIN_KEY);

  function configured() {
    return cfg.GAS_URL && !cfg.GAS_URL.startsWith('PASTE_');
  }

  async function call(action, payload = {}) {
    if (!configured()) throw new Error('GAS_URL 미설정 (assets/js/config.js)');
    const body = JSON.stringify(Object.assign({ action, pin: getPin() }, payload));
    const res = await fetch(cfg.GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body,
      redirect: 'follow'
    });
    const data = await res.json();
    if (data && data.ok === false && data.error === 'unauthorized') {
      const err = new Error('unauthorized');
      err.code = 'unauthorized';
      throw err;
    }
    return data;
  }

  // PIN 검증: config 호출이 성공하면 OK
  async function verifyPin(pin) {
    setPin(pin);
    try {
      const r = await call('config');
      if (r && r.ok) return r;
      clearPin();
      return null;
    } catch (e) {
      clearPin();
      throw e;
    }
  }

  // ── 오프라인 큐 (append 전용) ──
  function loadQueue() { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; } }
  function saveQueue(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }
  function enqueue(items) { const q = loadQueue(); q.push({ items, ts: Date.now() }); saveQueue(q); }

  async function append(items) {
    try {
      const r = await call('append', { items });
      if (r && r.ok) return r;
      throw new Error(r && r.error || 'append_failed');
    } catch (e) {
      enqueue(items);           // 실패 시 큐에 보관
      throw e;
    }
  }

  async function flushQueue() {
    const q = loadQueue();
    if (!q.length) return { flushed: 0 };
    const remaining = [];
    let flushed = 0;
    for (const job of q) {
      try { const r = await call('append', { items: job.items }); if (r && r.ok) flushed++; else remaining.push(job); }
      catch { remaining.push(job); }
    }
    saveQueue(remaining);
    return { flushed, remaining: remaining.length };
  }

  // ── 읽기 캐시 (stale-while-revalidate) ──
  function cacheGet(key) { try { return JSON.parse(localStorage.getItem('c_' + key)); } catch { return null; } }
  function cacheSet(key, val) { try { localStorage.setItem('c_' + key, JSON.stringify(val)); } catch {} }
  async function listSWR(params, onData) {
    const key = 'list_' + JSON.stringify(params || {});
    const cached = cacheGet(key);
    if (cached) { try { onData(cached, true); } catch (_) {} }   // 캐시 즉시 표시
    try {
      const fresh = await call('list', params);
      if (fresh && fresh.ok) { cacheSet(key, fresh); onData(fresh, false); }  // 최신으로 갱신
      return fresh;
    } catch (e) { if (cached) return cached; throw e; }
  }

  return {
    cfg, configured, call,
    getPin, setPin, clearPin, verifyPin,
    config: () => call('config'),
    converse: (p) => call('converse', p),
    append,
    list: (p) => call('list', p),
    listSWR,
    update: (id, fields) => call('update', { id, fields }),
    remove: (id) => call('delete', { id }),
    paymentSave: (payment) => call('paymentSave', { payment }),
    paymentDelete: (name) => call('paymentDelete', { name }),
    queueSize: () => loadQueue().length,
    flushQueue
  };
})();
