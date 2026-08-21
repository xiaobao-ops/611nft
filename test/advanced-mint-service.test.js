import assert from "node:assert/strict"
import test from "node:test"
import { createAdvancedMintService } from "../server/advanced-mint-service.js"

const wallet = {
  id: "alpha",
  address: "0x1212121212121212121212121212121212121212",
  source: "root-env",
}
const contractAddress = "0x3434343434343434343434343434343434343434"

function waitFor(check, timeoutMs = 500) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const poll = () => {
      const value = check()
      if (value) return resolve(value)
      if (Date.now() - started > timeoutMs) return reject(new Error("condition timed out"))
      setTimeout(poll, 5)
    }
    poll()
  })
}

function fixture(overrides = {}) {
  const sent = []
  const updates = []
  let hashIndex = 0
  let txRow = 0
  let scheduledRun = null
  const client = {
    call: async () => ({ data: "0x" }),
    estimateGas: async () => 100_000n,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 2n }),
    getGasPrice: async () => 100n,
    getTransactionCount: async () => 7,
    getBalance: async () => 10n ** 20n,
    waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 88n }),
    getTransactionReceipt: async () => { throw new Error("not found") },
    ...overrides.client,
  }
  const service = createAdvancedMintService({
    getChain: () => ({ id: 1, name: "Ethereum", nativeSymbol: "ETH" }),
    getClient: () => client,
    getWallets: () => [wallet],
    sendTransaction: async (entry) => {
      sent.push(entry)
      hashIndex += 1
      return { txHash: `0x${hashIndex.toString(16).padStart(64, "0")}` }
    },
    startTask: () => "advanced-task-1",
    finishTask: (...args) => updates.push(["task", ...args]),
    logTransaction: () => ++txRow,
    updateTransaction: (...args) => updates.push(["tx", ...args]),
    delay: async () => {},
    schedule: (run) => {
      scheduledRun = run
      return { scheduled: true }
    },
    unschedule: () => { scheduledRun = null },
    createId: () => "advanced-job-1",
  })
  return { service, sent, updates, scheduledRun: () => scheduledRun }
}

function baseInput(patch = {}) {
  return {
    chainId: 1,
    walletIds: ["alpha"],
    contractAddress,
    mode: "hex",
    calldata: "0x12345678",
    valueEth: "0",
    rounds: 2,
    frequencyMs: 50,
    preflight: true,
    prefetchNonce: true,
    ...patch,
  }
}

test("Advanced Mint fixes buffered Gas, fees and nonce before confirmed rounds", async () => {
  const { service, sent } = fixture()
  const preview = await service.preview(baseInput())

  assert.equal(preview.wallets[0].gas, "130000")
  assert.equal(preview.wallets[0].maxFeePerGas, "100")
  assert.equal(preview.wallets[0].maxPriorityFeePerGas, "2")
  assert.equal(preview.wallets[0].nonce, 7)
  assert.throws(() => service.send({ jobId: preview.id, previewId: preview.confirmation.previewId, confirmationToken: "wrong" }), /确认凭据/)

  service.send({
    jobId: preview.id,
    previewId: preview.confirmation.previewId,
    confirmationToken: preview.confirmation.confirmationToken,
  })
  const completed = await waitFor(() => {
    const job = service.get(preview.id)
    return job.status === "completed" ? job : null
  })

  assert.equal(completed.results.length, 2)
  assert.deepEqual(sent.map((entry) => entry.nonce), [7, 8])
  assert.ok(completed.results.every((result) => result.status === "confirmed"))
})

test("Advanced Mint zero-block replacement raises the original fee by at least 1.2x", async () => {
  const { service, sent } = fixture()
  await assert.rejects(() => service.preview(baseInput({ waitMode: "zero-block" })), /手动设置 Gas 上限/)
  const preview = await service.preview(baseInput({
    rounds: 1,
    waitMode: "zero-block",
    autoGas: false,
    gasLimit: "80000",
    eip1559: false,
  }))
  service.send({
    jobId: preview.id,
    previewId: preview.confirmation.previewId,
    confirmationToken: preview.confirmation.confirmationToken,
  })
  await waitFor(() => service.get(preview.id).status === "confirmation_pending")
  const accelerated = await service.accelerate(preview.id, { walletId: "alpha", multiplier: 1.2 })

  assert.equal(sent.length, 2)
  assert.equal(sent[0].gasPrice, "100")
  assert.equal(sent[1].gasPrice, "120")
  assert.equal(sent[1].nonce, 7)
  assert.equal(accelerated.results[0].status, "replaced")
  assert.equal(accelerated.replacements[0].kind, "accelerate")
})

test("Advanced Mint can stop a confirmed scheduled job before any send", async () => {
  const { service, sent, scheduledRun } = fixture()
  const preview = await service.preview(baseInput({
    rounds: 1,
    scheduleAt: new Date(Date.now() + 60_000).toISOString(),
  }))
  const scheduled = service.send({
    jobId: preview.id,
    previewId: preview.confirmation.previewId,
    confirmationToken: preview.confirmation.confirmationToken,
  })
  assert.equal(scheduled.status, "scheduled")
  assert.equal(typeof scheduledRun(), "function")

  const stopped = service.stop(preview.id)
  assert.equal(stopped.status, "stopped")
  assert.equal(scheduledRun(), null)
  assert.deepEqual(sent, [])
})
