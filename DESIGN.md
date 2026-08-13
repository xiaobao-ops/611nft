# 611nft 设计与安全说明

## 威胁模型与信任边界

- **高价值资产**：本地钱包私钥、待签名交易、confirmation token、带认证信息的 RPC/Cookie 配置。
- **受信任边界**：运行 611nft 的本机、项目 `.env`、本地 Node.js 进程和显式配置的 RPC 上游。
- **不受信任输入**：合集/实时数据上游、GraphQL 返回、RPC 响应、浏览器请求体、URL hash、WebSocket 消息和外部链接。
- **主要防御目标**：私钥泄露、错误链/错误目标广播、过期价格计划、重复广播、未选钱包签名、远程网页直接调用本地服务。
- **边界外风险**：运行机器已被控制、恶意 npm/Go 工具链、上游蓄意返回但仍通过业务校验的数据，以及用户确认后的链上市场风险。

## 架构

- `apps/web/`：Vanilla JS 三栏 SPA，使用 611nft Logo/品牌，复用取证到的布局变量与交互结构。
- `server/index.mjs`：本地静态服务器、真实数据代理、本地 WebSocket、Mint Preview/Job/Send。
- `lib/mint-core.mjs`：CLI 与 Web 共用的钱包加载、OpenSea 计划、链校验、Gas/余额预检、SeaDrop 重报价、并发发送。
- `lib/wallet-config.mjs`：从 `.env` 提取逐行裸私钥，并保持普通 dotenv 配置和旧钱包变量兼容。
- `mint.mjs`：保留原 CLI 入口。
- `erpc/erpc.js`、`scripts/start-stack.mjs`：固定版本 eRPC 的多上游、重试/hedging/熔断/缓存配置及完整栈生命周期。

## 数据流

1. `/api/chains`、`/api/overview/all`、`/api/collection/:address` 代理真实数据。
2. `/ws/mints` 优先转发目标 WebSocket 的非聊天事件；握手被限速时，服务端每 5 秒比较真实 60 秒 Overview 的 `total_mints` 增量并生成活动事件，不使用 mock。
3. `/api/wallets` 只输出地址与余额。
4. `/api/mint/preview` 为每个钱包构造独立交易计划，服务端保存含 account 的任务对象，响应经过脱敏。
5. `/api/mint/send` 校验一次性 confirmation token 后并发广播；状态通过本地 WebSocket 发布。
6. `/api/rpc/status` 对 eRPC 的两条链执行 `eth_chainId` 与 `eth_blockNumber` 批量探测，返回区块高度和延迟。

## 品牌与本地化

- 产品标题、页签、左上角名称与 Logo 统一为 611nft；Logo 文件为 `apps/web/assets/611nft-logo.png`。
- `apps/web/app.js` 内置 `zh-CN` / `en` 字典，静态标签与动态钱包、统计、Preview、Live Feed 状态共用同一翻译入口。
- 首次语言根据浏览器语言选择，用户选择保存在 `611nft_lang`；390px 视口保留 Logo 与语言按钮且不产生横向溢出。
- eRPC 子进程只接收外部上游列表；Web/CLI 子进程才接收 `http://127.0.0.1:4000/main/evm/:chainId`，从进程边界阻止聚合 RPC 自循环。
- eRPC 在 `.runtime/erpc` 独立工作目录启动，避免其内置 dotenv 解析器读取项目根目录中的逐行裸私钥。

## 关键安全决策

- 默认 Preview，广播必须第二次显式确认；token 仅在 `previewed` 状态返回，发送后立即清空。
- Web 与 CLI 链配置隔离，避免 CLI 的 `CHAIN_*` 将 UI 的 Ethereum 请求错误路由到 Robinhood。
- OpenSea 返回内容视为外部数据：校验同链、networkId、目标地址和 calldata。
- 拒绝跨链 Relayer；私钥不进入 URL、GraphQL、前端、日志或持久化任务文件。
- 每钱包独立从 OpenSea 获取计划，不复用其它钱包的 calldata 签名上下文。
- SeaDrop `mintPublic` 发送前读取 `getPublicDrop`；价格上涨要求重新 Preview。
- 余额不足钱包跳过；其它预检异常阻止整批任务。
- 浏览器响应不含 calldata 和私钥，仅显示必要交易摘要。
- 服务默认仅监听 `127.0.0.1:18787`，禁用跨域响应和 `X-Powered-By`。

## 已知外部条件

- 目标 WebSocket 可能按出口限速。直连恢复后自动切回完整消息流；期间真实 Overview 增量仍驱动列表和 Live Feed。
- OpenSea GraphQL schema、公开 RPC 或 Mint 阶段随时间变化时，Preview 会以逐钱包错误呈现，不自动广播。
- 链上交易确认后不可逆；操作者需核对合约、链、金额、Gas 和每钱包计划。
