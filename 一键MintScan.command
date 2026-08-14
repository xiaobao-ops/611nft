#!/bin/zsh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 600 .env
  echo "已创建 $ROOT/.env。默认配置可直接启动只读监控。"
  echo "执行 Mint 前请先安装 awp-wallet 并配置本地 AWP profiles。"
fi
chmod 600 .env

if [[ ! -d node_modules ]] || ! node -e "Promise.all([import('viem'), import('react'), import('vite')])" >/dev/null 2>&1; then
  npm ci
fi

PORT_VALUE="$(awk -F= '/^WALLET_BOARD_PORT=/{print $2; exit}' .env | tr -d '[:space:]')"
PORT_VALUE="${PORT_VALUE:-8787}"
URL="http://127.0.0.1:${PORT_VALUE}"
LOG_DIR="$ROOT/.runtime/logs"
mkdir -p "$LOG_DIR"

npm run build >"$LOG_DIR/611nft-build.log" 2>&1
npm run server >"$LOG_DIR/611nft-server.log" 2>&1 &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" >/dev/null 2>&1 || true
  wait "$SERVER_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

for _ in {1..80}; do
  if curl -fsS "$URL/api/health" >/dev/null 2>&1; then
    open "$URL"
    echo "611nft 已启动：$URL"
    echo "关闭本窗口即可停止本地服务。"
    wait "$SERVER_PID"
    exit $?
  fi
  sleep 0.25
done

echo "启动超时，日志：$LOG_DIR/611nft-server.log"
cat "$LOG_DIR/611nft-server.log"
exit 1
