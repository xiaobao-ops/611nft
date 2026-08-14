# ASCII Cats 多钱包自动 Mint

Node.js 22 命令行工具。持续只读监控 ASCII Cats 合约，`mintOpen=true` 后**同时用多个钱包**（默认 50）各请求一次官方 Ticket，并各提交一次 `mint(salt, signature)`。每个钱包由一句 HD 助记词派生，Ticket 请求可走各自代理拿到独立出口 IP（按当前前端/接口线索，后端可能执行 `1 IP = 1 mint` 策略，最终以实时行为为准）。

**发送开关**：默认 `dry-run` 演练（不请求真票、不广播）；真实发送需二选一启用 `--arm` 或 `ARM=true`。开售时间未知时，armed 模式只用共享 RPC 监控链上状态，直到 `mintOpen=true` 才连接并验证代理。

每个钱包的已提交交易记录在 `.mint-state/<address>.json`，下次启动优先恢复确认状态，绝不自动重发。单个钱包的失败（拒签/gas 超限/回执失败）被隔离，不影响其余钱包。

真实 Ticket 不只检查长度：脚本会读取链上当前 `mintSigner` 和 `saltUsed`，按合约的 `ASCIICATS_MINT + chainId + contract + wallet + salt` 规则在本地恢复签名地址；只有签名者等于链上 `mintSigner` 且 salt 未使用才继续估算和发送。确认后还必须在回执中找到该钱包的 `Minted` 事件，并验证 `ownerOf(tokenId)` 等于该钱包，最后再检查 `hasMinted=true`。

## 安全提醒

- **`--arm` 会在 Mint 开放后为每个钱包广播真实、不可逆的链上交易并消耗 ETH。** 默认不加 `--arm` 只做演练。
- 用**专门派生的助记词**，不要用保存其他资产的主钱包助记词。
- 给启动时打印的**每一个派生地址**各转入少量、足够 chain ID `4663` gas 的 ETH（dry-run 会列出余额不足的地址）。
- 不要分享或提交 `.env`、`proxies.txt`、助记词、私钥、完整 Ticket 或 `.mint-state/`。
- 启动前核对终端显示的模式（dry-run / ARMED）、钱包数、chain ID、合约、RPC 主机名和费用上限。合约默认 `0xa3F56AdB32D3A8F3b41462e3fBF17f36829325bE`。

## 安装

```bash
node --version   # 需 >= 22
npm install
```

复制样例并只在本机编辑：

```bash
cp .env.example .env
cp proxies.example.txt proxies.txt
```

`.env` 至少填写：

```dotenv
MNEMONIC=你的 12/15/18/21/24 词隔离助记词
WALLET_COUNT=50
```

也可以不填 `MNEMONIC`，改用 `PRIVATE_KEYS_FILE=wallets.txt`。此时 `wallets.txt`
每行一个 `0x` 私钥，或 `walletId,0x私钥`；文件行数必须精确等于 `WALLET_COUNT`。

当前 50 钱包方案使用混合代理池：`proxies.txt` 只放前 20 条静态代理；后 30 条在 `mintOpen=true` 后通过 `PROXY_API_URL` 获取，仅保存在运行时内存。静态代理每行一个，支持 HTTP(S) 和 SOCKS5：

```
http://user1:pass1@proxy1.example.com:8080
socks5h://user2:pass2@proxy2.example.com:1080
...
```

供应商给出的 `IP:PORT:USER:PASS` 四段式行会自动按 SOCKS5H 解析；用户名或密码中的特殊字符会被安全编码。

可选的 `PROXY_RESERVE_FILE` 用于备用代理池。armed 模式下，如果主代理或动态代理在出口检查时连不通、出口 IP 重复，脚本会在第一条 Ticket 请求前从备用池按顺序取新代理替换，并继续执行唯一出口检查。备用代理每条只使用一次；备用不足、仍失败或仍重复时整批 fail closed。

动态代理 API 使用前，需要在供应商后台把**运行脚本机器当时的公网出口 IP**加入白名单。API 必须返回 JSON 代理列表；完整 URL 只写入本机 `.env`，不要放进 README、截图、压缩包或聊天转发。

其余可保留默认或按需调整：

- `DERIVATION_PATH_BASE`：HD 派生基路径（默认 `m/44'/60'/0'/0`）。
- `MINT_CONCURRENCY`：Mint 开放后同时发射的钱包数上限（程序缺省 10；本分享配置示例设为 20）。
- `ALLOW_PROXY_REUSE`：旧静态代理预检兼容项。当前 20 静态 + 30 API 动态混合池仍要求 `proxies.txt` 数量精确等于 `STATIC_PROXY_COUNT`，该选项不能绕过计数保护。
- `STATIC_PROXY_COUNT` / `DYNAMIC_PROXY_COUNT`：静态与动态代理槽位数，两者之和必须等于 `WALLET_COUNT`。当前配置为 20 + 30 = 50。
- `PROXY_RESERVE_FILE`：备用代理文件。可为空；不计入 `WALLET_COUNT`，只用于替换失败或重复出口的槽位。
- `PROXY_API_URL`：动态代理 HTTPS JSON API。只有 armed 且检测到 Mint 开放、gas 预检通过后才调用。
- `PROXY_API_TIMEOUT_MS` / `PROXY_CHECK_TIMEOUT_MS` / `PROXY_POOL_DEADLINE_MS`：API、单轮出口检查及整池准备的硬超时。
- `PROXY_MAX_REPLACEMENTS`：Ticket 前失败或重复出口的累计替换上限；无法形成唯一完整代理池时整批停止。
- `POLL_INTERVAL_MS`：Mint 开放检查间隔（默认 500ms）。只有 `mintOpen` 失败才进入指数退避；`totalMinted` 仅作日志遥测，不会阻塞开放判定。
- `TICKET_TIMEOUT_MS`：每个钱包 Ticket HTTP 请求的硬超时（默认 10000ms）；`Ctrl+C` 同样会取消尚未完成的 Ticket 请求。
- `MAX_GAS_LIMIT` / `MAX_FEE_PER_GAS_GWEI` / `CONFIRMATIONS`：Gas 与确认安全上限。EIP-1559 交易将 `MAX_FEE_PER_GAS_GWEI` 签入 `maxFeePerGas` 作为短时 Base Fee 上涨的余量；实际费用仍是当时 Base Fee + Priority Fee，不会默认按整个上限收取。
- `OPENCLAW_DISCORD_TARGET` / `OPENCLAW_TIMEOUT_MS`：通过本机 OpenClaw 向指定 Discord `channel:<id>` 推送 Mint 开放及每个钱包链上确认成功消息。通知使用后台串行队列，不阻塞代理准备或交易发送；通知失败只写日志，不改变 Mint 结果。

> 兼容单钱包：只填 `PRIVATE_KEY`、不填 `MNEMONIC` / `PRIVATE_KEYS_FILE` 即回到单钱包模式。单钱包同样默认 dry-run，只有 `--arm` 或 `ARM=true` 才会请求 Ticket 和广播。

## 验证

本地测试与语法检查（不请求 Ticket、不发送交易）：

```bash
npm test
npm run check
```

## 演练（dry-run，默认，安全）

```bash
npm start
```

演练会核对 chain ID `4663`、钱包状态、`mintOpen`、派生地址和 gas 余额，**全程不调用动态代理 API、不连接代理做出口检查、不请求真票、不 reserve 发送状态、不签名、不广播**。它只离线校验静态代理数量和 API URL 配置，因此不会提前启动供应商的 120 分钟 Sticky session。

## 真实 Mint（--arm，会广播）

确认演练通过、50 个地址已充足 gas、供应商白名单已配置后：

```bash
# 当前 .env / proxies.txt 已按 20 静态 + 30 动态 = 50 配置
npm start -- --arm
```

不要只临时覆盖 `WALLET_COUNT` 做小批量，否则会触发代理槽位计数保护。小批量需要同时准备对应数量的静态代理文件，并令 `STATIC_PROXY_COUNT + DYNAMIC_PROXY_COUNT = WALLET_COUNT`。

`--arm` 下脚本默认每 500ms 通过共享 Robinhood RPC 监控 `mintOpen`，同时以有界并发检查各钱包 gas。默认等待期间不会调用动态代理 API、连接代理、请求 Ticket、reserve 发送状态或广播；启用 `PROXY_PREHEAT=true` 时，只会为状态过滤后仍 pending 的钱包提前准备代理。检测到开放后，只有 gas 全部可用且充足，才调用 API 获取动态代理，并对仍需 Mint 的静态/动态槽位做两轮并行出口稳定性检查；失败、出口变化或重复出口会在第一条 Ticket 前有界替换。只有代理池完整、出口稳定唯一并锁定后，才按 `MINT_CONCURRENCY` 请求 Ticket 和发送。

代理池准备失败、API 超时、白名单错误、出口重复或替换超限都会整批 fail closed，此时 Ticket/reserve/send 均为零。某钱包一旦开始 Ticket POST，脚本不会自动换代理或重新领票；网络结果不确定时会保留 `ticket-requested` 状态并要求人工核查。

按 `Ctrl+C` 可中断 Mint 未开放时的轮询 sleep；进行中的 Ticket/RPC/确认调用不保证立即取消。若某钱包状态为 `prepared` 或提示需人工检查，**不要删状态盲目重试**，先核对链上是否已出现该钱包的交易或 Mint 结果。

## 现实约束

- **代理质量决定成败**：50 个钱包均待 Mint 时需要 20 条静态代理，并由 API 在开放后获取 30 条动态代理；若部分钱包已有安全终态，只为仍 pending 的对应槽位准备代理。最终仍必须形成与 pending 钱包一一对应的不同出口 IP。
- dry-run 只证明离线配置、链状态和余额路径正确，不证明动态代理 API、白名单或实时出口可用。armed 会在 Ticket 前进行真实验证并 fail closed。
- 后端是否执行 `1 IP = 1 mint` 以及 API 在高峰期的容量都无法由离线测试保证。
- RPC 保持直连共享（非 IP 限制端点）；仅 Ticket 请求走代理。
