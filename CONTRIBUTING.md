# Contributing to 611nft

感谢参与 611nft。Bug 修复、RPC 兼容性改进、界面优化、翻译和文档补充都欢迎提交。

## 开发环境

```bash
git clone https://github.com/xiaobao-ops/611nft.git
cd 611nft
npm ci
cp .env.example .env
npm test
```

Node.js 需要 22 或更高版本。首次构建 eRPC 还需要 Go 工具链。

## 提交 Pull Request

1. 从最新 `main` 创建功能分支。
2. 保持改动聚焦，避免把无关格式化混入同一提交。
3. 修改行为时同步更新 README 或 DESIGN。
4. 运行 `npm test`，并说明其它手工验证步骤。
5. UI 改动请附桌面端和移动端截图。
6. Mint 执行改动必须说明 Preview、确认、广播和失败路径的影响。

## 数据与凭据

提交前检查：

- 不包含 `.env`、私钥、助记词或钱包导出文件。
- 不包含 Cookies、会话、认证 Header、带密钥的 RPC URL。
- 不包含浏览器 HAR、日志、PCAP 或真实交易签名材料。
- 测试使用确定性的无资金测试私钥或临时钱包，且不要复用真实钱包。

发现安全问题时不要创建公开 Issue，请按 [`SECURITY.md`](SECURITY.md) 操作。
