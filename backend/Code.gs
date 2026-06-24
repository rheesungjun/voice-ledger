/**
 * 대화형 가계부 (Voice Ledger) — Google Apps Script 백엔드
 *
 * GitHub Pages(정적) 프론트엔드의 서버리스 백엔드.
 * - Gemini API 키를 Script Properties에 은닉하고 프록시
 * - 소유자 권한으로 Google Sheet 읽기/쓰기
 * - PIN 인증(해시) + 레이트리밋
 *
 * 설정해야 할 Script Properties (파일 > 프로젝트 설정 > 스크립트 속성):
 *   GEMINI_API_KEY : Gemini API 키
 *   PIN_HASH       : PIN의 SHA-256 16진 해시 (setup_setPin() 으로 생성)
 *   SHEET_ID       : (선택) 바인딩되지 않은 경우 대상 스프레드시트 ID
 *
 * AI 모델 규칙: Gemini 3 계열만 사용 (1.5/2.0 금지).
 */

// ───────────────────────── 상수 ─────────────────────────
var MODEL_LIST = ['gemini-3-flash-preview', 'gemini-3.1-flash-lite-preview'];
var GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';
var KST = 'GMT+9';
var SCHEMA_VERSION = 2;

// 시트 스키마 (헤더). 컬럼 추가는 점진 마이그레이션, 절대 삭제/초기화 금지.
// 읽기/쓰기는 모두 헤더 기준(headerIndex)이라 물리적 컬럼 순서가 달라도 안전.
var SCHEMA = {
  expenses: ['id', 'date', 'amount', 'category', 'item', 'store', 'region', 'payer',
             'payment_method', 'memo', 'created_at', 'source', 'raw_text', 'status'],
  members:    ['name', 'emoji', 'aliases'],
  categories: ['name', 'emoji', 'budget'],
  payments:   ['name', 'type', 'target', 'benefit', 'note'],
  meta:       ['key', 'value']
};

var DEFAULT_MEMBERS = [
  ['jun', '🧑', '준,내,나'],
  ['jin', '👩', '진,진이,자기']
];
var DEFAULT_CATEGORIES = [
  ['식비', '🍚', ''], ['카페/간식', '☕', ''], ['교통', '🚌', ''],
  ['생활/마트', '🛒', ''], ['주거/공과금', '🏠', ''], ['의료/건강', '💊', ''],
  ['문화/여가', '🎬', ''], ['쇼핑', '🛍️', ''], ['경조사', '🎁', ''], ['기타', '📦', '']
];
// 지불수단: name, type(카드/현금/계좌/페이), target(월 실적 목표 원), benefit(혜택), note
var DEFAULT_PAYMENTS = [
  ['현금', '현금', 0, '', '']
];

// ───────────────────────── 진입점 ─────────────────────────
function doGet(e)  { return handle(e); }
function doPost(e) { return handle(e); }

function handle(e) {
  try {
    var params = parseParams(e);
    var action = params.action;

    if (action === 'ping') return json({ ok: true, version: SCHEMA_VERSION });

    if (!checkPin(params.pin)) {
      return json({ ok: false, error: 'unauthorized' });
    }

    ensureSheets();

    var result;
    switch (action) {
      case 'config':   result = apiConfig();          break;
      case 'converse': result = apiConverse(params);  break;
      case 'append':   result = apiAppend(params);    break;
      case 'list':     result = apiList(params);      break;
      case 'update':   result = apiUpdate(params);    break;
      case 'delete':   result = apiDelete(params);    break;
      case 'paymentSave':   result = apiPaymentSave(params);   break;
      case 'paymentDelete': result = apiPaymentDelete(params); break;
      default:         result = { ok: false, error: 'unknown_action: ' + action };
    }
    return json(result);
  } catch (err) {
    return json({ ok: false, error: String(err && err.stack || err) });
  }
}

function parseParams(e) {
  var p = {};
  if (e && e.postData && e.postData.contents) {
    try { p = JSON.parse(e.postData.contents); } catch (_) { p = {}; }
  }
  if (e && e.parameter) {
    for (var k in e.parameter) { if (!(k in p)) p[k] = e.parameter[k]; }
  }
  return p;
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ───────────────────────── 인증 ─────────────────────────
function checkPin(pin) {
  if (!pin) return false;
  var props = PropertiesService.getScriptProperties();
  var stored = props.getProperty('PIN_HASH');
  if (!stored) return false;

  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get('pin_fails') || 0);
  if (fails >= 5) return false; // 10분간 5회 실패 시 차단

  if (sha256(String(pin)) !== stored) {
    cache.put('pin_fails', String(fails + 1), 600);
    return false;
  }
  return true;
}

function sha256(str) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  return raw.map(function (b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join('');
}

/** 1회용: PIN 설정. 에디터에서 값 바꿔 실행 → 콘솔의 해시를 PIN_HASH에 저장됨(자동). */
function setup_setPin() {
  var PIN = '1234'; // ← 원하는 PIN으로 바꾸고 1회 실행 후 이 줄을 되돌리세요
  PropertiesService.getScriptProperties().setProperty('PIN_HASH', sha256(PIN));
  Logger.log('PIN_HASH 설정 완료');
}

// ───────────────────────── 시트 유틸 ─────────────────────────
function ssBook() {
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function ensureSheets() {
  var book = ssBook();
  Object.keys(SCHEMA).forEach(function (name) {
    var sh = book.getSheetByName(name);
    if (!sh) sh = book.insertSheet(name);
    var headers = SCHEMA[name];
    var width = Math.max(headers.length, sh.getLastColumn() || 1);
    var firstRow = sh.getRange(1, 1, 1, width).getValues()[0];
    if (firstRow.join('') === '') {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    } else {
      // 점진 마이그레이션: 누락된 컬럼만 추가 (기존 데이터 보존)
      headers.forEach(function (h, i) {
        if (firstRow.indexOf(h) === -1) {
          sh.getRange(1, sh.getLastColumn() + 1).setValue(h);
        }
      });
    }
  });
  seedDefaults(book);
}

function seedDefaults(book) {
  var m = book.getSheetByName('members');
  if (m.getLastRow() < 2) m.getRange(2, 1, DEFAULT_MEMBERS.length, 3).setValues(DEFAULT_MEMBERS);
  var c = book.getSheetByName('categories');
  if (c.getLastRow() < 2) c.getRange(2, 1, DEFAULT_CATEGORIES.length, 3).setValues(DEFAULT_CATEGORIES);
  var p = book.getSheetByName('payments');
  if (p && p.getLastRow() < 2) p.getRange(2, 1, DEFAULT_PAYMENTS.length, DEFAULT_PAYMENTS[0].length).setValues(DEFAULT_PAYMENTS);
  var meta = book.getSheetByName('meta');
  if (meta.getLastRow() < 2) meta.getRange(2, 1, 1, 2).setValues([['schema_version', SCHEMA_VERSION]]);
}

/** 시트를 [{header:value}] 객체 배열로 읽기 */
function readObjects(name) {
  var sh = ssBook().getSheetByName(name);
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0];
  return values.slice(1).map(function (row) {
    var o = {};
    headers.forEach(function (h, i) { o[h] = row[i]; });
    return o;
  });
}

/** 시트의 실제 헤더와 인덱스 맵 (물리 컬럼 순서 기준) */
function headerIndex(sh) {
  var headers = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
  var idx = {};
  headers.forEach(function (h, i) { if (h !== '') idx[h] = i; });
  return { headers: headers, idx: idx };
}

// ───────────────────────── API: config ─────────────────────────
function apiConfig() {
  return {
    ok: true,
    schema_version: SCHEMA_VERSION,
    members: readObjects('members').filter(function (r) { return r.name; }),
    categories: readObjects('categories').filter(function (r) { return r.name; }),
    payments: readObjects('payments').filter(function (r) { return r.name; }).map(function (r) {
      return { name: r.name, type: r.type, target: Number(r.target) || 0, benefit: r.benefit, note: r.note };
    })
  };
}

// ───────────────────────── API: converse (Gemini) ─────────────────────────
function apiConverse(params) {
  var memberRows = readObjects('members').filter(function (r) { return r.name; })
    .map(function (r) { return { name: r.name, aliases: r.aliases || '' }; });
  var categories = readObjects('categories').map(function (r) { return r.name; }).filter(String);
  var payments = readObjects('payments').map(function (r) { return r.name; }).filter(String);
  var deviceOwner = params.device_owner || '';
  var today = Utilities.formatDate(new Date(), KST, 'yyyy-MM-dd');
  var weekday = ['일', '월', '화', '수', '목', '금', '토'][Number(Utilities.formatDate(new Date(), KST, 'u')) % 7];

  // 이미 저장된 최근 내역(수정/삭제 대상) — id 포함, 최대 40건
  var recent = readObjects('expenses')
    .filter(function (r) { return r.id && r.status !== 'deleted'; })
    .map(function (r) {
      return { id: r.id, date: toDateStr(r.date), amount: Number(r.amount) || 0,
               category: r.category, item: r.item, store: r.store, payer: r.payer,
               payment_method: r.payment_method };
    })
    .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); })
    .slice(0, 40);

  var system = buildPrompt(today, weekday, memberRows, categories, payments, deviceOwner,
                           params.history || [], params.pending || [], recent);

  var parts = [{ text: system }];
  if (params.audio_base64) {
    parts.push({ inline_data: { mime_type: params.mime || 'audio/webm', data: params.audio_base64 } });
  } else if (params.text) {
    parts.push({ text: '사용자 발화(텍스트): ' + params.text });
  } else {
    return { ok: false, error: 'no_input' };
  }

  var out = callGemini(parts);
  // 카테고리/지출자 정규화 가드 (Gemini가 벗어난 값 반환 시 보정)
  (out.items || []).forEach(function (it) {
    if (it.category && categories.indexOf(it.category) === -1) it.category = '기타';
    if (it.amount != null) it.amount = Math.round(Number(it.amount)) || null;
    if (!it.date) it.date = today;
    if (!it.payer && deviceOwner) it.payer = deviceOwner;
  });
  (out.edits || []).forEach(function (e) {
    if (e.fields) {
      if (e.fields.category && categories.indexOf(e.fields.category) === -1) e.fields.category = '기타';
      if (e.fields.amount != null) e.fields.amount = Math.round(Number(e.fields.amount)) || null;
    }
  });
  return {
    ok: true,
    transcript: out.transcript || '',
    reply: out.reply || '',
    intent: out.intent || 'propose',
    items: out.items || [],
    edits: out.edits || [],
    deletes: out.deletes || []
  };
}

function buildPrompt(today, weekday, memberRows, categories, payments, deviceOwner, history, pending, recent) {
  return [
    '당신은 한국어 음성 가계부 비서입니다. 사용자의 발화(오디오 또는 텍스트)를 받아 지출 내역을 구조화합니다.',
    '오늘 날짜: ' + today + ' (' + weekday + '요일, KST). "어제/그제/지난 금요일" 등 상대표현은 이 기준으로 해석하세요.',
    '구성원(payer는 반드시 이들의 name 중 하나): ' + JSON.stringify(memberRows) + '. aliases는 그 사람을 부르는 호칭입니다.',
    (deviceOwner
      ? '이 기기 사용자는 "' + deviceOwner + '" 입니다. 화자 자신("내가/나/제가") 또는 지출자를 명시하지 않으면 payer="' + deviceOwner + '". 다른 구성원을 호칭/이름으로 명시하면(예: "아내가","자기가") 그 사람으로 설정.'
      : '"내가/나"는 화자, 상대 호칭은 다른 구성원으로 매핑하세요.'),
    '사용 가능한 카테고리(이 목록 안에서만 고르세요, 새로 만들지 마세요): ' + JSON.stringify(categories) + '. 애매하면 "기타".',
    '등록된 지불수단(payment_method는 가능하면 이 목록의 이름으로 매핑): ' + JSON.stringify(payments) + '.',
    '금액은 한국어 표현을 정수(원)로 변환: "삼천오백원"→3500, "만오천"→15000, "3만2천"→32000.',
    '한 발화에 여러 지출이 있으면 각각 별도 항목으로 분리하세요.',
    '',
    '[완전한 지출 1건의 필수 정보] amount(금액), item(품목/내용), store(가게 상호명), region(지역), payment_method(지불수단), payer(지출자), date(날짜).',
    '★중요: 사용자가 말하지 않아 비어있는 필수 정보가 있으면, 추측해서 채우거나 confirm 하지 마세요.',
    '대신 intent=propose(또는 correct)로 두고 reply 에서 부족한 항목을 자연스럽게 한두 개씩 되물으세요.',
    '   (예: "어느 가게에서 쓰셨어요?", "무슨 카드로 결제했어요?", "지역은 어디였어요?")',
    '모든 필수 정보가 채워졌을 때만 reply 로 "이대로 저장할까요?"라고 확인을 요청하세요.',
    '사용자가 "없어/몰라/현금이야"처럼 명시하면 그 값으로 두거나 null + needs_review=true 로 표시한 뒤 진행하세요.',
    '',
    '대화 맥락(이전 턴):',
    'history = ' + JSON.stringify(history),
    '현재까지 제안된(미저장) 항목 pending = ' + JSON.stringify(pending),
    '',
    '이미 저장된 최근 내역(수정/삭제 대상, id 포함):',
    'recent = ' + JSON.stringify(recent),
    '',
    '이번 발화의 의도를 intent 로 분류하세요:',
    ' - "propose": 새 지출을 말함 (items에 추가). 필수 정보가 부족하면 reply로 되물음.',
    ' - "correct": 미저장 제안(pending)을 수정/보완 ("그건 5천원", "스타벅스 강남점이야") → items 전체를 다시 출력',
    ' - "confirm": 동의 ("저장해", "응 맞아", "기록해", "그래") — 필수 정보가 모두 찼을 때만',
    ' - "cancel": 취소 ("아니", "취소", "됐어")',
    ' - "edit": 이미 저장된 내역을 수정 요청 ("어제 점심 9천원을 만원으로")',
    ' - "delete": 이미 저장된 내역을 삭제 요청 ("아까 커피 지출 지워줘")',
    ' - "chitchat": 잡담/무관',
    '',
    'edit/delete 규칙(중요):',
    ' - recent 목록에서 날짜·내용·금액·지출자 단서로 대상 행을 찾아 그 id 를 사용하세요.',
    ' - edit → edits=[{id, label, fields:{바꿀 필드만}}]. label은 사람이 읽을 설명(예: "어제 점심 9000원").',
    ' - delete → deletes=[{id, label}].',
    ' - 반드시 reply 로 확인을 요청하세요(예: "어제 점심 9000원을 10000원으로 바꿀까요?"). 실제 변경은 사용자가 동의(intent=confirm)한 다음에만 일어납니다.',
    ' - 대상이 모호하거나 후보가 여러 개면 edits/deletes 를 비우고 reply 로 어느 것인지 되물으세요.',
    ' - 수정/삭제 요청이 아니면 edits, deletes 는 빈 배열로 두세요.',
    '',
    '반드시 아래 JSON 스키마로만 응답하세요. items는 미저장 제안의 현재 전체 상태입니다.',
    'reply는 음성으로 읽어줄 짧고 자연스러운 한국어 한 문장입니다.'
  ].join('\n');
}

var RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    transcript: { type: 'string' },
    reply: { type: 'string' },
    intent: { type: 'string', enum: ['propose', 'correct', 'confirm', 'cancel', 'edit', 'delete', 'chitchat'] },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date:           { type: 'string' },
          amount:         { type: 'number', nullable: true },
          category:       { type: 'string', nullable: true },
          item:           { type: 'string', nullable: true },
          store:          { type: 'string', nullable: true },
          region:         { type: 'string', nullable: true },
          payer:          { type: 'string', nullable: true },
          payment_method: { type: 'string', nullable: true },
          memo:           { type: 'string', nullable: true },
          confidence:     { type: 'number', nullable: true },
          needs_review:   { type: 'boolean' }
        },
        required: ['date', 'amount', 'item']
      }
    },
    edits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id:    { type: 'string' },
          label: { type: 'string' },
          fields: {
            type: 'object',
            properties: {
              amount:         { type: 'number', nullable: true },
              category:       { type: 'string', nullable: true },
              item:           { type: 'string', nullable: true },
              store:          { type: 'string', nullable: true },
              region:         { type: 'string', nullable: true },
              payer:          { type: 'string', nullable: true },
              date:           { type: 'string', nullable: true },
              payment_method: { type: 'string', nullable: true },
              memo:           { type: 'string', nullable: true }
            }
          }
        },
        required: ['id']
      }
    },
    deletes: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, label: { type: 'string' } },
        required: ['id']
      }
    }
  },
  required: ['transcript', 'reply', 'intent', 'items']
};

function callGemini(parts) {
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY 미설정');

  var payload = {
    contents: [{ role: 'user', parts: parts }],
    generationConfig: {
      response_mime_type: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.2
    }
  };

  var lastErr = '';
  for (var i = 0; i < MODEL_LIST.length; i++) {
    var url = GEMINI_ENDPOINT + MODEL_LIST[i] + ':generateContent?key=' + key;
    try {
      var res = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      var code = res.getResponseCode();
      if (code === 200) {
        var data = JSON.parse(res.getContentText());
        var text = data.candidates[0].content.parts[0].text;
        return JSON.parse(text);
      }
      lastErr = MODEL_LIST[i] + ' → HTTP ' + code + ': ' + res.getContentText().slice(0, 200);
    } catch (e) {
      lastErr = MODEL_LIST[i] + ' → ' + e;
    }
  }
  throw new Error('Gemini 호출 실패: ' + lastErr);
}

// ───────────────────────── API: append ─────────────────────────
function apiAppend(params) {
  var items = params.items || [];
  if (!items.length) return { ok: false, error: 'no_items' };
  var sh = ssBook().getSheetByName('expenses');
  var now = Utilities.formatDate(new Date(), KST, "yyyy-MM-dd'T'HH:mm:ssXXX");
  var today = Utilities.formatDate(new Date(), KST, 'yyyy-MM-dd');
  var saved = [];

  var H = headerIndex(sh);
  items.forEach(function (it) {
    var id = it.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
    var rec = {
      id: id, date: it.date || today, amount: Number(it.amount) || 0,
      category: it.category || '기타', item: it.item || '',
      store: it.store || '', region: it.region || '',
      payer: it.payer || '', payment_method: it.payment_method || '',
      memo: it.memo || '', created_at: now, source: it.source || 'voice',
      raw_text: it.raw_text || '', status: 'active'
    };
    var row = H.headers.map(function (h) { return rec[h] !== undefined ? rec[h] : ''; });
    sh.appendRow(row);
    saved.push({ id: id, date: rec.date, amount: rec.amount, category: rec.category,
                 item: rec.item, store: rec.store, payer: rec.payer, payment_method: rec.payment_method });
  });
  return { ok: true, saved: saved };
}

// ───────────────────────── API: list ─────────────────────────
function apiList(params) {
  var rows = readObjects('expenses').filter(function (r) {
    return r.id && r.status !== 'deleted';
  });

  var period = params.period || 'month';
  var range = resolveRange(period, params.from, params.to);
  var filtered = rows.filter(function (r) {
    var d = toDateStr(r.date);
    return (!range.from || d >= range.from) && (!range.to || d <= range.to);
  });

  // 요약 계산
  var total = 0, byCategory = {}, byPayer = {}, byPayment = {};
  filtered.forEach(function (r) {
    var amt = Number(r.amount) || 0;
    total += amt;
    byCategory[r.category] = (byCategory[r.category] || 0) + amt;
    byPayer[r.payer] = (byPayer[r.payer] || 0) + amt;
    if (r.payment_method) byPayment[r.payment_method] = (byPayment[r.payment_method] || 0) + amt;
  });

  filtered.sort(function (a, b) {
    return String(b.date).localeCompare(String(a.date)) ||
           String(b.created_at).localeCompare(String(a.created_at));
  });

  return {
    ok: true,
    range: range,
    expenses: filtered.map(function (r) {
      return {
        id: r.id, date: toDateStr(r.date), amount: Number(r.amount) || 0,
        category: r.category, item: r.item, store: r.store, region: r.region,
        payer: r.payer, payment_method: r.payment_method, memo: r.memo
      };
    }),
    summary: { total: total, count: filtered.length, byCategory: byCategory,
               byPayer: byPayer, byPayment: byPayment }
  };
}

function resolveRange(period, from, to) {
  var now = new Date();
  if (period === 'today') {
    var t = Utilities.formatDate(now, KST, 'yyyy-MM-dd');
    return { from: t, to: t };
  }
  if (period === 'range') return { from: from || '', to: to || '' };
  // month (기본): 이번 달 1일 ~ 말일
  var ym = Utilities.formatDate(now, KST, 'yyyy-MM');
  return { from: ym + '-01', to: ym + '-31' };
}

function toDateStr(v) {
  if (v instanceof Date) return Utilities.formatDate(v, KST, 'yyyy-MM-dd');
  return String(v).slice(0, 10);
}

// ───────────────────────── API: update / delete ─────────────────────────
function findRowIndexById(sh, id) {
  var H = headerIndex(sh);
  var idCol = (H.idx['id'] || 0) + 1;
  var n = Math.max(sh.getLastRow() - 1, 0);
  if (n < 1) return -1;
  var ids = sh.getRange(2, idCol, n, 1).getValues();
  for (var i = 0; i < ids.length; i++) { if (ids[i][0] === id) return i + 2; }
  return -1;
}

function apiUpdate(params) {
  var sh = ssBook().getSheetByName('expenses');
  var rowIdx = findRowIndexById(sh, params.id);
  if (rowIdx < 0) return { ok: false, error: 'not_found' };
  var H = headerIndex(sh);
  var fields = params.fields || {};
  Object.keys(fields).forEach(function (k) {
    if (H.idx[k] !== undefined) sh.getRange(rowIdx, H.idx[k] + 1).setValue(fields[k]);
  });
  return { ok: true, id: params.id };
}

function apiDelete(params) {
  var sh = ssBook().getSheetByName('expenses');
  var rowIdx = findRowIndexById(sh, params.id);
  if (rowIdx < 0) return { ok: false, error: 'not_found' };
  var H = headerIndex(sh);
  if (H.idx['status'] === undefined) return { ok: false, error: 'no_status_col' };
  sh.getRange(rowIdx, H.idx['status'] + 1).setValue('deleted'); // 소프트 삭제
  return { ok: true, id: params.id };
}

// ───────────────────────── API: payments (지불수단 관리) ─────────────────────────
function apiPaymentSave(params) {
  var p = params.payment || {};
  if (!p.name) return { ok: false, error: 'no_name' };
  var sh = ssBook().getSheetByName('payments');
  var H = headerIndex(sh);
  var rec = {
    name: String(p.name), type: p.type || '카드',
    target: Number(p.target) || 0, benefit: p.benefit || '', note: p.note || ''
  };
  // 이름으로 upsert
  var n = Math.max(sh.getLastRow() - 1, 0);
  var nameCol = (H.idx['name'] || 0) + 1;
  var rowIdx = -1;
  if (n >= 1) {
    var names = sh.getRange(2, nameCol, n, 1).getValues();
    for (var i = 0; i < names.length; i++) { if (String(names[i][0]) === rec.name) { rowIdx = i + 2; break; } }
  }
  var row = H.headers.map(function (h) { return rec[h] !== undefined ? rec[h] : ''; });
  if (rowIdx < 0) sh.appendRow(row);
  else sh.getRange(rowIdx, 1, 1, row.length).setValues([row]);
  return { ok: true, payment: rec };
}

function apiPaymentDelete(params) {
  var sh = ssBook().getSheetByName('payments');
  var H = headerIndex(sh);
  var n = Math.max(sh.getLastRow() - 1, 0);
  if (n < 1) return { ok: false, error: 'not_found' };
  var nameCol = (H.idx['name'] || 0) + 1;
  var names = sh.getRange(2, nameCol, n, 1).getValues();
  for (var i = 0; i < names.length; i++) {
    if (String(names[i][0]) === String(params.name)) { sh.deleteRow(i + 2); return { ok: true, name: params.name }; }
  }
  return { ok: false, error: 'not_found' };
}
