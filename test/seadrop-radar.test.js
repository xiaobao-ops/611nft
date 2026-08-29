import assert from "node:assert/strict"
import test from "node:test"
import { DatabaseSync } from "node:sqlite"
import {
  SEADROP_SEVEN_DAY_LOOKBACK_BLOCKS,
  createSeaDropRadar,
  migrateSeaDropRadar,
  normalizeSeaDropLog,
  resolveSeaDropLookbackBlocks,
} from "../server/seadrop-radar.js"

const nft = "0x1111111111111111111111111111111111111111"
const drop = "0x00005ea00ac477b1030ce78506496e8c2de24bf5"
const signer = "0x2222222222222222222222222222222222222222"

function publicLog(overrides = {}) {
  return {
    address: drop,
    eventName: "PublicDropUpdated",
    args: {
      nftContract: nft,
      publicDrop: {
        mintPrice: 10000000000000000n,
        startTime: 1786925400n,
        endTime: 1786929000n,
        maxTotalMintableByWallet: 5,
        feeBps: 250,
        restrictFeeRecipients: false,
      },
    },
    transactionHash: `0x${"aa".repeat(32)}`,
    blockNumber: 100n,
    logIndex: 1,
    ...overrides,
  }
}

function fixture() {
  const db = new DatabaseSync(":memory:")
  migrateSeaDropRadar(db)
  const radar = createSeaDropRadar({ db, now: () => Date.parse("2026-08-17T00:00:00.000Z") })
  return { db, radar }
}

test("SeaDrop public update normalizes exact price, window and wallet limit", () => {
  const normalized = normalizeSeaDropLog(1, publicLog())
  assert.equal(normalized.contract, nft)
  assert.equal(normalized.stageType, "public")
  assert.equal(normalized.priceWei, "10000000000000000")
  assert.equal(normalized.maxPerWallet, "5")
  assert.equal(normalized.startTime, "2026-08-17T00:10:00.000Z")
  assert.equal(normalized.endTime, "2026-08-17T01:10:00.000Z")
  assert.equal(normalized.requiresCredentials, false)
})

test("SeaDrop timestamps outside the JavaScript Date range become unscheduled", () => {
  const normalized = normalizeSeaDropLog(1, publicLog({
    args: {
      ...publicLog().args,
      publicDrop: {
        ...publicLog().args.publicDrop,
        startTime: 2n ** 48n - 1n,
        endTime: 2n ** 48n - 1n,
      },
    },
  }))
  assert.equal(normalized.startTime, null)
  assert.equal(normalized.endTime, null)
})

test("seven-day radar lookback scales with each chain cadence and rejects invalid overrides", () => {
  assert.equal(SEADROP_SEVEN_DAY_LOOKBACK_BLOCKS[1], 50_400)
  assert.equal(SEADROP_SEVEN_DAY_LOOKBACK_BLOCKS[8453], 302_400)
  assert.equal(SEADROP_SEVEN_DAY_LOOKBACK_BLOCKS[42161], 2_419_200)
  assert.equal(resolveSeaDropLookbackBlocks(8453, { 8453: "123456" }), 123_456)
  assert.equal(resolveSeaDropLookbackBlocks(8453, { 8453: "-1" }), 302_400)
})

test("signed and allowlist updates preserve their credential boundary", () => {
  const signed = normalizeSeaDropLog(1, {
    address: drop,
    eventName: "SignedMintValidationParamsUpdated",
    args: {
      nftContract: nft,
      signer,
      signedMintValidationParams: {
        minMintPrice: 20000000000000000n,
        maxMaxTotalMintableByWallet: 3,
        minStartTime: 1786926000n,
        maxEndTime: 1786932600n,
        maxMaxTokenSupplyForStage: 1000,
        minFeeBps: 0,
        maxFeeBps: 500,
      },
    },
    transactionHash: `0x${"bb".repeat(32)}`,
    blockNumber: 101n,
    logIndex: 2,
  })
  assert.equal(signed.stageType, "signed")
  assert.equal(signed.signer, signer)
  assert.equal(signed.requiresCredentials, true)
  assert.equal(signed.maxPerWallet, "3")

  const allowlist = normalizeSeaDropLog(1, {
    address: drop,
    eventName: "AllowListUpdated",
    args: { nftContract: nft, newMerkleRoot: `0x${"cc".repeat(32)}`, allowListURI: "ipfs://list" },
    transactionHash: `0x${"dd".repeat(32)}`,
    blockNumber: 102n,
    logIndex: 3,
  })
  assert.equal(allowlist.stageType, "allowlist")
  assert.equal(allowlist.requiresCredentials, true)
  assert.equal(allowlist.startTime, null)
})

test("radar ingestion is idempotent and removed logs retract a stage", () => {
  const { radar } = fixture()
  assert.equal(radar.ingest(1, [publicLog()]).changed, 1)
  assert.equal(radar.ingest(1, [publicLog()]).changed, 0)
  assert.equal(radar.list({ chainId: 1, includeUnscheduled: true }).drops.length, 1)
  assert.equal(radar.ingest(1, [publicLog({ removed: true })]).removed, 1)
  assert.equal(radar.list({ chainId: 1, includeUnscheduled: true }).drops.length, 0)
})

test("radar metadata enrichment publishes only material changes", () => {
  const { radar } = fixture()
  radar.ingest(1, [publicLog()])
  const snapshots = []
  radar.subscribe((snapshot) => snapshots.push(snapshot))

  assert.equal(radar.enrich({ chainId: 1, contract: nft, name: "Real Drop", image: "/api/mint-monitor/media/logo" }), 1)
  assert.equal(snapshots.length, 1)
  assert.equal(snapshots[0].drops[0].name, "Real Drop")
  assert.equal(radar.enrich({ chainId: 1, contract: nft, name: "Real Drop", image: "/api/mint-monitor/media/logo" }), 0)
  assert.equal(radar.enrich({ chainId: 1, contract: nft }), 0)
  assert.equal(snapshots.length, 1)
})

test("radar list filters free, paid, live and public stages by real timestamps", () => {
  const { radar } = fixture()
  radar.ingest(1, [
    publicLog(),
    publicLog({
      transactionHash: `0x${"ee".repeat(32)}`,
      logIndex: 4,
      args: { ...publicLog().args, nftContract: "0x3333333333333333333333333333333333333333", publicDrop: { ...publicLog().args.publicDrop, mintPrice: 0n } },
    }),
    publicLog({
      transactionHash: `0x${"ff".repeat(32)}`,
      logIndex: 5,
      args: { ...publicLog().args, nftContract: "0x4444444444444444444444444444444444444444", publicDrop: { ...publicLog().args.publicDrop, startTime: 1786921200n, endTime: 1786928400n } },
    }),
  ])
  assert.equal(radar.list({ chainId: 1, price: "free" }).drops.length, 1)
  assert.equal(radar.list({ chainId: 1, price: "paid" }).drops.length, 2)
  assert.equal(radar.list({ chainId: 1, liveOnly: true }).drops.length, 1)
  assert.equal(radar.list({ chainId: 1, publicOnly: true }).drops.length, 3)
})

test("radar list normalizes malformed timestamps left by an older database", () => {
  const { db, radar } = fixture()
  const stage = normalizeSeaDropLog(1, publicLog())
  stage.startTime = "not-a-time"
  stage.endTime = "+999999-01-01T00:00:00.000Z"
  db.prepare(`
    INSERT INTO seadrop_drops (chain_id, contract, stage_key, payload_json, name, image, updated_at)
    VALUES (?, ?, ?, ?, '', '', ?)
  `).run(1, nft, "public", JSON.stringify(stage), "2026-08-17T00:00:00.000Z")

  const [listed] = radar.list({ chainId: 1, includeUnscheduled: true }).drops
  assert.equal(listed.startTime, null)
  assert.equal(listed.endTime, null)
})

test("radar scanner resumes from the persisted contiguous checkpoint", async () => {
  const { radar } = fixture()
  const calls = []
  const client = {
    async getBlockNumber() { return 110n },
    async getLogs(input) { calls.push(input); return [publicLog({ blockNumber: BigInt(input.toBlock) })] },
  }
  const first = await radar.scan({ chainId: 1, client, dropAddresses: [drop], fromBlock: 100n, toBlock: 105n })
  assert.equal(first.checkpoint, "105")
  const second = await radar.scan({ chainId: 1, client, dropAddresses: [drop], toBlock: 110n })
  assert.equal(second.fromBlock, "106")
  assert.equal(second.checkpoint, "110")
  assert.deepEqual(calls.map((call) => [String(call.fromBlock), String(call.toBlock)]), [["100", "105"], ["106", "110"]])
})

test("radar scanner chunks large ranges and checkpoints only completed chunks", async () => {
  const { radar } = fixture()
  const calls = []
  let failAt = "103"
  const client = {
    async getBlockNumber() { return 108n },
    async getLogs(input) {
      calls.push([String(input.fromBlock), String(input.toBlock)])
      if (String(input.fromBlock) === failAt) throw new Error("range limited")
      return []
    },
  }

  await assert.rejects(radar.scan({
    chainId: 1,
    client,
    dropAddresses: [drop],
    fromBlock: 100n,
    toBlock: 108n,
    maxBlocksPerRequest: 3,
  }), /range limited/)
  assert.equal(radar.checkpoint(1), "102")

  failAt = ""
  const resumed = await radar.scan({
    chainId: 1,
    client,
    dropAddresses: [drop],
    toBlock: 108n,
    maxBlocksPerRequest: 3,
  })
  assert.equal(resumed.fromBlock, "103")
  assert.equal(resumed.checkpoint, "108")
  assert.deepEqual(calls, [["100", "102"], ["103", "105"], ["103", "105"], ["106", "108"]])
})
