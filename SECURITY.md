# Security Policy

## Supported version

安全修复优先应用于 `main` 分支的最新版本。

## Reporting a vulnerability

请使用 GitHub 仓库的 **Security → Report a vulnerability** 私密报告功能提交安全问题：

<https://github.com/xiaobao-ops/611nft/security/advisories/new>

报告建议包含：

- 受影响的提交或版本
- 复现条件与最小步骤
- 预期与实际行为
- 对私钥、交易、RPC、浏览器或本地服务边界的影响
- 已验证的修复建议（如有）

请勿在公开 Issue、Pull Request、日志或截图中发布私钥、助记词、Cookies、认证 RPC URL、confirmation token 或已签名交易。

## Operational guidance

- 使用专用低余额钱包，不要复用长期资产钱包。
- AWP profile、根 `.env` 和 SQLite 应按敏感数据保护，运行机器应启用磁盘加密和屏幕锁。
- 默认保持 `WALLET_BOARD_API_HOST=127.0.0.1`。非回环监听必须设置高强度 `WALLET_BOARD_API_TOKEN`，并同时配置 TLS、防火墙与网络隔离。
- 不要把 Bearer token 放入 URL、截图、Issue、日志或 shell 历史。
- 广播前核对链、合约、calldata、数量、价格、Gas 和接收地址。
- 浏览器只接收钱包地址和能力声明；私钥由外部 `awp-wallet` profile 持有，不进入项目 `.env`、API 响应或 SQLite。
- 归集要求 Wallet Provider 能在同一写 RPC 上准备并签名最终 envelope；不具备该能力时直接拒绝，不降级猜测 Gas 或金额。
- 供应链检查：根 `package-lock.json` 仅保留一个锁文件；`npm audit`（含 `--omit=dev`）必须无 high/critical，并在依赖变更后生成 `output/sbom.cdx.json`。扫描中出现的 Robinhood Seaport conduit key 是链上公开标识，不是认证凭据，代码旁以 `gitleaks:allow` 精确标注；任何真正的 API、RPC、Telegram 或钱包秘密都不得使用该例外。
- 开源发布不代表经过第三方安全审计。
