import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const source = (file) => readFileSync(join(ROOT, file), "utf8")

test("workspace selectors use the shared group model and expose partial counts", () => {
  const selector = source("apps/nfttool/src/workspace/WalletTableSelector.jsx")
  assert.match(selector, /walletGroupSelection/)
  assert.match(selector, /group\.key/)
  assert.match(selector, /group\.label/)
  assert.match(selector, /data-selection=\{complete \? "complete" : partial \? "partial" : "empty"\}/)
  assert.match(selector, /\{selectedCount\}\/\{total\}/)
})

test("Live Mint reuses WalletGroupQuickSelect including ungrouped wallets", () => {
  const liveMint = source("apps/nfttool/src/workspace/LiveMintView.jsx")
  assert.match(liveMint, /import \{ WalletGroupQuickSelect \} from "\.\/WalletTableSelector\.jsx"/)
  assert.match(liveMint, /<WalletGroupQuickSelect wallets=\{wallets\} selectedIds=\{selectedIds\}/)
  assert.doesNotMatch(liveMint, /wallet\.group === group/)
  assert.match(liveMint, /wallet\.group \|\| "未分组"/)
})

test("workspace selection initializes, reconciles and persists through the shared key", () => {
  const app = source("apps/nfttool/src/workspace/App.jsx")
  assert.match(app, /new Set\(readStoredWalletIds\(\)\)/)
  assert.match(app, /reconcileWalletIds\(current, wallets\)/)
  assert.match(app, /writeStoredWalletIds\(selected\)/)
  assert.match(app, /UNGROUPED_GROUP_FILTER/)
  assert.match(app, />清除分组<\/Button>/)
})
