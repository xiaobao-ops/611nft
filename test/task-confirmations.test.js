import test from "node:test"
import assert from "node:assert/strict"
import { createTaskConfirmationStore } from "../server/task-confirmations.js"

test("task confirmation binds an immutable server-side plan and is single-use", () => {
  const store = createTaskConfirmationStore()
  const payload = { chainId: 1, entries: [{ to: "0x123", valueWei: "10" }] }
  const confirmation = store.create("one_to_many", payload)
  const consumed = store.consume("one_to_many", confirmation.previewId, confirmation.confirmationToken)
  assert.equal(consumed, payload)
  assert.throws(() => store.consume("one_to_many", confirmation.previewId, confirmation.confirmationToken), /不存在或已过期/)
})

test("task confirmation rejects wrong operation, token and expired preview", () => {
  let timestamp = 100
  const store = createTaskConfirmationStore({ ttlMs: 50, now: () => timestamp })
  const one = store.create("approve", { entries: [] })
  assert.throws(() => store.consume("contract_call", one.previewId, one.confirmationToken), /类型.*不匹配/)
  assert.throws(() => store.consume("approve", one.previewId, "wrong"), /确认凭据缺失或无效/)
  timestamp = 151
  assert.throws(() => store.consume("approve", one.previewId, one.confirmationToken), /不存在或已过期/)
})
