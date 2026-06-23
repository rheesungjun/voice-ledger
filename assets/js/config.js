/* ============================================================
   설정 — 여기만 수정하세요.
   ============================================================ */
window.LEDGER_CONFIG = {
  // Apps Script 웹 앱 배포 URL (…/exec).  README 3단계 참고.
  GAS_URL: 'https://script.google.com/macros/s/AKfycbxi4D2v7UBm2gwZc03_m3r65eK0WGkHW_cni6dDhkLecthJUMLCduSMMcSh-R6nF3aX-Q/exec',

  // VAD(무음 자동종료) 파라미터 — 환경에 맞게 미세조정 가능
  VAD: {
    silenceMs: 1500,   // 이 시간 동안 무음이면 자동 종료
    threshold: 0.015,  // RMS 임계값(0~1). 시끄러우면 약간 높이세요
    maxMs: 15000       // 최대 녹음 길이(안전장치)
  },

  // 음성 응답(TTS) 사용 여부
  tts: true
};
