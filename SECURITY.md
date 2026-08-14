# Security Policy

## Supported version

安全修复优先应用于 `main` 分支的最新版本。

## Reporting a vulnerability

请使用 GitHub 仓库的 **Security → Report a vulnerability** 私密报告功能提交安全问题：

<https://github.com/Zerorisklabs-V1/611nft/security/advisories/new>

报告建议包含：

- 受影响的提交或版本
- 复现条件与最小步骤
- 预期与实际行为
- 对私钥、交易、RPC、浏览器或本地服务边界的影响
- 已验证的修复建议（如有）

请勿在公开 Issue、Pull Request、日志或截图中发布私钥、助记词、Cookies、认证 RPC URL、confirmation token 或已签名交易。

## Operational guidance

- 使用专用低余额钱包，不要复用长期资产钱包。
- `.env`、AWP profile 和 SQLite 应按敏感数据保护，运行机器应启用磁盘加密和屏幕锁。
- 默认保持 `WALLET_BOARD_API_HOST=127.0.0.1`。非回环监听必须设置高强度 `WALLET_BOARD_API_TOKEN`，并同时配置 TLS、防火墙与网络隔离。
- 不要把 Bearer token 放入 URL、截图、Issue、日志或 shell 历史。
- 广播前核对链、合约、calldata、数量、价格、Gas 和接收地址。
- `ascii-cats-mint` 默认保持 `ARM=false`；代理、Ticket 和钱包配置应使用隔离的低价值环境验证。
- 开源发布不代表经过第三方安全审计。
