import assert from "node:assert/strict"
import test from "node:test"
import { DatabaseSync } from "node:sqlite"
import { createDeployerProfileStore, migrateDeployerProfiles } from "../server/deployer-profile-store.js"

const deployer = "0x1111111111111111111111111111111111111111"

function fixture({ ttlMs = 86400000 } = {}) {
  const db = new DatabaseSync(":memory:")
  migrateDeployerProfiles(db)
  let now = Date.parse("2026-08-17T00:00:00.000Z")
  let calls = 0
  const store = createDeployerProfileStore({
    db,
    ttlMs,
    now: () => now,
    fetchProfile: async (chainId, address) => {
      calls += 1
      return {
        chainId,
        address,
        firstSeenAt: "2026-08-12T00:00:00.000Z",
        deployedContractCount: 7,
        nftProjectCount: 5,
      }
    },
  })
  return { store, calls: () => calls, advance(ms) { now += ms } }
}

test("deployer profile cache coalesces requests and respects TTL", async () => {
  const { store, calls, advance } = fixture({ ttlMs: 1000 })
  const [first, second] = await Promise.all([store.get(1, deployer), store.get(1, deployer)])
  assert.deepEqual(first, second)
  assert.equal(calls(), 1)
  assert.equal((await store.get(1, deployer)).nftProjectCount, 5)
  assert.equal(calls(), 1)
  advance(1001)
  await store.get(1, deployer)
  assert.equal(calls(), 2)
})

test("deployer profile cache isolates chains and recalculates risk without refetching", async () => {
  const { store, calls } = fixture()
  const risky = await store.get(1, deployer, { youngWalletDays: 7, projectCountThreshold: 5 })
  assert.equal(risky.risk.risky, true)
  assert.deepEqual(risky.risk.reasons, ["wallet_younger_than_7d", "nft_projects_at_least_5"])
  const relaxed = await store.get(1, deployer, { youngWalletDays: 3, projectCountThreshold: 10 })
  assert.equal(relaxed.risk.risky, false)
  await store.get(2, deployer)
  assert.equal(calls(), 2)
})

test("deployer profile negative results are cached and represented as unknown", async () => {
  const db = new DatabaseSync(":memory:")
  let calls = 0
  const store = createDeployerProfileStore({
    db,
    fetchProfile: async () => { calls += 1; return null },
  })
  assert.equal(await store.get(1, deployer), null)
  assert.equal(await store.get(1, deployer), null)
  assert.equal(calls, 1)
})
