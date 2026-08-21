import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { uiError } from "../src/ui-text.js"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const source = (relativePath) => readFileSync(join(ROOT, relativePath), "utf8")

test("retained routes and fallback menus expose Chinese labels", () => {
  const routes = source("apps/nfttool/config/routes.ts")
  const menu = source("apps/nfttool/src/locales/zh-CN/menu.ts")
  const expectedRoutes = [
    "/walletManager/walletManager",
    "/walletManager/ethDisperse",
    "/walletManager/ethCollection",
    "/walletManager/moreToMore",
    "/walletManager/despositToExchange",
    "/mint",
    "/documentaryList",
    "/highHexMint/signTask",
    "/highHexMint/highHexMint",
    "/highHexMint/contract",
    "/highHexMint/opensea",
  ]
  for (const route of expectedRoutes) assert.match(routes, new RegExp(`path: ['"]${route.replaceAll("/", "\\/")}['"]`))
  for (const label of ["钱包管理", "分发代币", "归集代币", "多对多转账", "交易所充值", "NFT 盯盘", "跟单/自动铸造", "项目破签", "高级铸造", "OpenSea"]) {
    assert.match(menu, new RegExp(`['"]${label.replace("/", "\\/")}['"]`))
  }
})

test("retained workspaces do not restore removed English interface phrases", () => {
  const files = [
    "src/App.jsx",
    "src/LiveMintView.jsx",
    "src/FollowMintView.jsx",
    "src/SignatureLabView.jsx",
    "src/AdvancedMintView.jsx",
    "apps/nfttool/src/app.tsx",
    "apps/nfttool/src/pages/WorkspaceModule/index.tsx",
    "apps/nfttool/src/pages/Tool/Iframe/index.tsx",
  ]
  const combined = files.map(source).join("\n")
  for (const phrase of [
    "Wallet Manager",
    "Follow Mint",
    "Mint Professional",
    "Sign Task Module",
    "Batch Approval",
    "Contract Call",
    "NFT Stream",
    "FREE / 免费 Mint",
    "自动 Gas Limit",
    "Max fee",
    "Priority fee",
    "Preview 自动读取",
    "Start armed mint runner",
    "contract and mint value applied",
    "transaction parameters applied",
  ]) assert.doesNotMatch(combined, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"))
})

test("Chinese confirmation phrases and mixed RPC errors stay Chinese", () => {
  const app = source("src/App.jsx")
  const server = source("server/index.js")
  assert.match(app, /exportPhrase !== "确认导出私钥"/)
  assert.match(server, /phrase \|\| ""\)\.trim\(\) !== "确认导出私钥"/)
  const translated = uiError("Gas 估算失败，签名器发送时将重试：execution reverted")
  assert.equal(translated, "Gas 估算失败，签名器发送时将重试：合约执行已在链上回退")
  assert.doesNotMatch(translated, /execution|reverted/i)
})

test("outer workspace declares Chinese and localizes icon accessibility text", () => {
  const app = source("apps/nfttool/src/app.tsx")
  assert.match(app, /document\.documentElement\.lang = ['"]zh-CN['"]/)
  for (const label of ["钱包管理", "NFT 盯盘", "跟单和自动铸造", "高级铸造", "月亮", "太阳", "NFT TOOL 标志"]) {
    assert.match(app, new RegExp(`(?:aria-label|alt)=["']${label}["']`))
  }
  for (const label of ["wallet", "aim", "unordered-list", "thunderbolt", "sun", "moon", "logo"]) {
    assert.doesNotMatch(app, new RegExp(`(?:aria-label|alt)=["']${label}["']`, "i"))
  }
})
