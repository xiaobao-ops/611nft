import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const source = (relativePath) => readFileSync(join(ROOT, relativePath), "utf8")

test("NFT TOOL shell exposes modules without an account session", () => {
  const app = source("apps/nfttool/src/app.tsx")
  const iframe = source("apps/nfttool/src/pages/Tool/Iframe/index.tsx")
  const workspace = source("apps/nfttool/src/pages/WorkspaceModule/index.tsx")
  const welcome = source("apps/nfttool/src/pages/Welcome.tsx")
  const requests = source("apps/nfttool/src/requestErrorConfig.ts")
  const access = source("apps/nfttool/src/access.ts")
  const managerWrapper = source("apps/nfttool/src/wrappers/managerAccount.tsx")

  assert.equal(existsSync(join(ROOT, "apps/nfttool/src/pages/Header.tsx")), false)
  assert.equal(existsSync(join(ROOT, "apps/nfttool/src/pages/LocalWorkspace")), false)
  assert.equal(existsSync(join(ROOT, "apps/nfttool/src/pages/Tool/Iframe/components")), false)
  assert.equal(existsSync(join(ROOT, "server/module-runtime.js")), false)
  assert.doesNotMatch(app, /loadUserInfo|user\/userInfo|SwitchAlert/)
  assert.doesNotMatch(app, /ConnectKit|Connect Wallet|Web3/)
  assert.doesNotMatch(workspace, /currentUser|token|<Header|nfttool\/runtime|<iframe/)
  assert.match(workspace, /<WorkspaceApp/)
  assert.doesNotMatch(iframe, /currentUser|token|<Header|nfttool\/runtime/)
  assert.match(iframe, /iframeDomain/)
  assert.equal(existsSync(join(ROOT, "apps/nfttool/src/pages/OpenSea.tsx")), false)
  assert.doesNotMatch(welcome, /开通会员|签名登录|功能受限|未激活|Access Pass/)
  assert.doesNotMatch(requests, /localStorage\.getItem\(['"]userInfo|headers[^}]*token/s)
  assert.match(access, /canAdmin:\s*true/)
  assert.doesNotMatch(managerWrapper, /Navigate|currentUser|isAdmin/)
})

test("NFT TOOL exposes wallet and advanced Mint routes through its iframe runtime", () => {
  const routes = source("apps/nfttool/config/routes.ts")
  const iframe = source("apps/nfttool/src/pages/Tool/Iframe/index.tsx")
  const server = source("server/index.js")

  for (const path of [
    "/walletManager",
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
    "/batchSell",
    "/batchSell/batchSell",
    "/batchSell/collectionNFT",
    "/batchSell/batchApprove",
    "/walletAlert",
    "/scanWallet",
    "/balanceSearch",
    "/transactions",
  ]) {
    assert.match(routes, new RegExp(`path: ['\"]${path.replaceAll("/", "\\/")}['\"]`))
  }
  for (const removed of [
    "/swap",
    "/batchSwap",
    "/uniswap",
    "/syncswap",
    "/blurBid",
    "/zkSync",
    "/airdropScan",
    "/ethscriptions",
    "/aptosMint",
    "/aptosDisperse",
    "/aptosCollection",
    "/walletManager/withdrawFromExchange",
    "/highHexMint/6529",
    "/highHexMint/fairMint",
    "/highHexMint/manifold",
    "/highHexMint/indelible",
    "/highHexMint/bueno",
    "/highHexMint/magiceden",
    "/highHexMint/sound",
    "/highHexMint/gmstudio",
    "/highHexMint/ensRegister",
    "/highHexMint/skyarkchronicles",
    "/highHexMint/skyarkchroniclesCollection",
    "/highHexMint/skyarkchroniclesDisperse",
  ]) {
    assert.doesNotMatch(routes, new RegExp(`path: ['\"]${removed.replaceAll("/", "\\/")}['\"]`))
  }
  for (const hidden of ["/scanWallet", "/balanceSearch"]) {
    const escaped = hidden.replaceAll("/", "\\/")
    assert.match(routes, new RegExp(`path: ['\"]${escaped}['\"][^\\n]+hideInMenu:\\s*true`))
  }
  assert.match(routes, /component:\s*['"]\.\/Tool\/Iframe['"]/)
  assert.doesNotMatch(routes, /WalletWorkspace|NfttoolBusiness|component:\s*['"]\.\/LocalWorkspace['"]/)
  assert.equal(existsSync(join(ROOT, "apps/nfttool/src/pages/WalletWorkspace")), false)
  assert.match(iframe, /iframeDomain/)
  assert.match(iframe, /thekkkey=12/)
  assert.doesNotMatch(iframe, /fetch\(|\/api\//)
  assert.match(server, /app\.use\("\/nfttool-runtime", express\.static\(NFTTOOL_RUNTIME_ROOT\)\)/)
  assert.doesNotMatch(server, /app\.use\("\/opensea"/)
  assert.match(server, /res\.redirect\("\/tool\/walletManager\/walletManager"\)/)
  const runtime = source("apps/nfttool/runtime/app.js")
  for (const renderer of ["renderMintMonitor", "renderFollowMint", "renderAdvancedMint", "renderLaunchpadMint", "renderBatchSell", "renderNftCollection", "renderBatchApprove"]) {
    assert.match(runtime, new RegExp(renderer))
  }
  assert.doesNotMatch(runtime, /WorkspaceModule|611nft|\|\|\s*renderWalletManager/)
})

test("Live Mint keeps transaction bot controls inside advanced Mint", () => {
  const liveMint = source("src/LiveMintView.jsx")
  const advancedMint = source("src/AdvancedMintView.jsx")

  for (const advancedOnly of ["ABI 方法", "Calldata", "免费铸造", "自动 Gas 上限", "加速", "取消", "任务日志"]) {
    assert.doesNotMatch(liveMint, new RegExp(advancedOnly))
    assert.match(advancedMint, new RegExp(advancedOnly))
  }
  for (const advancedField of ["地址参数占位符", "最高费", "优先费", "预览时自动读取"]) {
    assert.match(advancedMint, new RegExp(advancedField))
  }
  assert.match(advancedMint, /disabled=\{form\.autoFee \|\| !form\.eip1559\}/)
  for (const liveField of ["当前区块", "链上最优 Gas", "合约", "创建", "供应量", "待处理", "屏蔽设置"]) {
    assert.match(liveMint, new RegExp(liveField, "i"))
  }
  assert.match(liveMint, /panelMode === "advanced"/)
  assert.match(liveMint, /<AdvancedMintView/)
  assert.doesNotMatch(liveMint, /workspace:\s*["']advanced/)
  assert.match(liveMint, /event\.mintTarget \|\| event\.address/)
  assert.match(liveMint, /项目标志/)
  assert.doesNotMatch(liveMint, /--avatar-hue|slice\(0, 2\)\.toUpperCase/)
})
