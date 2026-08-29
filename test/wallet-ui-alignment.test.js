import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { APP_ROUTES } from "../src/routes.js"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const source = (file) => readFileSync(join(ROOT, file), "utf8")

test("wallet routes are owned by the single Vite route table and static runtime", () => {
  const runtime = source("public/nfttool-runtime/app.js")
  const walletModules = ["walletManager", "ethDisperse", "ethCollection", "moreToMore", "despositToExchange"]
  assert.deepEqual(APP_ROUTES.slice(0, walletModules.length).map((route) => route.moduleName), walletModules)
  for (const moduleName of walletModules) assert.match(runtime, new RegExp(`${moduleName}: \\(\\) => import`))
  for (const file of ["core.js", "wallet-manager.js", "transfer-pages.js", "styles.css"]) {
    assert.equal(existsSync(join(ROOT, "public/nfttool-runtime", file)), true)
  }
  assert.equal(existsSync(join(ROOT, "apps/nfttool")), false)
})

test("advanced Mint and OpenSea expose only retained modules", () => {
  const advanced = APP_ROUTES.filter((route) => route.path.includes("/highHexMint/"))
  assert.deepEqual(advanced.map((route) => route.moduleName), ["signTask", "highHexMint", "opensea"])
  const routes = source("src/routes.js")
  for (const removed of ["fairMint", "manifold", "indelible", "bueno", "magiceden", "sound", "gmstudio", "ensRegister", "skyarkchronicles"]) {
    assert.doesNotMatch(routes, new RegExp(removed, "i"))
  }
})

test("frontend and runtime are served from one Vite dist boundary", () => {
  const frame = source("src/RuntimeRoute.jsx")
  const vite = source("vite.config.js")
  const server = source("server/index.js")
  assert.match(frame, /src=\{`\/nfttool-runtime\/\$\{route\.moduleName\}`\}/)
  assert.match(vite, /nfttool-runtime-history-fallback/)
  assert.match(server, /const DIST_ROOT = join\(ROOT, "dist"\)/)
  assert.match(server, /const NFTTOOL_RUNTIME_ROOT = join\(DIST_ROOT, "nfttool-runtime"\)/)
  assert.match(server, /app\.use\(express\.static\(DIST_ROOT, \{ index: false \}\)\)/)
  assert.doesNotMatch(server, /apps["'], ["']nfttool|TOOL_DIST_ROOT|iframeDomain|thekkkey/)
})
