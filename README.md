<div align="center">
  <img src="src/assets/611nft-logo-ui.png" width="112" alt="611nft logo">
  <h1>611nft</h1>
  <p><strong>本地优先的多链 NFT Mint 监控与 AWP 钱包工作台</strong></p>
  <p>Local-first multi-chain NFT mint monitor and AWP wallet console.</p>
</div>

611nft 2.0 使用单一 React 19 + Vite 前端和 Express 服务。根 `src/` 是唯一 React 源码，保留功能的纯浏览器运行时位于 `public/nfttool-runtime/`，一次 `vite build` 同时生成 `/tool/*` 与 OpenSea 页面。服务默认只监听 `127.0.0.1`，钱包密钥由外部 `awp-wallet` profile 持有，不进入项目 `.env`、浏览器、API 响应或 SQLite。

> [!WARNING]
> 该工具能够签名并广播不可撤销的链上交易。请使用专用低余额钱包，先做 Preview，核对链、合约、calldata、金额、Gas 和接收地址。不要把服务直接暴露到不可信网络。

## 保留功能

前端只保留以下 15 个入口，生产首页为 `/tool/walletManager/walletManager`；不需要账号、签名登录、会员或 PASS：

- 钱包管理、分发代币、归集代币、多对多转账、交易所充值。
- NFT 盯盘、跟单/自动铸造、项目破签、高级铸造、OpenSea。
- 批量挂单、NFT 归集、批量授权、报警监控、交易记录。

底层能力包括：

- Ethereum、Base、Arbitrum、Optimism、Polygon、BSC、zkSync Era、Shibarium、Robinhood Chain 实时监控支持。
- ERC-721/ERC-1155 零地址 Transfer 直接扫描；上游不可用时按区间日志、逐块日志、receipt 逐级降级。
- 合集供应量、Mint 价格、钱包限额、最近 Mint、媒体和全历史独立 Mint 钱包统计。
- 上游 WSS 多端点切换与 HTTP 补洞，浏览器 SSE 支持游标重放、同合集批次、回撤、增量补全和 60 秒 MINT/S 速率。
- 多窗口 Trending、部署者画像、个人合集标记、SeaDrop 开售雷达，以及 SSE/Telegram 报警规则。
- AWP wallet profile 发现、创建、标签、分组、备注、收藏和风险标记。
- 原生币/ERC-20 余额、one-to-many、many-to-one、many-to-many、approve/revoke 与 contract call。
- NFT Mint 最多 200 个钱包、并发上限 32、价值上限、广播前重报价和再次预检。
- SQLite 持久化钱包元数据、余额、任务、交易日志和 lifetime minter 回填游标。

## 安全边界

- 所有资金写操作采用服务端不可变 Preview 和短期一次性 confirmation token；前端确认框不是安全边界。
- NFT Mint 广播前重新检查链、目标 bytecode、calldata、价格、Gas、余额和配置的价值上限。
- 非回环监听必须配置 `WALLET_BOARD_API_TOKEN`，API 使用 `Authorization: Bearer <token>`。
- 默认回环模式不要求 token，方便本机 UI 和 CLI；仍应避免访问恶意网页或运行不可信本机程序。
- SQLite 不保存私钥、助记词或 AWP 密钥材料；AWP profile、`.env` 与 SQLite 都应按敏感本地数据保护。
- NFT metadata 代理拒绝本机、私网、链路本地和保留地址。

更完整的信任边界和状态机见 [`DESIGN.md`](DESIGN.md)，安全报告方式见 [`SECURITY.md`](SECURITY.md)。

## 要求

- Node.js 22+
- npm
- `awp-wallet` 在 `PATH` 中，并已配置操作者自己的隔离低余额 profiles

只读监控不需要钱包 profile。任何 Mint、转账、授权或 contract call 都需要可用的 AWP profile；provider 不支持的确定性 envelope、全余额归集、SIWE 或 EIP-712 签名会在广播前明确拒绝。

## 安装与启动

```bash
git clone https://github.com/xiaobao-ops/611nft.git
cd 611nft
npm ci
cp .env.example .env
npm run dev
```

开发模式只启动 Express `8791` 和一个 Vite `5173`，主页面位于 `http://127.0.0.1:5173/tool/walletManager/walletManager`。生产式本地启动：

```bash
npm run build
npm run server
```

访问 `http://127.0.0.1:8791/tool/walletManager/walletManager`。OpenSea 位于 `/tool/highHexMint/opensea`。macOS 也可以双击 `一键MintScan.command`。默认端口避开 611tools 本地认证服务占用的 `8787`。

## 配置

根 `.env` 只保存服务、RPC 和通知配置，不保存钱包密钥：

```dotenv
WALLET_BOARD_PORT=8791
WALLET_BOARD_API_HOST=127.0.0.1
WALLET_BOARD_API_HOSTS=

ETH_RPC_URL=https://ethereum.publicnode.com
BASE_RPC_URL=https://base.publicnode.com
ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com

# 可选：单个优先 WSS + 逗号分隔的后备池
WSS_RPC_URL_ETHEREUM=
WSS_RPC_URLS_ETHEREUM=

MINT_MONITOR_REPLAY_BUFFER=500
MINT_MONITOR_BATCH_MS=2000
MINT_MONITOR_HEARTBEAT_MS=1000
DEPLOYER_YOUNG_WALLET_DAYS=7
DEPLOYER_PROJECT_RISK_COUNT=5

# 全局 SeaDrop 地址；SEADROP_ADDRESSES_ETHEREUM 等链级配置优先
SEADROP_ADDRESSES=
SEADROP_RADAR_POLL_MS=30000
SEADROP_SCAN_MAX_BLOCKS=5000
SEADROP_LOOKBACK_BLOCKS=

# 可选 Telegram 通知，真实值只写入 .env
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

```

WSS 变量使用链 key 的大写后缀：`ETHEREUM`、`BASE`、`ARBITRUM`、`OPTIMISM`、`POLYGON`、`BSC`、`ZKS`、`SHIB`、`ROBINHOOD`。服务读取 `WSS_RPC_URL_<CHAIN_KEY>` 和 `WSS_RPC_URLS_<CHAIN_KEY>`，并兼容 `<CHAIN_KEY>_WSS_RPC_URL(S)`。显式配置任一 WSS 值后只使用该配置池；连接失败时仍由对应的 `*_RPC_URL(S)` HTTP 池扫描和补洞。

NFT TOOL 将 RPC 明确分为两条链路：Live Mint、SSE、区块扫描、余额、预检、报价、Nonce 和 receipt 的请求仍使用所选链对应的公共多 RPC 读池；交易页面和动作面板的发送节点 Radio 同时决定交易链和实际广播/替换交易使用的写 profile。公开写 profile 只有 `Ethereum`、`BSC`、`Base`、`Robinhood`、`自定义` 五项；`Main` 仅作为旧任务的内部兼容值，HK 兼容别名解析为 Ethereum，Flashbots、Arbitrum、ZKS、Shib 写 profile 已退役，但这些链仍保留实时监控。内置 profile 使用独立多 endpoint 池，发送前校验 chain ID 并按健康/延迟选择；只有明确连接失败才换 endpoint，超时或结果未知进入 `confirmation_pending`，不会自动重复发送。自定义 RPC 在交易面板逐行输入，测试只执行 `eth_chainId` 与 `eth_blockNumber`，endpoint 池和短期 `profileRef` 只保存在内存；Follow Mint 规则表只保存 profile ID，并在当前进程内冻结引用，不会把 endpoint 写入 SQLite、日志或响应中的 URL。Live Mint 运行中切换发送节点会同步切换监控链，重建 bootstrap、区块列表、SSE 和公共读 RPC 状态；读取仍命中该链的公共读池，不会改用写 endpoint。

读池健康状态和脱敏主机名通过 `GET /api/rpc-pool/status?chainId=<id>` 查看；写 profile 列表、测试和选择分别使用全局 `GET /api/rpc-profiles`、`POST /api/rpc-profiles/test`、`POST /api/rpc-profiles/select`。旧 `POST /api/rpc-pool/select` 仅转换为写 profile 兼容响应，不直接选择读 endpoint。写 profile 环境变量为 `NFT_WRITE_RPC_ETHEREUM_URL(S)`、`NFT_WRITE_RPC_BSC_URL(S)`、`NFT_WRITE_RPC_BASE_URL(S)`、`NFT_WRITE_RPC_ROBINHOOD_URL(S)`；这些变量留空时使用服务内置的独立多 RPC 公共候选池，填写后覆盖对应 profile。实时监控仍使用 `ARBITRUM_RPC_URL(S)`、`ZKS_RPC_URL(S)`、`SHIB_RPC_URL(S)` 等公共读池配置；发送节点切换会让监控请求切到所选 profile 的链，再从该链公共读池读取实时数据。

`SEADROP_ADDRESSES` 与 `SEADROP_ADDRESSES_<CHAIN_KEY>` 接受逗号分隔地址，链级值优先；两者均为空时使用内置 SeaDrop 单例地址。雷达默认每 30 秒刷新，首次回看按各链平均出块时间估算 7 天，`SEADROP_LOOKBACK_BLOCKS` 或 `SEADROP_LOOKBACK_BLOCKS_<CHAIN_KEY>` 可覆盖区块预算。单次 RPC 日志范围为 5,000 个区块，每个成功分块都会独立推进连续 checkpoint。部署者风险默认将钱包年龄小于 7 天或 NFT 项目数不少于 5 标为风险，可通过上面的两个阈值调整。

### 单前端边界

`src/routes.js` 是 15 个入口和旧地址兼容跳转的唯一清单，`src/Shell.jsx` 使用 History API、React `lazy` 与 `Suspense` 加载页面。钱包、铸造和 NFT 管理的浏览器运行时位于 `public/nfttool-runtime/`，由同一次 Vite 构建复制到 `dist/nfttool-runtime/`；报警和交易记录是独立懒加载 React chunk。仓库不再包含 Umi、Ant Design Pro、第二个 package、嵌套 lockfile 或 iframe 外部运行时。

浏览器只从 Wallet Provider API 获得 profile ID、地址、标签和能力，不获得私钥。公开部署只使用 AWP provider；业务层在发送前按能力 fail closed，尤其不会让不能签名最终 envelope 的 provider 执行全余额归集，也不会回退到项目 `.env` 私钥。

### 远程监听

不建议开放远程监听。确实需要时，至少生成 32 字节随机 token：

```bash
openssl rand -hex 32
```

```dotenv
WALLET_BOARD_API_HOSTS=127.0.0.1,192.0.2.10
WALLET_BOARD_API_TOKEN=<random-token>
```

非回环启动缺少 token 或 token 少于 32 字节会直接失败。远程客户端需发送：

```http
Authorization: Bearer <random-token>
```

Bearer token 不替代 TLS；跨不可信网络时还必须使用反向代理 TLS、主机防火墙和网络隔离。

### 钱包 profile

钱包枚举来自 `~/.openclaw-wallet/wallets.json`，可用 `WALLET_BOARD_WALLET_ROOT` 指向另一处 AWP 根目录。页面“创建钱包”调用 `awp-wallet init`；公开版不提供私钥导入、导出或删除接口。AWP profile 生命周期、备份和恢复均由外部钱包工具负责。

## 实时情报与报警

访问 `GET /api/bootstrap?chainId=1&window=1800` 可一次取得监控状态、Overview、Trending、SeaDrop 雷达和个人标记。浏览器随后连接 `GET /api/mint-monitor/stream?chainId=1`；带 `id` 的事件按 `chainId-sequence` 游标写入每链 ring buffer，重连时通过 `Last-Event-ID` 补发。游标过旧、非法或跨链时服务发送 `replay_reset`，客户端重新获取 bootstrap。Overview/Trending 支持 MCT 对齐的 `3m`、`5m`、`30m`、`60m` 窗口，同时保留更长窗口。

同链同合约在 `MINT_MONITOR_BATCH_MS` 内合为 `mint_batch`，并携带数量、原事件编号和 token ID 区间。`heartbeat` 每秒提供 `mintRate` 与最近 60 秒样本；媒体、部署者或合集字段完成后发送 `collection_patch`，链重组回撤发送 `discard`。`MINT_MONITOR_REPLAY_BUFFER` 控制每链可重放事件数，heartbeat 是瞬时状态，不占用重放缓冲。

Live Mint 的 confirmed、pending 和回撤事件共享 canonical 字段：`chainId`、`eventId`、`dedupeKey`、`status`、`source`、`txHash`、`contract`、`sender`、`recipient`、`blockNumber`、`blockTime`、`logIndex`、`quantity`、`tokenIds`、价格/Gas、`methodName`、`selector`、`tokenStandard`、`collectionSnapshot` 和 `observedAt`。有日志索引时去重键为 `chainId:txHash:contract:logIndex`，否则退化为 `chainId:txHash:contract`；旧客户端仍可使用 `id`、`address` 和 snake_case 字段。pending 数量无法解码时保持 `null`/unknown，不会变成 0 或免费铸造。

| API | 作用 |
| --- | --- |
| `GET /api/bootstrap` | 聚合首屏状态、Overview、Trending、雷达和标记 |
| `GET /api/mint-monitor/status` | HTTP/WSS/实时缓冲健康状态 |
| `GET /api/mint-monitor/trending` | `180`、`300`、`1800`、`3600` 秒及更长窗口的 confirmed 热度排名 |
| `GET /api/collections/flags` | 按链或 `scam`/`blocked`/`watch` 查看个人标记 |
| `POST/DELETE /api/collections/:address/flag` | 新增、更新或删除个人合集标记 |
| `GET /api/seadrop-radar` | 查询未来阶段，支持 free/paid/live/public 筛选 |
| `GET/POST /api/alerts` | 列出或创建报警规则 |
| `PATCH/DELETE /api/alerts/:id` | 更新或删除报警规则 |
| `POST /api/alerts/test` | 触发一次手工测试报警 |

报警规则的 `type` 与 `params` 如下；每条规则还可设置 `name`、`enabled` 和 `cooldownSeconds`：

| `type` | `params` |
| --- | --- |
| `trending` | `{"window":60,"threshold":8}` |
| `contract_mint` | `{"address":"0x..."}` |
| `seadrop_start` | `{"leadMinutes":10,"address":"0x..."}`，地址可省略 |
| `wallet_activity` | `{"address":"0x..."}` |

例如创建一分钟内达到 8 个 Mint 的报警规则：

```bash
curl -sS -X POST http://127.0.0.1:8791/api/alerts \
  -H 'Content-Type: application/json' \
  -d '{"type":"trending","chainId":1,"params":{"window":60,"threshold":8},"cooldownSeconds":300}'
```

以下请求只验证通知链路，不会创建持久化规则：

```bash
curl -sS -X POST http://127.0.0.1:8791/api/alerts/test \
  -H 'Content-Type: application/json' \
  -d '{"chainId":1,"title":"611nft 测试报警","message":"通知链路检查"}'
```

同时配置 `TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_CHAT_ID` 后，报警经限速与重试发送；缺少任一值时测试响应中的 `notification.skipped` 为 `true`，不会访问 Telegram。`GET /api/alerts` 只返回 `enabled`、队列和成功/失败计数，不回传 token 或 chat ID。非回环部署仍需遵守前述 Bearer token 与 TLS 边界。

## NFT Mint

Web 流程：

1. 选择链和合集，核对链上供应量与最近 Mint。
2. 选择 AWP profiles，填写数量、Token ID、并发和可选价值上限。
3. Preview 查看逐钱包预检。
4. 点击 Mint 时服务端重新 Preview，确认后使用一次性 token 广播。
5. 等待每个钱包进入 confirmed、failed 或 confirmation pending。

CLI 需要 Dashboard 服务已启动：

```bash
# 只 Preview
npm run mint -- 0xNFT_CONTRACT --chain 1 --wallet default

# 交互确认后发送
npm run mint -- 0xNFT_CONTRACT --chain 1 --wallets default,agent-1 --send
```

只有明确需要非交互广播时才增加 `--yes`。

## 通用资金任务

转账、归集、approve/revoke 和任意 contract call 均为两步协议：

1. `POST /api/plan/...` 生成不可变计划、`previewId` 和一次性 `confirmationToken`。
2. 人工核对计划后，`POST /api/tasks/...` 只提交 `previewId` 与 `confirmationToken`。

执行接口不会重新信任客户端传入的 wallet、amount 或 calldata。部分成功会标记为 `partial`，避免将已发送交易误认为可安全整体重试。

## 验证

```bash
npm ci
npm run check
npm run audit
npm run sbom
```

验证不会自动广播交易。涉及 OpenSea 和链上差异的回归使用可溯源真实响应快照或公开链数据；测试钱包不得复用真实资产钱包。

## 主要路径

| 路径 | 作用 |
| --- | --- |
| `src/` | 唯一 React 19/Vite 外壳、路由、报警和交易记录源码 |
| `public/nfttool-runtime/` | 保留功能的纯浏览器运行时，由 Vite 作为静态资源构建 |
| `server/index.js` | Express 5 API、SQLite、AWP 调用和任务状态机 |
| `server/wallet-provider.js` | AWP-only profile 枚举、创建、能力声明和签名边界 |
| `server/opensea-mint/` | OpenSea 阶段身份、钱包资格、计划、nonce 与广播状态 |
| `server/sweep-envelope.js` | 同一写 RPC 的余额、nonce、Gas、费用和最终归集金额 |
| `server/mint-monitor.js` | 多链直接扫描、供应量、价格和 minter 回填 |
| `server/nft-mint.js` | NFT Mint 计划校验、预检与重报价 |
| `server/rpc-pool.js` | 多上游读取容错，写方法单次发送 |
| `test/` | 主项目单元与 API 安全回归测试 |

## 已知限制

- 旧 NFT TOOL 的撸毛、Swap、铭文、Cosmos、Solana、PoW、登录、管理和样板页面已删除，不在构建产物中。
- 生产部署只运行一次 `vite build`；Express 必须与生成的 `dist/` 一起部署。
- 链、RPC、OpenSea、Waypoint、Blockscout 和 metadata gateway 的 schema、限速与可用性会影响数据完整性。
- provider 数据和本地扫描可能短暂处于不同进度；链上 `totalSupply()` 优先，读取失败时显示保守值或未知值。
- AWP profile 生命周期由外部 `awp-wallet` 管理；升级前应独立备份并验证钱包地址。
- 开源发布不代表经过第三方安全审计。

## 贡献与许可

提交前阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md)，运行完整验证，并确保不包含 `.env`、钱包、代理凭据、认证 RPC URL、SQLite、日志、HAR 或签名材料。

项目以 [MIT License](LICENSE) 开源。第三方产品、协议和商标归各自所有。

---

## English

611nft 2.0 is a local-first, multi-chain NFT mint monitor and AWP wallet console built as one React 19 + Vite frontend with an Express backend. It includes direct ERC-721/ERC-1155 scanning, SSE activity, persistent minter statistics, AWP profile management, balance and asset operations, and preview-first NFT mint execution.

Wallet key material remains inside external `awp-wallet` profiles and is never read from the project `.env`, returned to the browser, or stored in SQLite. Every value-moving operation uses an immutable server preview and a short-lived one-time confirmation token. Non-loopback listeners require `WALLET_BOARD_API_TOKEN`.

See the Chinese sections above and [`DESIGN.md`](DESIGN.md) for the complete installation, migration, API, and security model.
