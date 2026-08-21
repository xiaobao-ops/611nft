import assert from "node:assert/strict"
import test from "node:test"
import {
  confirmedTaskPrompt,
  confirmedTaskRequest,
  redactSensitiveResult,
} from "../src/confirmed-task.js"

test("confirmed task execution sends only the server preview credentials", () => {
  const plan = {
    entries: [{ walletId: "wallet-1" }, { walletId: "wallet-2" }],
    confirmation: { previewId: "preview-1", confirmationToken: "secret-token" },
  }
  assert.deepEqual(confirmedTaskRequest(plan), {
    previewId: "preview-1",
    confirmationToken: "secret-token",
  })
  assert.match(confirmedTaskPrompt("执行授权任务？", plan), /提交 2 笔交易/)
})

test("missing confirmation credentials fail before a task request is sent", () => {
  assert.throws(() => confirmedTaskRequest({ confirmation: {} }), /确认凭据/)
})

test("operation output recursively redacts confirmation tokens", () => {
  assert.deepEqual(redactSensitiveResult({
    confirmation: { previewId: "preview-1", confirmationToken: "secret-token" },
    nested: [{ confirmationToken: "second-secret" }],
  }), {
    confirmation: { previewId: "preview-1", confirmationToken: "[已隐藏]" },
    nested: [{ confirmationToken: "[已隐藏]" }],
  })
})
