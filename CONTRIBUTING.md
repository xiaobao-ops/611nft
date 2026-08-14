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

Node.js 需要 22 或更高版本。钱包写操作的本地验证还需要独立安装 `awp-wallet`。

## Git worktree 协作

团队成员不要在共享的主工作目录中直接开发。每个任务使用独立分支和独立 worktree：

```bash
git fetch origin
git worktree add ../611nft-<task> -b <type>/<task> origin/main
cd ../611nft-<task>
npm ci
```

在任务 worktree 中完成开发、测试、提交和推送，然后创建 Pull Request。合并后清理本地 worktree：

```bash
cd ../611nft
git worktree remove ../611nft-<task>
git branch -d <type>/<task>
git worktree prune
```

每个分支只能被一个 worktree 检出；不要让多名成员共享同一个 worktree、分支或 `.env`。分支名使用 `feat/`、`fix/`、`docs/` 或 `chore/` 前缀，并保持一个任务对应一个 Pull Request。

## 提交 Pull Request

1. 从最新 `origin/main` 创建任务 worktree 和功能分支。
2. 保持改动聚焦，避免把无关格式化混入同一提交。
3. 修改行为时同步更新 README 或 DESIGN。
4. 运行 `npm run check`；触及专项 runner 时还需运行 `npm test --prefix ascii-cats-mint`。
5. UI 改动请附桌面端和移动端截图。
6. Mint、转账、授权或 contract call 改动必须说明 Preview、确认、广播、partial 和 pending 路径的影响。

## 数据与凭据

提交前检查：

- 不包含 `.env`、私钥、助记词或钱包导出文件。
- 不包含 Cookies、会话、认证 Header、带密钥的 RPC URL。
- 不包含浏览器 HAR、日志、PCAP 或真实交易签名材料。
- 测试使用确定性的无资金测试私钥或临时钱包，且不要复用真实钱包。

发现安全问题时不要创建公开 Issue，请按 [`SECURITY.md`](SECURITY.md) 操作。
