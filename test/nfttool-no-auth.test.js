import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { APP_ROUTES } from "../src/routes.js"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const source = (relativePath) => readFileSync(join(ROOT, relativePath), "utf8")

test("the single Vite shell has no account-session gate", () => {
  const combined = ["src/main.jsx", "src/Shell.jsx", "src/RuntimeRoute.jsx", "src/AlarmRoute.jsx", "src/TransactionsRoute.jsx"]
    .map(source)
    .join("\n")
  assert.doesNotMatch(combined, /currentUser|loadUserInfo|user\/userInfo|ConnectKit|Connect Wallet|Access Pass|Authorization|localStorage\.getItem\(['"]userInfo|headers[^}]*token/s)
  assert.match(source("src/main.jsx"), /<Shell \/>/)
})

test("only the requested 15 routes remain reachable", () => {
  const paths = new Set(APP_ROUTES.map((route) => route.path))
  assert.equal(paths.size, 15)
  for (const retained of [
    "/tool/walletManager/walletManager",
    "/tool/walletManager/ethDisperse",
    "/tool/walletManager/ethCollection",
    "/tool/walletManager/moreToMore",
    "/tool/walletManager/despositToExchange",
    "/tool/mint",
    "/tool/documentaryList",
    "/tool/highHexMint/signTask",
    "/tool/highHexMint/highHexMint",
    "/tool/highHexMint/opensea",
    "/tool/batchSell/batchSell",
    "/tool/batchSell/collectionNFT",
    "/tool/batchSell/batchApprove",
    "/tool/walletAlert",
    "/tool/transactions",
  ]) assert.equal(paths.has(retained), true, retained)

  const routes = source("src/routes.js")
  for (const removed of ["swap", "batchSwap", "uniswap", "syncswap", "blurBid", "airdrop", "ethscriptions", "aptos", "cosmos", "solana", "withdrawFromExchange", "fairMint", "manifold", "indelible", "bueno", "magiceden", "gmstudio", "ensRegister"]) {
    assert.doesNotMatch(routes, new RegExp(removed, "i"))
  }
})

test("lightweight utility routes cannot sign or broadcast wallet transactions", () => {
  const alarm = source("src/AlarmRoute.jsx")
  const transactions = source("src/TransactionsRoute.jsx")
  assert.match(alarm, /method: "POST"/)
  assert.match(alarm, /method: "PATCH"/)
  assert.match(alarm, /method: "DELETE"/)
  assert.doesNotMatch(transactions, /method:\s*["'](?:POST|PUT|PATCH|DELETE)/)
  for (const unsafe of [/\/api\/nft-mint/, /\/api\/mint-script/, /\/api\/tasks/, /\/api\/plan/, /privateKey/, /mnemonic/, /signTransaction/, /sendRawTransaction/]) {
    assert.doesNotMatch(`${alarm}\n${transactions}`, unsafe)
  }
})
