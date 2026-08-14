<div align="center">
  <img src="apps/web/assets/611nft-logo.png" width="112" alt="611nft logo">
  <h1>611nft</h1>
  <p><strong>本地优先的多链 NFT Mint 监控与 AWP 钱包工作台</strong></p>
  <p>Local-first multi-chain NFT mint monitor and AWP wallet console.</p>
</div>

611nft 2.0 将 NFT 实时监控、安全 Mint、钱包分组、余额查询、批量转账、归集、ERC-20 授权和任意合约调用整合在一个 React 工作台中。默认只监听 `127.0.0.1`，私钥由外部 `awp-wallet` profile 持有，不进入浏览器、项目 `.env` 或 SQLite。

> [!WARNING]
> 该工具能够签名并广播不可撤销的链上交易。请使用专用低余额钱包，先做 Preview，核对链、合约、calldata、金额、Gas 和接收地址。不要把服务直接暴露到不可信网络。

## 功能

- Ethereum、Base、Arbitrum、Optimism、Polygon、BSC、Robinhood Chain 七链支持。
- ERC-721/ERC-1155 零地址 Transfer 直接扫描；上游不可用时按区间日志、逐块日志、receipt 逐级降级。
- 合集供应量、Mint 价格、钱包限额、最近 Mint、媒体和全历史独立 Mint 钱包统计。
- SSE 实时活动流，RPC hedging、缓存、请求合并和熔断。
- 外部 AWP wallet profile 发现、创建、标签、分组、备注、收藏和风险标记。
- 原生币/ERC-20 余额、one-to-many、many-to-one、many-to-many、approve/revoke 与 contract call。
- NFT Mint 最多 200 个钱包、并发上限 32、价值上限、广播前重报价和再次预检。
- SQLite 持久化钱包元数据、余额、任务、交易日志和 lifetime minter 回填游标。
- 独立 `ascii-cats-mint/` 专项 runner，默认 dry-run，真实发送必须显式 ARM。

## 安全边界

- 所有资金写操作采用服务端不可变 Preview 和短期一次性 confirmation token；前端确认框不是安全边界。
- NFT Mint 广播前重新检查链、目标 bytecode、calldata、价格、Gas、余额和配置的价值上限。
- 非回环监听必须配置 `WALLET_BOARD_API_TOKEN`，API 使用 `Authorization: Bearer <token>`。
- 默认回环模式不要求 token，方便本机 UI 和 CLI；仍应避免访问恶意网页或运行不可信本机程序。
- SQLite 不保存私钥、助记词或 AWP 密钥材料，但包含钱包地址、余额和交易历史，应按敏感本地数据保护。
- NFT metadata 代理拒绝本机、私网、链路本地和保留地址。

更完整的信任边界和状态机见 [`DESIGN.md`](DESIGN.md)，安全报告方式见 [`SECURITY.md`](SECURITY.md)。

## 要求

- Node.js 22+
- npm
- `awp-wallet` 在 `PATH` 中，并已配置操作者自己的本地 profiles

只读监控不需要钱包 profile。任何 Mint、转账、授权或 contract call 都需要可用的 AWP profile。

## 安装与启动

```bash
git clone https://github.com/Zerorisklabs-V1/611nft.git
cd 611nft
npm ci
cp .env.example .env
npm run dev
```

开发界面默认位于 `http://127.0.0.1:5173`。生产式本地启动：

```bash
npm run build
npm run server
```

访问 `http://127.0.0.1:8787`。macOS 也可以双击 `一键MintScan.command`。

## 配置

根 `.env` 只保存服务和 RPC 配置，不再保存钱包私钥：

```dotenv
WALLET_BOARD_PORT=8787
WALLET_BOARD_API_HOST=127.0.0.1
WALLET_BOARD_API_HOSTS=

ETH_RPC_URL=https://ethereum.publicnode.com
BASE_RPC_URL=https://base.publicnode.com
ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com
```

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

### 从 1.x 迁移钱包

1.x 支持在项目 `.env` 中逐行填写裸私钥。2.0 不再读取这些私钥；请将所需钱包迁移为本地 AWP profiles，确认地址一致后再从项目 `.env` 删除旧密钥。

不要在 Issue、PR、日志或截图中粘贴迁移前的 `.env`。

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
| `src/` | React 19 工作台、Mint 监控和任务 UI |
| `server/index.js` | Express 5 API、SQLite、AWP 调用和任务状态机 |
| `server/mint-monitor.js` | 多链直接扫描、供应量、价格和 minter 回填 |
| `server/nft-mint.js` | NFT Mint 计划校验、预检与重报价 |
| `server/rpc-pool.js` | 多上游读取容错，写方法单次发送 |
| `test/` | 主项目单元与 API 安全回归测试 |
| `ascii-cats-mint/` | 独立 ASCII Cats 多钱包 runner |

## 已知限制

- 链、RPC、OpenSea、Waypoint、Blockscout 和 metadata gateway 的 schema、限速与可用性会影响数据完整性。
- provider 数据和本地扫描可能短暂处于不同进度；链上 `totalSupply()` 优先，读取失败时显示保守值或未知值。
- AWP profile 生命周期由外部 `awp-wallet` 管理；升级前应独立备份并验证钱包。
- 开源发布不代表经过第三方安全审计。

## 贡献与许可

提交前阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md)，运行完整验证，并确保不包含 `.env`、钱包、代理凭据、认证 RPC URL、SQLite、日志、HAR 或签名材料。

项目以 [MIT License](LICENSE) 开源。第三方产品、协议和商标归各自所有。

---

## English

611nft 2.0 is a local-first, seven-chain NFT mint monitor and AWP wallet console. It includes direct ERC-721/ERC-1155 scanning, SSE activity, persistent minter statistics, AWP profile management, balance and asset operations, and preview-first NFT mint execution.

Wallet secrets are no longer stored in the project `.env`; signing is delegated to local `awp-wallet` profiles. Every value-moving operation uses an immutable server preview and a short-lived one-time confirmation token. Non-loopback listeners require `WALLET_BOARD_API_TOKEN`.

See the Chinese sections above and [`DESIGN.md`](DESIGN.md) for the complete installation, migration, API, and security model.
