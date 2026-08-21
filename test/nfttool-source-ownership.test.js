import assert from "node:assert/strict"
import { existsSync, readFileSync, readlinkSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const source = (path) => readFileSync(join(ROOT, path), "utf8")

test("NFT TOOL mint, follow, advanced Mint, OpenSea, and NFT management use the NFT TOOL runtime", () => {
  const routes = source("apps/nfttool/config/routes.ts")
  const runtime = source("apps/nfttool/runtime/app.js")
  const expectedRenderers = [
    ["mint", "renderMintMonitor"],
    ["documentaryList", "renderFollowMint"],
    ["signTask", "renderSignatureTask"],
    ["highHexMint", "renderAdvancedMint"],
    ["opensea", "renderLaunchpadMint"],
    ["batchSell", "renderBatchSell"],
    ["collectionNFT", "renderNftCollection"],
    ["batchApprove", "renderBatchApprove"],
  ]
  for (const [route, renderer] of expectedRenderers) {
    assert.match(runtime, new RegExp(`${route}:\\s*${renderer}`))
  }
  assert.doesNotMatch(runtime, /renderOpenSea|\.\/opensea\.js|\|\|\s*renderWalletManager/)
  assert.doesNotMatch(runtime, /WorkspaceModule|611nft|611nft-logo-ui/)
  assert.equal(existsSync(join(ROOT, "apps/nfttool/runtime/opensea.js")), false)
  for (const file of ["mint-monitor.js", "follow-mint.js", "advanced-mint.js", "nft-management.js"]) {
    assert.equal(existsSync(join(ROOT, "apps/nfttool/runtime", file)), true)
    assert.doesNotMatch(source(`apps/nfttool/runtime/${file}`), /611nft|611nft-logo-ui|WorkspaceModule/)
  }
  assert.match(routes, /path: ['"]\/mint['"][^\n]+component:\s*['"]\.\/Tool\/Iframe['"]/)
  assert.match(routes, /path: ['"]\/documentaryList['"][^\n]+component:\s*['"]\.\/Tool\/Iframe['"]/)
  assert.match(routes, /path: ['"]\/highHexMint\/opensea['"][^\n]+component:\s*['"]\.\/Tool\/Iframe['"]/)
  assert.equal(existsSync(join(ROOT, "apps/nfttool/src/pages/OpenSea.tsx")), false)
})

test("wallet and advanced Mint routes keep the original NFT TOOL iframe boundary", () => {
  const routes = source("apps/nfttool/config/routes.ts")
  const iframe = source("apps/nfttool/src/pages/Tool/Iframe/index.tsx")
  const workspace = source("apps/nfttool/src/pages/WorkspaceModule/index.tsx")

  const walletPaths = [
    "/walletManager/walletManager",
    "/walletManager/ethDisperse",
    "/walletManager/ethCollection",
    "/walletManager/moreToMore",
    "/walletManager/despositToExchange",
  ]
  const nfttoolPaths = [
    "/mint",
    "/documentaryList",
    "/highHexMint/signTask",
    "/highHexMint/highHexMint",
    "/highHexMint/opensea",
    "/batchSell/batchSell",
    "/batchSell/collectionNFT",
    "/batchSell/batchApprove",
  ]
  for (const path of walletPaths) {
    const escaped = path.replaceAll("/", "\\/")
    assert.match(routes, new RegExp(`path: ['"]${escaped}['"][\\s\\S]{0,180}component: ['"]\\.\\/Tool\\/Iframe['"]`))
  }
  for (const path of nfttoolPaths) {
    const escaped = path.replaceAll("/", "\\/")
    assert.match(routes, new RegExp(`path: ['"]${escaped}['"][\\s\\S]{0,180}component: ['"]\\.\\/Tool\\/Iframe['"]`))
  }
  assert.equal(existsSync(join(ROOT, "apps/nfttool/src/pages/NfttoolBusiness")), false)
  assert.equal(existsSync(join(ROOT, "apps/nfttool/src/pages/WalletWorkspace")), false)
  assert.equal(existsSync(join(ROOT, "apps/nfttool/src/pages/OpenSea.tsx")), false)
  assert.match(iframe, /import \{ iframeDomain \} from ['"]@\/utils\/index['"]/)
  assert.match(iframe, /thekkkey=12/)
  assert.match(iframe, /<iframe/)
  assert.doesNotMatch(iframe, /\/api\/nfttool\/runtime|RuntimeState|fetch\(/)
  assert.match(workspace, /import WorkspaceApp from ['"]\.\.\/\.\.\/workspace\/App\.jsx['"]/)
  assert.match(workspace, /<WorkspaceApp moduleName=\{moduleName\} theme=\{workspaceTheme\}/)
  assert.doesNotMatch(workspace, /<iframe|nfttool\/runtime|https?:\/\//)
  assert.doesNotMatch(workspace, /walletManager|highHexMint|signTask|batchApproval/)
  assert.doesNotMatch(workspace, /['"]\/mint['"]|['"]\/documentaryList['"]/)
  const runtime = source("apps/nfttool/runtime/app.js")
  assert.match(runtime, /const renderPage = pageRenderers\[routeName\] \|\| \(\(\) =>/)
  assert.doesNotMatch(runtime, /pageRenderers\[routeName\]\s*\|\|\s*renderWalletManager/)
  assert.match(source("apps/nfttool/runtime/nft-management.js"), /\/api\/nft-listings\/preview/)
  assert.match(source("apps/nfttool/runtime/nft-management.js"), /\/api\/plan\/nft-approval/)
  assert.match(source("server/index.js"), /app\.post\("\/api\/nft-listings\/submit"/)
  assert.match(source("server/index.js"), /app\.post\("\/api\/plan\/nft-approval"/)
  assert.doesNotMatch(source("apps/nfttool/src/workspace/App.jsx"), /ExchangeDepositView|\/api\/(?:plan|tasks)\/exchange-deposit/)
  assert.doesNotMatch(source("server/index.js"), /buildExchangeDepositPlan|\/api\/(?:plan|tasks)\/exchange-deposit/)
  assert.match(workspace, /['"]\/walletAlert['"]:\s*['"]alerts['"]/)
  assert.match(source("apps/nfttool/src/workspace/App.jsx"), /initialView=\{moduleMode === "alerts" \? "alerts" : "live"\}/)
  assert.match(routes, /\/walletManager\/disperse['"], redirect: ['"]\/walletManager\/ethDisperse/)
  assert.match(routes, /\/walletManager\/collect['"], redirect: ['"]\/walletManager\/ethCollection/)
  assert.match(routes, /\/highHexMint\/contract['"], redirect: ['"]\/highHexMint\/highHexMint/)
})

test("advanced Mint sidebar exposes only the three retained sections", () => {
  const routes = source("apps/nfttool/config/routes.ts")
  const zhMenu = source("apps/nfttool/src/locales/zh-CN/menu.ts")
  const enMenu = source("apps/nfttool/src/locales/en-US/menu.ts")
  const highHexMint = routes.match(/path: ['"]\/highHexMint['"][\s\S]*?\n  },\n  {/)[0]
  const retained = ["signTask", "highHexMint", "opensea"]
  const removed = [
    "fairMint",
    "manifold",
    "indelible",
    "bueno",
    "magiceden",
    "sound",
    "gmstudio",
    "ensRegister",
    "skyarkchronicles",
    "skyarkchroniclesCollection",
    "skyarkchroniclesDisperse",
  ]
  for (const name of retained) assert.match(highHexMint, new RegExp(`name: ['"]${name}['"]`))
  for (const name of removed) {
    assert.doesNotMatch(highHexMint, new RegExp(`name: ['"]${name}['"]`))
    assert.doesNotMatch(zhMenu, new RegExp(`menu\\.highHexMint\\.${name}`))
    assert.doesNotMatch(enMenu, new RegExp(`menu\\.highHexMint\\.${name}`))
  }
  assert.match(highHexMint, /\/highHexMint\/contract['"], redirect: ['"]\/highHexMint\/highHexMint/)
})

test("legacy root entry paths resolve to the nfttool workspace source", () => {
  for (const file of ["App.jsx", "LiveMintView.jsx", "AdvancedMintView.jsx", "WalletTableSelector.jsx", "styles.css"]) {
    assert.equal(readlinkSync(join(ROOT, "src", file)), `../apps/nfttool/src/workspace/${file}`)
  }
})

test("the iframe build deduplicates React across the nested NFT TOOL package", () => {
  const vite = source("vite.config.js")
  assert.match(vite, /dedupe:\s*\["react", "react-dom"\]/)
})

test("Umi-mounted workspace avoids BigInt exponentiation downleveling", () => {
  for (const file of ["mint-setup.js", "monitor-intelligence.js", "LiveMintView.jsx", "AdvancedMintView.jsx"]) {
    assert.doesNotMatch(source(`apps/nfttool/src/workspace/${file}`), /\d+n\s*\*\*\s*\d+n/)
  }
})
