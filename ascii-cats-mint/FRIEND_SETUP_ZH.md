# ASCII Cats 自动 Mint 脚本——朋友使用说明

本压缩包只包含公开源码、测试、示例配置和说明，不包含原使用者的助记词、私钥、API 密钥、真实代理、动态代理 API URL 或发送状态。每位使用者必须配置自己的钱包与代理，并自行承担链上费用和风险。

## 1. 环境要求

- macOS、Windows 或 Linux
- Node.js 22 或更高版本
- 专门用于本次 Mint 的隔离助记词，或一个隔离单钱包私钥
- 每个派生地址都有 Robinhood Chain gas
- 20 条不同出口 IP 的静态代理
- 可返回 30 条动态代理的个人 HTTPS API URL
- 若代理商使用 IP 白名单，运行机器当前公网 IP 必须已加入白名单

检查 Node.js：

```bash
node --version
```

## 2. 安装

解压后进入目录：

```bash
cd ascii-cats-mint
npm ci
cp .env.example .env
cp proxies.example.txt proxies.txt
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env
Copy-Item proxies.example.txt proxies.txt
```

## 3. 配置自己的钱包

编辑 `.env`。当前 50 钱包混合代理方案：

```dotenv
MNEMONIC=填写你自己的隔离助记词
# 助记词模式不要再设置 PRIVATE_KEY。
WALLET_COUNT=50
MINT_CONCURRENCY=20
STATIC_PROXY_COUNT=20
DYNAMIC_PROXY_COUNT=30
PROXY_API_URL=填写你自己的代理商 HTTPS JSON API URL
PROXY_API_TIMEOUT_MS=10000
PROXY_CHECK_TIMEOUT_MS=10000
PROXY_MAX_REPLACEMENTS=20
PROXY_POOL_DEADLINE_MS=60000
ARM=false
```

脚本按以下路径派生 50 个地址：

```text
m/44'/60'/0'/0/0
m/44'/60'/0'/0/1
...
m/44'/60'/0'/0/49
```

不要使用存放其他重要资产的主钱包助记词，也不要把 `.env` 发给任何人。

如果只使用一个钱包，保持 `MNEMONIC` 为空并填写 `PRIVATE_KEY`；同时按 `README.md` 调整代理槽位配置。

## 4. 配置 20 条静态代理

编辑 `proxies.txt`，只放 `STATIC_PROXY_COUNT=20` 条静态代理，每行一条：

```text
socks5h://user:password@host:port
http://user:password@host:port
```

也支持代理商常见格式：

```text
IP:PORT:USER:PASSWORD
```

链上 RPC 直连共享，代理只用于请求项目方 Ticket。后 30 条动态代理不写入 `proxies.txt`，而是在 Mint 开放、gas 预检通过后由 `PROXY_API_URL` 获取并只保存在内存。

`PROXY_API_URL` 必须使用朋友自己的 URL，不能复制别人的真实 API。若代理商要求白名单，应先在供应商后台添加运行机器的当前公网出口 IP；白名单未生效通常会导致开放后的代理 API 或出口检查失败。

## 5. 先执行安全演练

```bash
npm test
npm run check
npm start
```

`npm start` 默认是 dry-run，只验证配置、钱包派生、链状态、持久化状态和 gas 余额。它不会调用动态代理 API、不会连接静态或动态代理、不会请求 Ticket、不会 reserve 状态、不会签名或广播。

重点确认输出包含：

```text
armed=false
wallets=50
underfunded=0/50
summary: dry-run-ready=50
```

如果存在历史状态，结果可能不是 50 个 `dry-run-ready`。先根据日志和链上结果核对，不要直接删除状态。

## 6. 启动真实自动 Mint

只有在 50 个地址 gas 充足、20 条静态代理已填写、动态代理 API 与白名单已配置后执行：

```bash
npm start -- --arm
```

macOS 可避免电脑休眠：

```bash
caffeinate -dimsu npm start -- --arm
```

看到 `armed=true` 和 `monitoring for Mint open` 表示脚本正在监控。等待期间只使用共享 RPC，不会提前调用动态代理 API，也不会提前消耗动态 Sticky session。

检测到 `mintOpen=true` 后，脚本先等待全部 pending 钱包通过 gas 预检，再获取动态代理并对静态/动态出口做两轮稳定性检查。若启用代理预热，也只覆盖状态过滤后仍 pending 的钱包。只有代理池数量完整、出口稳定唯一且锁定成功，才开始请求 Ticket、验证签名、估算 gas、签名和广播；每次 Ticket 请求默认 10 秒超时，`Ctrl+C` 也会取消未完成请求。

代理 API 超时、白名单错误、代理失败、出口 IP 重复或替换超限都会在第一条 Ticket 前整批停止。某钱包一旦开始 Ticket POST，就不会自动换代理或重新领票；网络结果不确定时会保留 `ticket-requested` 状态，防止重复 Mint。

## 7. 安全机制

- Ticket 签名必须与链上实时 `mintSigner` 一致。
- Ticket 必须绑定正确的 chain ID、合约、钱包和 salt。
- 已使用或批次内重复的 salt 会在广播前被拒绝。
- gas 估算和费率超过 `.env` 上限时拒绝发送。
- 成功后验证目标合约的 `Minted` 事件、`ownerOf(tokenId)` 和 `hasMinted(wallet)`。
- 每钱包保存独立 `.mint-state/<address>.json`；广播结果不确定时禁止自动补发。
- 错误日志会隐藏 Ticket 签名、calldata、API URL 路径和代理凭证。

## 8. 重要风险

- `--arm` 会发送真实且不可逆的链上交易。
- 脚本无法保证所有钱包都 Mint 成功；Ticket 服务、代理、RPC、链上拥堵和项目方状态都可能实时变化。
- 看到 `prepared`、`ticket-requested`、`submitted` 或 `needs-inspection` 时，不要盲删 `.mint-state/` 重试，必须先核对链上交易和 Mint 结果。
- 不要分享 `.env`、`proxies.txt`、`.mint-state/`、日志、助记词、私钥或真实代理 API URL。

完整参数和运行逻辑请阅读 `README.md`。
