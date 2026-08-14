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

if [[ ! -d node_modules/viem ]]; then
  echo "首次运行，正在自动安装依赖..."
  npm ci || exit 1
  echo
fi

if ! command -v awp-wallet >/dev/null 2>&1; then
  echo "未找到 awp-wallet。请先安装并配置本地 AWP wallet profiles。"
  exit 1
fi

contract_address=""
while true; do
  read -r "contract_address?请输入 NFT 合约地址（CA）: "
  if printf '%s' "$contract_address" | grep -Eq '^0x[0-9a-fA-F]{40}$'; then
    break
  fi
  echo "CA 格式错误，请输入以 0x 开头的 40 位 EVM 合约地址。"
done

read -r "wallet_profiles?请输入 AWP wallet profile ID（多个用逗号分隔）: "
if [[ -z "${wallet_profiles//[[:space:]]/}" ]]; then
  echo "至少需要一个 AWP wallet profile。"
  exit 1
fi

echo
echo "请先确保 611nft Dashboard 服务已启动。"
node server/nft-mint-cli.js "$contract_address" --wallets "$wallet_profiles" --send
