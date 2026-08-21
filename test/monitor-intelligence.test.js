import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import {
  DEFAULT_ALERT_PREFERENCES,
  buildRadarAdvancedMintSeed,
  collectionsWithFlags,
  deployerRiskProfile,
  filterRadarDrops,
  formatRadarCountdown,
  formatRadarDateTime,
  mergeTrendingSnapshots,
  normalizeTrendingSnapshot,
  radarDropTiming,
  readAlertPreferences,
  rememberAlertId,
  writeAlertPreferences,
} from "../src/monitor-intelligence.js"

const addressA = "0x1111111111111111111111111111111111111111"
const addressB = "0x2222222222222222222222222222222222222222"

test("trending endpoint and multiplexed SSE snapshots share one window map", () => {
  const endpoint = normalizeTrendingSnapshot({
    chainId: 1,
    window: 60,
    snapshotId: "one",
    generatedAt: "2026-08-17T00:00:00.000Z",
    collections: [{ rank: 1, address: addressA, mintCount: 12 }],
  })
  assert.deepEqual(Object.keys(endpoint.windows), ["60"])
  assert.equal(endpoint.windows["60"][0].mintCount, 12)

  const merged = mergeTrendingSnapshots(endpoint, {
    chainId: 1,
    snapshotId: "all",
    windows: {
      60: [{ rank: 1, address: addressB, mintCount: 20 }],
      300: [{ rank: 1, address: addressA, mintCount: 32 }],
    },
  })
  assert.equal(merged.snapshotId, "all")
  assert.equal(merged.windows["60"][0].address, addressB)
  assert.equal(merged.windows["300"][0].mintCount, 32)
})

test("personal flags match case-insensitively and can be revealed without losing metadata", () => {
  const rows = [{ address: addressA.toUpperCase(), name: "A" }, { address: addressB, name: "B" }]
  const flags = [{ address: addressA, flag: "scam", note: "人工复核" }]
  assert.deepEqual(collectionsWithFlags(rows, flags).map((row) => row.name), ["B"])
  const revealed = collectionsWithFlags(rows, flags, { showFlagged: true })
  assert.equal(revealed[0].personalFlag.note, "人工复核")
  assert.equal(revealed[1].personalFlag, null)
})

test("deployer risk profile accepts snapshot and flattened field shapes", () => {
  const nested = deployerRiskProfile({
    collection_snapshot: {
      deployer_profile: {
        address: addressA,
        walletAgeDays: 2,
        nftProjectCount: 8,
        deployedContractCount: 11,
        risk: { risky: true, reasons: ["wallet_younger_than_7d"] },
      },
    },
  })
  assert.deepEqual(nested, {
    address: addressA,
    walletAgeDays: 2,
    nftProjectCount: 8,
    deployedContractCount: 11,
    risky: true,
    reasons: ["wallet_younger_than_7d"],
  })
  assert.equal(deployerRiskProfile({ deployerProfile: { address: addressB, walletAgeDays: 30 } }).risky, false)
})

test("radar filters use real stage, price and wall-clock boundaries", () => {
  const now = Date.parse("2026-08-17T00:00:00.000Z")
  const drops = [
    { id: "live", contract: addressA, name: "Live", stageType: "public", priceWei: "0", startTime: "2026-08-16T23:59:00.000Z", endTime: "2026-08-17T00:10:00.000Z" },
    { id: "paid", contract: addressB, name: "Paid", stageType: "signed", priceWei: "100", startTime: "2026-08-17T00:01:05.000Z", endTime: "2026-08-17T01:00:00.000Z", requiresCredentials: true },
    { id: "ended", contract: addressB, name: "Ended", stageType: "public", priceWei: "0", startTime: "2026-08-16T22:00:00.000Z", endTime: "2026-08-16T23:00:00.000Z" },
  ]
  assert.deepEqual(filterRadarDrops(drops, { price: "free", publicOnly: true }, now).map((drop) => drop.id), ["live", "ended"])
  assert.deepEqual(filterRadarDrops(drops, { liveOnly: true }, now).map((drop) => drop.id), ["live"])
  assert.deepEqual(filterRadarDrops(drops, { query: addressB.slice(0, 12), price: "paid" }, now).map((drop) => drop.id), ["paid"])
  assert.equal(radarDropTiming(drops[0], now).state, "live")
  assert.equal(radarDropTiming(drops[1], now).state, "upcoming")
  assert.equal(formatRadarCountdown(65_000), "1分05秒")
  assert.equal(formatRadarDateTime("not-a-time"), "尚未公布")
})

test("radar scheduling imports only known SeaDrop inputs into Preview-first execution", () => {
  const dropAddress = "0x3333333333333333333333333333333333333333"
  const startTime = "2026-08-17T01:02:03.000Z"
  const publicSeed = buildRadarAdvancedMintSeed({
    id: "public",
    contract: addressA,
    dropAddress,
    stageType: "public",
    priceWei: "12500000000000000",
    startTime,
  })
  assert.equal(publicSeed.contractAddress, dropAddress)
  assert.match(publicSeed.methodSignature, /^mintPublic\(/)
  assert.deepEqual(publicSeed.parameters, [addressA, "", "{wallet}", "1"])
  assert.equal(publicSeed.valueEth, "0.0125")
  assert.equal(Date.parse(publicSeed.scheduleAt), Date.parse(startTime))
  assert.match(publicSeed.notice, /feeRecipient/)

  const signedSeed = buildRadarAdvancedMintSeed({
    id: "signed",
    contract: addressB,
    dropAddress,
    stageType: "signed",
    priceWei: null,
    startTime,
    requiresCredentials: true,
  })
  assert.equal(signedSeed.mode, "hex")
  assert.equal(signedSeed.calldata, "0x")
  assert.equal(signedSeed.valueEth, "")
  assert.match(signedSeed.notice, /完整 calldata/)
})

test("alert preferences survive storage failures and alert ids are bounded and deduplicated", () => {
  const values = new Map()
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }
  assert.deepEqual(readAlertPreferences(storage), DEFAULT_ALERT_PREFERENCES)
  writeAlertPreferences(storage, { sound: false, desktop: true })
  assert.deepEqual(readAlertPreferences(storage), { sound: false, desktop: true })

  let memory = rememberAlertId([], "alert-1", 2)
  assert.equal(memory.duplicate, false)
  memory = rememberAlertId(memory.ids, "alert-1", 2)
  assert.equal(memory.duplicate, true)
  memory = rememberAlertId(memory.ids, "alert-2", 2)
  memory = rememberAlertId(memory.ids, "alert-3", 2)
  assert.deepEqual(memory.ids, ["alert-2", "alert-3"])
})

test("the dashboard wires bootstrap and intelligence events without changing stream dependencies", async () => {
  const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8")
  const live = await readFile(new URL("../src/LiveMintView.jsx", import.meta.url), "utf8")
  const follow = await readFile(new URL("../src/FollowMintView.jsx", import.meta.url), "utf8")
  assert.match(app, /\/api\/bootstrap\?chainId=/)
  assert.match(app, /trending_snapshot/)
  assert.match(app, /seadrop_radar/)
  assert.match(app, /monitor_alert/)
  assert.match(app, /}, \[tab, chainId\]\)/)
  assert.match(live, />趋势</)
  assert.match(live, />即将开售</)
  assert.match(live, />报警</)
  assert.match(live, /onToggleFlag/)
  assert.match(follow, /notifyOnly: false/)
  assert.match(follow, /rule\.notifyOnly/)
})
