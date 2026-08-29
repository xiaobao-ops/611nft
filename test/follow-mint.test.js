import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { ARM_PHRASE, createFollowMintService, evaluateFollowMintEvent } from "../server/follow-mint.js"

const sourceContract = "0x1111111111111111111111111111111111111111"
const walletAddress = "0x2222222222222222222222222222222222222222"

function waitFor(check, timeoutMs = 500) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (check()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error("condition timed out"))
      setTimeout(poll, 5)
    }
    poll()
  })
}

function serviceFixture({ getCollectionFlag = () => null } = {}) {
  const db = new DatabaseSync(":memory:")
  const ensured = []
  const listeners = new Map()
  const previewBodies = []
  const sentJobs = []
  const alerts = []
  let id = 0
  const service = createFollowMintService({
    db,
    chainIds: [1],
    monitor: {
      ensure: (chainId) => ensured.push(chainId),
      subscribe: (chainId, listener) => {
        listeners.set(chainId, listener)
        return () => listeners.delete(chainId)
      },
    },
    previewMint: async (body) => {
      previewBodies.push(body)
      return { id: `job-${previewBodies.length}`, status: "previewed", confirmationToken: "secret", wallets: [] }
    },
    sendMint: async (job) => {
      sentJobs.push(job.id)
      job.status = "completed"
    },
    publicJob: (job) => ({ id: job.id, status: job.status }),
    validateWalletIds: (walletIds) => assert.deepEqual(walletIds, ["default"]),
    getCollectionFlag,
    resolveRpcProfile: (profileId, chainId, profileRef = "") => ({
      id: profileId || "main",
      chainId,
      profileRef: profileId === "custom" ? profileRef || "custom_ref" : "",
    }),
    emitAlert: async (alert) => { alerts.push(alert) },
    createId: () => `rule-${++id}`,
  })
  service.start()
  return { db, service, ensured, listeners, previewBodies, sentJobs, alerts }
}

test("follow Mint persists rules and manual preview never broadcasts", async () => {
  const fixture = serviceFixture()
  const rule = fixture.service.create({
    name: "Public mint",
    chainId: 1,
    sourceContract,
    walletIds: ["default"],
    quantity: 2,
    tokenId: 0,
    concurrency: 3,
    minTriggerQuantity: 1,
    cooldownSeconds: 30,
    enabled: true,
    oneShot: true,
  })

  assert.equal(rule.mode, "preview")
  assert.deepEqual(fixture.ensured, [1])
  const run = await fixture.service.preview(rule.id)
  assert.equal(run.status, "previewed")
  assert.deepEqual(fixture.sentJobs, [])
  assert.equal(fixture.service.ruleById(rule.id).enabled, true)
  assert.equal(fixture.previewBodies[0].contractAddress, sourceContract)
  assert.equal(fixture.previewBodies[0].quantity, 2)
})

test("follow Mint freezes the selected custom profile reference through preview", async () => {
  const fixture = serviceFixture()
  const rule = fixture.service.create({
    name: "Custom RPC mint",
    chainId: 1,
    sourceContract,
    walletIds: ["default"],
    rpcProfileId: "custom",
    rpcProfileRef: "custom_ref",
    minTriggerQuantity: 1,
    cooldownSeconds: 30,
  })

  assert.equal(rule.rpcProfileId, "custom")
  assert.equal(fixture.db.prepare("PRAGMA table_info(follow_mint_rules)").all().some((column) => column.name === "rpc_profile_ref"), false)
  const run = await fixture.service.preview(rule.id)
  assert.equal(run.status, "previewed")
  assert.equal(fixture.previewBodies[0].rpcProfileId, "custom")
  assert.equal(fixture.previewBodies[0].rpcProfileRef, "custom_ref")
})

test("follow Mint requires an explicit arm phrase and broadcasts one matching event", async () => {
  const fixture = serviceFixture()
  const rule = fixture.service.create({
    name: "Armed mint",
    chainId: 1,
    sourceContract,
    walletIds: ["default"],
    quantity: 1,
    tokenId: 0,
    concurrency: 1,
    minTriggerQuantity: 2,
    cooldownSeconds: 5,
    enabled: true,
    oneShot: true,
  })

  assert.throws(() => fixture.service.arm(rule.id, "ARM"), /自动铸造/)
  const armed = fixture.service.arm(rule.id, ARM_PHRASE)
  assert.equal(armed.mode, "armed")

  fixture.listeners.get(1)({
    id: "0xevent:contract",
    type: "mint",
    chainId: 1,
    address: sourceContract,
    quantity: "2",
    mintValueWei: "0",
    confirmed: true,
  })
  await waitFor(() => fixture.sentJobs.length === 1)

  assert.deepEqual(fixture.sentJobs, ["job-1"])
  assert.equal(fixture.service.ruleById(rule.id).enabled, false)
  assert.equal(fixture.service.list().runs[0].status, "completed")
  fixture.service.stop()
})

test("follow Mint records a blocked keyword decision without previewing or broadcasting", async () => {
  const fixture = serviceFixture()
  const rule = fixture.service.create({
    name: "Filtered mint",
    chainId: 1,
    sourceContract,
    walletIds: ["default"],
    quantity: 1,
    minTriggerQuantity: 1,
    cooldownSeconds: 5,
    blockedKeywords: ["scam"],
    enabled: true,
  })
  fixture.listeners.get(1)({
    id: "0xfiltered:contract",
    type: "mint",
    chainId: 1,
    address: sourceContract,
    name: "SCAM Collection",
    quantity: "1",
    mintValueWei: "0",
    confirmed: true,
  })
  await waitFor(() => fixture.service.list().runs.length === 1)

  const [run] = fixture.service.list().runs
  assert.equal(run.ruleId, rule.id)
  assert.equal(run.status, "skipped")
  assert.equal(run.error, "blocked_keyword:scam")
  assert.deepEqual(fixture.previewBodies, [])
  assert.deepEqual(fixture.sentJobs, [])
  fixture.service.stop()
})

test("follow Mint notify-only rules require no wallet and skip preview and broadcast", async () => {
  const fixture = serviceFixture()
  const rule = fixture.service.create({
    name: "Only notify",
    chainId: 1,
    sourceContract,
    walletIds: [],
    notifyOnly: true,
    minTriggerQuantity: 1,
    cooldownSeconds: 5,
    enabled: true,
    oneShot: true,
  })
  assert.equal(rule.notifyOnly, true)
  fixture.listeners.get(1)({
    id: "notify-event",
    type: "mint",
    chainId: 1,
    address: sourceContract,
    name: "Notify Collection",
    quantity: "3",
    mintValueWei: "0",
    confirmed: true,
  })
  await waitFor(() => fixture.alerts.length === 1)
  assert.deepEqual(fixture.previewBodies, [])
  assert.deepEqual(fixture.sentJobs, [])
  assert.equal(fixture.service.list().runs[0].status, "notified")
  assert.equal(fixture.service.ruleById(rule.id).enabled, false)
  fixture.service.stop()
})

test("personal collection flags block follow Mint before preview", async () => {
  const fixture = serviceFixture({ getCollectionFlag: () => ({ flag: "scam", note: "local" }) })
  fixture.service.create({
    name: "Blocked by flag",
    chainId: 1,
    sourceContract,
    walletIds: ["default"],
    minTriggerQuantity: 1,
    cooldownSeconds: 5,
    enabled: true,
  })
  fixture.listeners.get(1)({
    id: "flagged-event",
    type: "mint",
    chainId: 1,
    address: sourceContract,
    quantity: "1",
    mintValueWei: "0",
    confirmed: true,
  })
  await waitFor(() => fixture.service.list().runs.length === 1)
  assert.equal(fixture.service.list().runs[0].error, "collection_flagged:scam")
  assert.deepEqual(fixture.previewBodies, [])
  fixture.service.stop()
})

test("follow Mint evaluates value, Gas, calldata words, quantity, supply, standard and platform filters", () => {
  const rule = {
    confirmedOnly: true,
    timeStart: "",
    timeEnd: "",
    blockedKeywords: [],
    eventValueMode: "max",
    maxEventValueEth: "0.1",
    maxGasLimit: 200000,
    parameterCount: 3,
    minTriggerQuantity: 1,
    maxTriggerQuantity: 5,
    minMaxSupply: "1000",
    excludeErc1155: true,
    excludedPlatforms: ["zora"],
  }
  const event = {
    confirmed: true,
    mintValueWei: "50000000000000000",
    gasLimit: "180000",
    parameterCount: 3,
    quantity: "2",
    maxSupply: "5000",
    tokenStandard: "ERC721",
    platform: "",
  }
  assert.deepEqual(evaluateFollowMintEvent(rule, event), { match: true, reason: "matched" })
  assert.equal(evaluateFollowMintEvent(rule, { ...event, gasLimit: "220000" }).reason, "gas_limit_above_limit")
  assert.equal(evaluateFollowMintEvent(rule, { ...event, parameterCount: 4 }).reason, "parameter_count_mismatch")
  assert.equal(evaluateFollowMintEvent(rule, { ...event, quantity: "6" }).reason, "mint_quantity_above_limit")
  assert.equal(evaluateFollowMintEvent(rule, { ...event, maxSupply: "999" }).reason, "max_supply_below_limit")
  assert.equal(evaluateFollowMintEvent(rule, { ...event, tokenStandard: "ERC1155" }).reason, "erc1155_excluded")
  assert.equal(evaluateFollowMintEvent(rule, { ...event, platform: "zora" }).reason, "platform_excluded:zora")
  assert.equal(evaluateFollowMintEvent(rule, { ...event, maxSupply: null }).match, true)
})
