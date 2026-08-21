<div align="center">
  <img src="apps/web/assets/611nft-logo.png" width="112" alt="611nft logo">
  <h1>611nft</h1>
  <p><strong>本地优先的多链 NFT Mint 监控与钱包工作台</strong></p>
  <p>Local-first multi-chain NFT mint monitor and wallet console.</p>
</div>

611nft 2.0 以 NFT TOOL Umi/Ant Design 平台作为主入口。钱包管理、分发、归集、多对多和交易所充值保留 NFT TOOL 原始 `Tool/Iframe` 路由协议；NFT Live Mint、项目名称、项目 Logo 与 `/highHexMint/opensea` 继续使用 611nft 本地实现。611nft 服务默认只监听 `127.0.0.1`，本地私钥不进入浏览器、API 响应或 SQLite。

> [!WARNING]
> 该工具能够签名并广播不可撤销的链上交易。请使用专用低余额钱包，先做 Preview，核对链、合约、calldata、金额、Gas 和接收地址。不要把服务直接暴露到不可信网络。

## 功能

- NFT TOOL 导航、主题和国际化外壳，生产入口为 `/tool/walletManager/walletManager`；访问页面与模块不需要账号、签名登录、会员或 PASS。
- 钱包管理、分发、归集、多对多、交易所充值和高级 Mint 使用 NFT TOOL 原始 iframe 页面名与 URL 协议。
- NFT 盯盘、跟单、报警、余额扫描和交易记录继续装载 611nft 本地 React/Vite + Express 工作区。
- NFT Live Mint、真实项目名称和项目 Logo 保留 611nft 的本地数据链路与渲染实现。
- Ethereum、Base、Arbitrum、Optimism、Polygon、BSC、zkSync Era、Shibarium、Robinhood Chain 实时监控支持。
- ERC-721/ERC-1155 零地址 Transfer 直接扫描；上游不可用时按区间日志、逐块日志、receipt 逐级降级。
- 合集供应量、Mint 价格、钱包限额、最近 Mint、媒体和全历史独立 Mint 钱包统计。
- 上游 WSS 多端点切换与 HTTP 补洞，浏览器 SSE 支持游标重放、同合集批次、回撤、增量补全和 60 秒 MINT/S 速率。
- 多窗口 Trending、部署者画像、个人合集标记、SeaDrop 开售雷达，以及 SSE/Telegram 报警规则。
- 本地钱包 profile 发现、创建、标签、分组、备注、收藏和风险标记；兼容逐行私钥与带 profile 标记的生成钱包。
- 原生币/ERC-20 余额、one-to-many、many-to-one、many-to-many、approve/revoke 与 contract call。
- NFT Mint 最多 200 个钱包、并发上限 32、价值上限、广播前重报价和再次预检。
- SQLite 持久化钱包元数据、余额、任务、交易日志和 lifetime minter 回填游标。
- 独立 `ascii-cats-mint/` 专项 runner，默认 dry-run，真实发送必须显式 ARM。

## 安全边界

- 所有资金写操作采用服务端不可变 Preview 和短期一次性 confirmation token；前端确认框不是安全边界。
- NFT Mint 广播前重新检查链、目标 bytecode、calldata、价格、Gas、余额和配置的价值上限。
- 非回环监听必须配置 `WALLET_BOARD_API_TOKEN`，API 使用 `Authorization: Bearer <token>`。
- 默认回环模式不要求 token，方便本机 UI 和 CLI；仍应避免访问恶意网页或运行不可信本机程序。
- SQLite 不保存私钥或助记词，但根 `.env` 包含本地签名材料；`.env` 与 SQLite 都应按敏感本地数据保护。
- NFT metadata 代理拒绝本机、私网、链路本地和保留地址。

更完整的信任边界和状态机见 [`DESIGN.md`](DESIGN.md)，安全报告方式见 [`SECURITY.md`](SECURITY.md)。

## 要求

- Node.js 22+
- npm
- 至少一个专用低余额钱包私钥，按逐行格式放入根 `.env`

只读监控不需要钱包 profile。任何 Mint、转账、授权或 contract call 都需要可用的本地 profile。

## 安装与启动

```bash
git clone https://github.com/Zerorisklabs-V1/611nft.git
cd 611nft
npm ci
cp .env.example .env
npm run dev
```

开发模式同时启动 Express `8791`、本地工作区 Vite `5173` 和 NFT TOOL Umi `8000`，主页面位于 `http://127.0.0.1:8000/tool/walletManager/walletManager`。生产式本地启动：

```bash
npm run build
npm run server
```

访问 `http://127.0.0.1:8791/tool/walletManager/walletManager`。OpenSea 位于 `/tool/highHexMint/opensea`。macOS 也可以双击 `一键MintScan.command`。默认端口避开 611tools 本地认证服务占用的 `8787`。

## 配置

根 `.env` 保存服务、RPC 配置和本地钱包。每个钱包单独占一行，只写 64 位十六进制私钥，不写变量名和 `0x`：

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

# 一个钱包一行；真实值不得提交到 Git
0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

WSS 变量使用链 key 的大写后缀：`ETHEREUM`、`BASE`、`ARBITRUM`、`OPTIMISM`、`POLYGON`、`BSC`、`ZKS`、`SHIB`、`ROBINHOOD`。服务读取 `WSS_RPC_URL_<CHAIN_KEY>` 和 `WSS_RPC_URLS_<CHAIN_KEY>`，并兼容 `<CHAIN_KEY>_WSS_RPC_URL(S)`。显式配置任一 WSS 值后只使用该配置池；连接失败时仍由对应的 `*_RPC_URL(S)` HTTP 池扫描和补洞。

NFT TOOL 将 RPC 明确分为两条链路：Live Mint、SSE、区块扫描、余额、预检、报价、Nonce 和 receipt 的请求仍使用所选链对应的公共多 RPC 读池；交易页面和动作面板的发送节点 Radio 同时决定交易链和实际广播/替换交易使用的写 profile。公开写 profile 只有 `Ethereum`、`BSC`、`Base`、`Robinhood`、`自定义` 五项；`Main` 仅作为旧任务的内部兼容值，HK 兼容别名解析为 Ethereum，Flashbots、Arbitrum、ZKS、Shib 写 profile 已退役，但这些链仍保留实时监控。内置 profile 使用独立多 endpoint 池，发送前校验 chain ID 并按健康/延迟选择；只有明确连接失败才换 endpoint，超时或结果未知进入 `confirmation_pending`，不会自动重复发送。自定义 RPC 在交易面板逐行输入，测试只执行 `eth_chainId` 与 `eth_blockNumber`，endpoint 池和短期 `profileRef` 只保存在内存；Follow Mint 规则表只保存 profile ID，并在当前进程内冻结引用，不会把 endpoint 写入 SQLite、日志或响应中的 URL。Live Mint 运行中切换发送节点会同步切换监控链，重建 bootstrap、区块列表、SSE 和公共读 RPC 状态；读取仍命中该链的公共读池，不会改用写 endpoint。

读池健康状态和脱敏主机名通过 `GET /api/rpc-pool/status?chainId=<id>` 查看；写 profile 列表、测试和选择分别使用全局 `GET /api/rpc-profiles`、`POST /api/rpc-profiles/test`、`POST /api/rpc-profiles/select`。旧 `POST /api/rpc-pool/select` 仅转换为写 profile 兼容响应，不直接选择读 endpoint。写 profile 环境变量为 `NFT_WRITE_RPC_ETHEREUM_URL(S)`、`NFT_WRITE_RPC_BSC_URL(S)`、`NFT_WRITE_RPC_BASE_URL(S)`、`NFT_WRITE_RPC_ROBINHOOD_URL(S)`；这些变量留空时使用服务内置的独立多 RPC 公共候选池，填写后覆盖对应 profile。实时监控仍使用 `ARBITRUM_RPC_URL(S)`、`ZKS_RPC_URL(S)`、`SHIB_RPC_URL(S)` 等公共读池配置；发送节点切换会让监控请求切到所选 profile 的链，再从该链公共读池读取实时数据。

`SEADROP_ADDRESSES` 与 `SEADROP_ADDRESSES_<CHAIN_KEY>` 接受逗号分隔地址，链级值优先；两者均为空时使用内置 SeaDrop 单例地址。雷达默认每 30 秒刷新，首次回看按各链平均出块时间估算 7 天，`SEADROP_LOOKBACK_BLOCKS` 或 `SEADROP_LOOKBACK_BLOCKS_<CHAIN_KEY>` 可覆盖区块预算。单次 RPC 日志范围为 5,000 个区块，每个成功分块都会独立推进连续 checkpoint。部署者风险默认将钱包年龄小于 7 天或 NFT 项目数不少于 5 标为风险，可通过上面的两个阈值调整。

### 前端源码与 iframe 边界

`apps/nfttool/src/pages/Tool/Iframe/` 是 NFT TOOL 原始装载边界。钱包和高级 Mint 路由以路由 `name` 生成 `${iframeDomain}/${name}?thekkkey=12`，不调用 611nft 的 `/api/wallets`、`/api/token-holdings` 或 `/api/advanced-mint`。开发配置的 `iframeDomain` 为 `http://localhost:8081`，生产配置为 NFT TOOL 独立运行时。

`apps/nfttool/src/workspace/` 是 611nft 保留模块的本地源码，包括 NFT Live Mint、跟单、报警和相关数据视图；根目录 `src/` 保留兼容入口。`/highHexMint/opensea` 由 `OpenSea.tsx` 加载同源 `/opensea/`，项目名称、Logo、API 与 SSE 继续来自本地 611nft 服务。原压缩包没有钱包和高级 Mint iframe 内部应用的源码，因此补充这部分时应提供独立的 NFT TOOL 运行时，而不是重新接回 611nft 业务页面。

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

首个未命名私钥映射为 `default`，后续未命名私钥映射为 `wallet-002`、`wallet-003`。页面创建的钱包会在 `.env` 中写入 `# 611nft-profile: PROFILE_ID` 标记，并将文件权限固定为 `600`。不要在 Issue、PR、日志或截图中粘贴 `.env`。

## 实时情报与报警

访问 `GET /api/bootstrap?chainId=1&window=1800` 可一次取得监控状态、Overview、Trending、SeaDrop 雷达和个人标记。浏览器随后连接 `GET /api/mint-monitor/stream?chainId=1`；带 `id` 的事件按 `chainId-sequence` 游标写入每链 ring buffer，重连时通过 `Last-Event-ID` 补发。游标过旧、非法或跨链时服务发送 `replay_reset`，客户端重新获取 bootstrap。

同链同合约在 `MINT_MONITOR_BATCH_MS` 内合为 `mint_batch`，并携带数量、原事件编号和 token ID 区间。`heartbeat` 每秒提供 `mintRate` 与最近 60 秒样本；媒体、部署者或合集字段完成后发送 `collection_patch`，链重组回撤发送 `discard`。`MINT_MONITOR_REPLAY_BUFFER` 控制每链可重放事件数，heartbeat 是瞬时状态，不占用重放缓冲。

| API | 作用 |
| --- | --- |
| `GET /api/bootstrap` | 聚合首屏状态、Overview、Trending、雷达和标记 |
| `GET /api/mint-monitor/status` | HTTP/WSS/实时缓冲健康状态 |
| `GET /api/mint-monitor/trending` | `60` 至 `86400` 秒的多窗口热度排名 |
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
2. 选择本地 profiles，填写数量、Token ID、并发和可选价值上限。
3. Preview 查看逐钱包预检。
4. 点击 Mint 时服务端重新 Preview，确认后使用一次性 token 广播。
5. 等待每个钱包进入 confirmed、failed 或 confirmation pending。

`Script` 页的 dry-run 在 `ascii-cats-mint/.env` 未配置钱包时，会自动使用根 `.env` 的首个本地 profile；该模式只做链上读取和流程演练。Armed 模式仍要求输入 `ARM` 并通过二次确认。

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

## ASCII Cats 专项 runner

```bash
cd ascii-cats-mint
npm ci
cp .env.example .env
cp proxies.example.txt proxies.txt
npm run check
npm test
```

保持 `ARM=false` 进行配置和 dry-run。真实发送前阅读 [`ascii-cats-mint/README.md`](ascii-cats-mint/README.md) 与 [`ascii-cats-mint/FRIEND_SETUP_ZH.md`](ascii-cats-mint/FRIEND_SETUP_ZH.md)。

## 验证

```bash
npm ci
npm run check
npm ci --prefix ascii-cats-mint
npm run check --prefix ascii-cats-mint
npm test --prefix ascii-cats-mint
```

验证不需要广播交易。测试凭据均为公开合成 fixture，不得用于真实钱包。

## 主要路径

| 路径 | 作用 |
| --- | --- |
| `apps/nfttool/` | NFT TOOL Umi/Ant Design 主平台、菜单、611nft 品牌和模块边界 |
| `apps/nfttool/src/pages/Tool/Iframe/` | NFT TOOL 钱包与高级 Mint 的原始 iframe 装载层 |
| `apps/nfttool/src/workspace/` | 611nft Live Mint、跟单、报警和本地数据视图源码 |
| `src/` | 指向 611nft 保留工作区源码的兼容入口 |
| `server/index.js` | Express 5 API、SQLite、本地签名和任务状态机 |
| `server/wallet-provider.js` | 根 `.env` profile 解析、生成和本地账户加载 |
| `server/mint-monitor.js` | 多链直接扫描、供应量、价格和 minter 回填 |
| `server/nft-mint.js` | NFT Mint 计划校验、预检与重报价 |
| `server/rpc-pool.js` | 多上游读取容错，写方法单次发送 |
| `test/` | 主项目单元与 API 安全回归测试 |
| `ascii-cats-mint/` | 独立 ASCII Cats 多钱包 runner |

## 已知限制

- NFT TOOL 压缩包没有钱包与高级 Mint 独立业务运行时源码；这些页面依赖 `iframeDomain` 服务。2026-08-17 验证时生产运行时返回 HTTP 522，路由和源码归属正确，但业务页面内容取决于该独立服务恢复或补齐。
- 钱包与高级 Mint 已恢复原始菜单；旧 NFT TOOL 的其他未接入产品区仍不在路由表中。
- 生产部署必须同时构建 `/tool/` 外壳与 `/opensea/` 工作区，缺少任一构建目录都会造成对应入口缺失。
- 链、RPC、OpenSea、Waypoint、Blockscout 和 metadata gateway 的 schema、限速与可用性会影响数据完整性。
- provider 数据和本地扫描可能短暂处于不同进度；链上 `totalSupply()` 优先，读取失败时显示保守值或未知值。
- 根 `.env` 是本地钱包的唯一签名源；升级前应独立备份、限制权限并验证地址。
- 开源发布不代表经过第三方安全审计。

## 贡献与许可

提交前阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md)，运行完整验证，并确保不包含 `.env`、钱包、代理凭据、认证 RPC URL、SQLite、日志、HAR 或签名材料。

项目以 [MIT License](LICENSE) 开源。第三方产品、协议和商标归各自所有。

---

## English

611nft 2.0 is a local-first, seven-chain NFT mint monitor and wallet console. It includes direct ERC-721/ERC-1155 scanning, SSE activity, persistent minter statistics, local profile management, balance and asset operations, and preview-first NFT mint execution.

Local wallet keys are read from one bare hexadecimal line per profile in the root `.env`; they are never returned to the browser or stored in SQLite. Every value-moving operation uses an immutable server preview and a short-lived one-time confirmation token. Non-loopback listeners require `WALLET_BOARD_API_TOKEN`.

See the Chinese sections above and [`DESIGN.md`](DESIGN.md) for the complete installation, migration, API, and security model.
