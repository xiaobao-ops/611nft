import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const source = (file) => readFileSync(join(ROOT, file), "utf8")

test("wallet routes remain owned by the NFT TOOL iframe runtime", () => {
  const routes = source("apps/nfttool/config/routes.ts")
  const runtime = source("apps/nfttool/runtime/app.js")
  for (const name of ["walletManager", "ethDisperse", "ethCollection", "moreToMore", "despositToExchange"]) {
    assert.match(routes, new RegExp(`name: ['"]${name}['"][\\s\\S]{0,80}component: ['"]\\.\\/Tool\\/Iframe['"]`))
    assert.match(runtime, new RegExp(name))
  }
  const app = source("apps/nfttool/src/workspace/App.jsx")
  const server = source("server/index.js")
  assert.equal(existsSync(join(ROOT, "apps/nfttool/src/pages/WalletWorkspace")), false)
  for (const file of ["core.js", "wallet-manager.js", "transfer-pages.js", "styles.css"]) {
    assert.equal(existsSync(join(ROOT, "apps/nfttool/runtime", file)), true)
  }
  assert.doesNotMatch(app, /ExchangeDepositView|\/api\/(?:plan|tasks)\/exchange-deposit/)
  assert.doesNotMatch(server, /\/api\/(?:plan|tasks)\/exchange-deposit|buildExchangeDepositPlan/)
  assert.doesNotMatch(runtime, /WorkspaceApp|WalletWorkspace|611nft/)
})

test("advanced Mint and OpenSea routes are owned exclusively by NFT TOOL", () => {
  const routes = source("apps/nfttool/config/routes.ts")
  const workspace = source("apps/nfttool/src/pages/WorkspaceModule/index.tsx")
  for (const name of ["signTask", "highHexMint", "opensea"]) {
    assert.match(routes, new RegExp(`name: ['"]${name}['"][\\s\\S]{0,80}component: ['"]\\.\\/Tool\\/Iframe['"]`))
  }
  for (const name of ["fairMint", "manifold", "indelible", "bueno", "magiceden", "sound", "gmstudio", "ensRegister", "skyarkchronicles", "skyarkchroniclesCollection", "skyarkchroniclesDisperse"]) {
    assert.doesNotMatch(routes, new RegExp(`path: ['"]\\/highHexMint\\/${name}['"]`))
  }
  assert.equal(existsSync(join(ROOT, "apps/nfttool/src/pages/OpenSea.tsx")), false)
  assert.doesNotMatch(routes, /\.\/OpenSea/)
  assert.doesNotMatch(routes, /NfttoolBusiness\/AdvancedMint/)
  assert.doesNotMatch(workspace, /highHexMint|signTask|approval|contractCall/)
})

test("NFT TOOL iframe preserves the original module URL protocol", () => {
  const iframe = source("apps/nfttool/src/pages/Tool/Iframe/index.tsx")
  const constants = source("apps/nfttool/src/utils/module/contans.ts")
  const proxy = source("apps/nfttool/config/proxy.ts")
  const server = source("server/index.js")
  assert.match(iframe, /iframeDomain/)
  assert.match(iframe, /thekkkey=12/)
  assert.match(iframe, /setTimeout\(\(\) => setLoading\(false\), 2000\)/)
  assert.match(iframe, /`\$\{iframeDomain\}\/\$\{moduleName\}\?\$\{randomStr\}`/)
  assert.match(iframe, /`\$\{iframeDomain\}\/\$\{moduleName\}\/\$\{chainId\}\/\$\{address\}\?\$\{randomStr\}`/)
  assert.doesNotMatch(iframe, /\/api\/wallets|\/api\/token-holdings|\/api\/advanced-mint|nfttool\/runtime/)
  assert.match(constants, /iframeDomain = ['"]\/nfttool-runtime['"]/)
  assert.match(proxy, /['"]\/nfttool-runtime\/['"]/)
  assert.match(server, /app\.use\(['"]\/nfttool-runtime['"], express\.static\(NFTTOOL_RUNTIME_ROOT\)\)/)
  assert.doesNotMatch(proxy, /['"]\/opensea\/['"]/)
  assert.doesNotMatch(server, /app\.use\(['"]\/opensea['"]/)
})
