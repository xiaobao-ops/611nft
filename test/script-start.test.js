import assert from "node:assert/strict"
import test from "node:test"
import { mintScriptStartPayload } from "../src/script-start.js"

test("dry-run script start requires no confirmation token", () => {
  assert.deepEqual(mintScriptStartPayload("dry-run"), { mode: "dry-run" })
})

test("armed script start forwards the server preview confirmation", () => {
  assert.deepEqual(
    mintScriptStartPayload("armed", {
      confirmation: { previewId: "preview-1", confirmationToken: "token-1" },
    }),
    { mode: "armed", previewId: "preview-1", confirmationToken: "token-1" },
  )
})

test("armed script start fails closed when preview confirmation is absent", () => {
  assert.throws(() => mintScriptStartPayload("armed"), /缺少确认凭据/)
})
