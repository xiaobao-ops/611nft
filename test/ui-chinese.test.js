import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { APP_ROUTES } from "../src/routes.js"
import { uiError } from "../src/ui-text.js"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const source = (relativePath) => readFileSync(join(ROOT, relativePath), "utf8")

test("all retained routes expose Chinese labels", () => {
  assert.deepEqual(APP_ROUTES.map((route) => route.label), [
    "钱包管理",
    "分发代币",
    "归集代币",
    "多对多转账",
    "交易所充值",
    "NFT 盯盘",
    "跟单/自动铸造",
    "项目破签",
    "高级铸造",
    "OpenSea",
    "批量挂单",
    "NFT 归集",
    "批量授权",
    "报警监控",
    "交易记录",
  ])
})

test("reachable React pages do not restore removed English interface phrases", () => {
  const combined = ["src/Shell.jsx", "src/AlarmRoute.jsx", "src/TransactionsRoute.jsx"].map(source).join("\n")
  for (const phrase of [
    "Wallet Manager",
    "Follow Mint",
    "Mint Professional",
    "Sign Task Module",
    "Batch Approval",
    "Contract Call",
    "NFT Stream",
    "FREE / 免费 Mint",
    "Start armed mint runner",
  ]) assert.doesNotMatch(combined, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"))
})

test("Chinese confirmation phrases and mixed RPC errors stay Chinese", () => {
  const walletManager = source("public/nfttool-runtime/wallet-manager.js")
  const server = source("server/index.js")
  assert.match(walletManager, /management\.exportPrivateKeys/)
  assert.doesNotMatch(server, /api\/wallets\/export|确认导出私钥/)
  const translated = uiError("Gas 估算失败，签名器发送时将重试：execution reverted")
  assert.equal(translated, "Gas 估算失败，签名器发送时将重试：合约执行已在链上回退")
  assert.doesNotMatch(translated, /execution|reverted/i)
})

test("single Vite document and shell expose localized accessibility text", () => {
  const html = source("index.html")
  const shell = source("src/Shell.jsx")
  assert.match(html, /<html lang="zh-CN">/)
  for (const label of ["关闭导航", "功能导航", "展开导航", "收起导航", "打开导航"]) {
    assert.match(shell, new RegExp(label))
  }
  assert.doesNotMatch(shell, /aria-label=["'](?:wallet|menu|close|logo)["']/i)
})
