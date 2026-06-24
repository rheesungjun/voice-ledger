#!/usr/bin/env bash
# 백엔드(GAS) 자동 배포: clasp push + 기존 웹앱 배포를 새 버전으로 갱신(URL 유지)
# 사용: bash scripts/deploy-backend.sh "배포 설명"
# 선행 1회: clasp login + Apps Script API 사용 설정 (.clasp.json 에 scriptId)
set -e
cd "$(dirname "$0")/.."

# config.js 의 GAS_URL 과 동일한 웹앱 배포 ID (이 ID는 공개 URL의 일부라 비밀 아님)
DEPLOYMENT_ID="AKfycbxi4D2v7UBm2gwZc03_m3r65eK0WGkHW_cni6dDhkLecthJUMLCduSMMcSh-R6nF3aX-Q"
DESC="${1:-auto-deploy}"

echo "▶ clasp push..."
clasp push -f

echo "▶ 배포 갱신 ($DEPLOYMENT_ID)..."
clasp create-deployment -i "$DEPLOYMENT_ID" -d "$DESC"

echo "▶ 확인(ping)..."
curl -sL "https://script.google.com/macros/s/${DEPLOYMENT_ID}/exec?action=ping"
echo ""
echo "✅ 백엔드 배포 완료"
