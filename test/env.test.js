import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { loadRootEnv, parseDotEnv } from "../server/env.js"

test("root env parser supports export, comments, quotes and escapes", () => {
  assert.deepEqual(parseDotEnv(`
    # comment
    export WALLET_BOARD_API_TOKEN="secret\\nvalue"
    ETH_RPC_URL=https://rpc.example # note
    EMPTY=
  `), {
    WALLET_BOARD_API_TOKEN: "secret\nvalue",
    ETH_RPC_URL: "https://rpc.example",
    EMPTY: "",
  })
})

test("root env loader preserves explicitly exported process values", () => {
  const dir = mkdtempSync(join(tmpdir(), "wallet-board-env-"))
  const envPath = join(dir, ".env")
  writeFileSync(envPath, "EXISTING=file\nFROM_FILE=loaded\n")
  const env = { EXISTING: "shell" }
  const result = loadRootEnv({ env, envPath })
  assert.equal(env.EXISTING, "shell")
  assert.equal(env.FROM_FILE, "loaded")
  assert.deepEqual(result.loaded, ["FROM_FILE"])
})
