# 대화형 가계부 (Voice Ledger)

핸드폰에서 **말로** 지출을 기록하는 가계부.
대화 버튼을 누르고 말하면 → 무음이 감지되면 자동 종료 → Gemini가 받아쓰기·구조화 →
음성(TTS)·화면으로 확인 → "저장해" → Google Sheet에 기록됩니다.

```
[모바일 브라우저/PWA]  ──정적──  GitHub Pages (이 저장소의 HTML/CSS/JS)
        │ fetch (text/plain)
        ▼
[Google Apps Script Web App]  ← Gemini 키 은닉 + Sheet 읽기/쓰기 (backend/Code.gs)
        ▼
[Google Sheet]  ← 데이터 저장 (expenses / members / categories / meta)
```

- 비용: GitHub Pages·Sheets·GAS 무료, Gemini는 개인 사용 시 사실상 ₩0.
- 데이터는 **본인 Google Sheet + 본인 Gemini 키** 안에만 존재. 제3자 서버 없음.
- AI 모델: `gemini-3-flash-preview`(메인) → `gemini-3.1-flash-lite-preview`(폴백).

---

## 설치 (한 번만)

### 1. Google Sheet 만들기
1. [sheets.new](https://sheets.new) 로 새 스프레드시트 생성. 이름은 자유(예: `가계부`).
2. 탭/헤더는 **자동 생성**됩니다(첫 API 호출 시 `ensureSheets()`가 `expenses/members/categories/meta` 생성 + 기본 카테고리·구성원 시드).

### 2. Apps Script 백엔드 배포
1. 위 스프레드시트에서 **확장 프로그램 → Apps Script**.
2. 기본 `Code.gs` 내용을 지우고 [backend/Code.gs](backend/Code.gs) 전체를 붙여넣기.
3. (선택) 매니페스트를 [backend/appsscript.json](backend/appsscript.json) 내용으로 맞추려면:
   프로젝트 설정 → "appsscript.json 매니페스트 파일 표시" 체크 후 교체.
4. **스크립트 속성 설정** — 프로젝트 설정(⚙️) → 스크립트 속성 → 속성 추가:
   - `GEMINI_API_KEY` = (https://aistudio.google.com/apikey 에서 발급)
   - `SHEET_ID` = (스프레드시트가 스크립트에 바인딩되어 있으면 생략 가능. 별도 ID 쓰려면 URL의 `/d/<ID>/` 부분)
5. **PIN 설정**: 편집기에서 `setup_setPin()` 함수의 `var PIN = '1234';` 를 원하는 번호로 바꾸고 ▶ 실행(최초 1회 권한 승인). 실행 후 그 줄은 원래대로 되돌립니다(코드에 PIN 남기지 않기).
6. **배포**: 우상단 **배포 → 새 배포 → 유형: 웹 앱**
   - 설명: voice-ledger
   - 실행 계정: **나**
   - 액세스 권한: **모든 사용자**  *(URL을 알아도 PIN 없이는 접근 불가)*
   - 배포 후 나오는 **웹 앱 URL**(`https://script.google.com/macros/s/.../exec`)을 복사.

> 코드를 수정하면 매번 **배포 관리 → 편집(연필) → 새 버전**으로 재배포해야 반영됩니다.

### 3. 프론트엔드 설정
1. [assets/js/config.js](assets/js/config.js) 의 `GAS_URL` 에 위 웹 앱 URL을 붙여넣기.
2. 로컬 테스트: 이 폴더에서 정적 서버 실행 후 폰/브라우저로 접속.
   ```bash
   python -m http.server 5500
   # http://localhost:5500  접속 → PIN 입력
   ```
3. GitHub Pages 배포:
   - 이 폴더를 GitHub 저장소로 push.
   - 저장소 Settings → Pages → Source: `main` 브랜치 `/ (root)` → 저장.
   - 몇 분 뒤 `https://<user>.github.io/<repo>/` 에서 접속.
   - 폰 브라우저에서 열고 **공유 → 홈 화면에 추가**(PWA 설치)하면 앱처럼 사용.

---

## 사용법

- **대화 버튼**(하단 큰 버튼) 탭 → 말하기 → 1.5초 정도 멈추면 자동 전송.
- 예: *"어제 점심 김치찌개 9천원 내가 냈고, 커피는 진이가 4500원"* → 2건 제안.
- 비서가 *"… 기록할까요?"* 라고 음성·화면으로 물으면 **"저장해"** 또는 카드의 저장 버튼.
- 수정도 말로: *"커피는 5천원이야"*, *"지출자 진이로"*. 종료: **"끝"** 또는 종료 버튼.

### 카테고리·구성원 바꾸기
스프레드시트의 `categories` / `members` 탭을 직접 편집하면 됩니다(코드 재배포 불필요).
- `members` 의 `aliases` 열(쉼표 구분)에 "내,나" / "자기,진이" 같은 호칭을 넣으면 음성 매핑 정확도 ↑.

---

## 폴더 구조
```
가계부/
├── README.md
├── backend/
│   ├── Code.gs              # GAS 웹 앱 (백엔드 전체)
│   └── appsscript.json      # GAS 매니페스트
├── index.html               # 대화(입력) 화면
├── history.html             # 내역
├── stats.html               # 통계(사람별/카테고리별)
├── payments.html            # 지불수단·카드 실적 관리
├── settings.html            # PIN·서버·관리
├── manifest.webmanifest     # PWA
├── service-worker.js        # 오프라인 캐시
└── assets/
    ├── css/core.css         # 디자인 토큰 + 컴포넌트
    └── js/
        ├── config.js        # GAS_URL 설정 (여기만 수정)
        ├── api.js           # GAS 클라이언트 + 오프라인 큐
        ├── core.js          # 헤더/탭바/PIN 게이트/유틸
        ├── index.js         # 음성 대화 루프(VAD+TTS)
        ├── history.js
        ├── stats.js
        └── payments.js
```

## 데이터 필드 / 시트 탭
- `expenses`: id, date, amount, category, item, **store(상호명), region(지역)**, payer, payment_method, memo, …
- `payments` 탭(신규): name, type(카드/현금/계좌/페이), **target(월 실적 목표)**, benefit(혜택), note
  - 결제 탭에서 카드별 **이번 달 사용액 / 실적 목표 달성률**을 확인. 카드/목표는 결제 탭 또는 시트에서 편집.
- Gemini는 대화 중 **상호명·지역·지불수단** 등 빠진 정보를 되물어 완전한 내역으로 저장합니다.

## 트러블슈팅
- **unauthorized**: PIN 불일치 또는 `PIN_HASH` 미설정. `setup_setPin()` 재실행.
- **Gemini 호출 실패**: `GEMINI_API_KEY` 확인, AI Studio 키 활성 여부 확인.
- **CORS 에러**: 프론트는 `Content-Type: text/plain` 으로 전송(코드에 반영됨). GAS는 재배포 필요.
- **음성 인식 안 됨(iOS)**: 첫 탭으로 마이크 권한 허용 필요. HTTPS(=GitHub Pages)에서만 동작.
- **TTS 음성 없음(iOS)**: ko-KR 음성이 없으면 무음일 수 있음 — 화면 카드로 확인 가능.
