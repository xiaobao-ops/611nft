import assert from "node:assert/strict"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { APP_ROUTES, resolveRoute } from "../src/routes.js"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const source = (path) => readFileSync(join(ROOT, path), "utf8")

test("the root route table is the single owner of the 15 retained features", () => {
  assert.equal(APP_ROUTES.length, 15)
  assert.equal(APP_ROUTES.filter((route) => route.kind === "runtime").length, 13)
  assert.deepEqual(APP_ROUTES.filter((route) => route.kind !== "runtime").map((route) => [route.id, route.kind]), [
    ["wallet-alert", "alarm"],
    ["transactions", "transactions"],
  ])
  const legacyWorkspace = join(ROOT, "apps/nfttool/src/workspace")
  const legacySources = existsSync(legacyWorkspace)
    ? readdirSync(legacyWorkspace, { recursive: true }).filter((entry) => /\.(?:[cm]?[jt]sx?|css)$/.test(entry))
    : []
  assert.deepEqual(legacySources, [])
  assert.equal(existsSync(join(ROOT, "src/WorkspaceRoute.jsx")), false)
})

test("runtime features are loaded from static Vite assets by module", () => {
  const runtimeRoute = source("src/RuntimeRoute.jsx")
  const runtime = source("public/nfttool-runtime/app.js")
  const expectedLoaders = [
    ["walletManager", "wallet-manager.js", "renderWalletManager"],
    ["ethDisperse", "transfer-pages.js", "renderDisperse"],
    ["ethCollection", "transfer-pages.js", "renderCollection"],
    ["moreToMore", "transfer-pages.js", "renderManyToMany"],
    ["despositToExchange", "transfer-pages.js", "renderExchangeDeposit"],
    ["mint", "mint-monitor.js", "renderMintMonitor"],
    ["documentaryList", "follow-mint.js", "renderFollowMint"],
    ["signTask", "advanced-mint.js", "renderSignatureTask"],
    ["highHexMint", "advanced-mint.js", "renderAdvancedMint"],
    ["opensea", "opensea-mint.js", "renderOpenSeaMint"],
    ["batchSell", "nft-management.js", "renderBatchSell"],
    ["collectionNFT", "nft-management.js", "renderNftCollection"],
    ["batchApprove", "nft-management.js", "renderBatchApprove"],
  ]
  for (const [moduleName, file, renderer] of expectedLoaders) {
    const escapedFile = file.replaceAll(".", "\\.")
    assert.match(runtime, new RegExp(`${moduleName}: \\(\\) => import\\('\\./${escapedFile}'\\)`))
    assert.match(runtime, new RegExp(renderer))
  }
  assert.match(runtimeRoute, /src=\{`\/nfttool-runtime\/\$\{route\.moduleName\}`\}/)
  assert.match(runtime, /await pageLoaders\[routeName\]\(\)/)
  assert.doesNotMatch(runtime, /\|\|\s*renderWalletManager|WorkspaceModule|611nft-logo-ui/)
})

test("the outer shell is the only owner of runtime page titles", () => {
  const shell = source("src/Shell.jsx")
  const core = source("public/nfttool-runtime/core.js")
  const styles = source("public/nfttool-runtime/styles.css")
  assert.match(shell, /<h1>\{activeRoute\?\.label/)
  assert.doesNotMatch(core, /routeMeta|<h1>|meta\.(?:title|section)/)
  assert.match(core, /class="runtime-statusbar" aria-label="钱包选择状态"/)
  assert.match(core, /runtimeState\.wallets\.length/)
  assert.match(core, /selectedIds\(\)\.length/)
  assert.doesNotMatch(styles, /\.runtime-header/)
  assert.match(styles, /\.runtime-statusbar\s*\{[\s\S]*min-height:\s*34px/)
})

test("alarm and transaction routes are independent lazy chunks", () => {
  const shell = source("src/Shell.jsx")
  const alarm = source("src/AlarmRoute.jsx")
  const transactions = source("src/TransactionsRoute.jsx")
  assert.match(shell, /lazy\(\(\) => import\("\.\/AlarmRoute\.jsx"\)\)/)
  assert.match(shell, /lazy\(\(\) => import\("\.\/TransactionsRoute\.jsx"\)\)/)
  assert.doesNotMatch(shell, /WorkspaceRoute|\.\/App\.jsx|\.\/styles\.css|mint-script|script-start/)
  assert.match(alarm, /\/api\/alerts\?chainId=/)
  assert.match(alarm, /\/api\/alerts\/test/)
  assert.match(transactions, /\/api\/transactions\?limit=100/)
  assert.doesNotMatch(`${alarm}\n${transactions}`, /\/api\/(?:nft-mint|mint-script|tasks|plan)\b|privateKey|mnemonic/)
})

test("legacy addresses resolve to canonical retained routes", () => {
  assert.equal(resolveRoute("/walletManager/disperse").canonicalPath, "/tool/walletManager/ethDisperse")
  assert.equal(resolveRoute("/walletManager/collect").canonicalPath, "/tool/walletManager/ethCollection")
  assert.equal(resolveRoute("/highHexMint/contract").canonicalPath, "/tool/highHexMint/highHexMint")
  assert.equal(resolveRoute("/opensea/").canonicalPath, "/tool/highHexMint/opensea")
  assert.equal(resolveRoute("/walletAlert").canonicalPath, "/tool/walletAlert")
  assert.equal(resolveRoute("/transactions").canonicalPath, "/tool/transactions")
})

test("browser-targeted sources avoid BigInt exponentiation downleveling", () => {
  for (const file of ["monitor-intelligence.js", "AlarmRoute.jsx", "TransactionsRoute.jsx"]) {
    assert.doesNotMatch(source(`src/${file}`), /\d+n\s*\*\*\s*\d+n/)
  }
})
