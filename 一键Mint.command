#!/bin/zsh

set -u
setopt PIPE_FAIL

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

finish() {
  local exit_status=$?
  trap - EXIT
  echo
  if (( exit_status == 0 )); then
    echo "流程已结束。"
  else
    echo "运行失败，退出码：$exit_status"
  fi
  read -r "reply?按回车关闭窗口..."
  exit "$exit_status"
}
trap finish EXIT

printf '\033]0;611nft CLI Mint\007'
clear
echo "611nft CLI Mint"
echo "CA 仅用于本次运行，不会写入 .env。"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，请先安装 Node.js 22 或更高版本。"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "未找到 npm，请重新安装 Node.js。"
  exit 1
fi

if [[ ! -d node_modules/viem || ! -d node_modules/dotenv ]]; then
  echo "首次运行，正在自动安装依赖..."
  npm ci || exit 1
  echo
fi

if [[ ! -f "$SCRIPT_DIR/.env" ]]; then
  echo "未找到 .env 文件，请先在其中每行直接填写一个私钥。"
  exit 1
fi

if ! node --input-type=module -e "import {loadAccounts} from './lib/mint-core.mjs'; loadAccounts();" >/dev/null 2>&1; then
  echo "当前 .env 未找到有效钱包，或私钥格式不正确。"
  echo "请每行直接填写一个 64 位十六进制私钥，不写变量名，也不加 0x。"
  exit 1
fi
chmod 600 "$SCRIPT_DIR/.env"

contract_address=""
while true; do
  read -r "contract_address?请输入 NFT 合约地址（CA）: "
  if printf '%s' "$contract_address" | grep -Eq '^0x[0-9a-fA-F]{40}$'; then
    break
  fi
  echo "CA 格式错误，请输入以 0x 开头的 40 位 EVM 合约地址。"
done

echo
node mint.mjs "$contract_address" --send
