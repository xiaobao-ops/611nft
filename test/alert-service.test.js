import assert from "node:assert/strict"
import test from "node:test"
import { DatabaseSync } from "node:sqlite"
import { createAlertService, migrateAlertRules, toMonitorAlertEvent } from "../server/alert-service.js"

test("monitor alert envelope keeps the SSE type distinct from the rule type", () => {
  const event = toMonitorAlertEvent({ type: "trending", chainId: 1, title: "Hot" }, {
    createId: () => "alert-event",
    now: () => Date.parse("2026-08-17T00:00:00.000Z"),
  })
  assert.equal(event.id, "alert-event")
  assert.equal(event.type, "monitor_alert")
  assert.equal(event.alertType, "trending")
  assert.equal(event.triggeredAt, "2026-08-17T00:00:00.000Z")
})

function fixture() {
  const db = new DatabaseSync(":memory:")
  migrateAlertRules(db)
  let id = 0
  let now = Date.parse("2026-08-17T00:00:00.000Z")
  const service = createAlertService({
    db,
    createId: () => `alert-${++id}`,
    now: () => now,
  })
  return {
    db,
    service,
    advance(ms) { now += ms },
  }
}

test("alert rules persist normalized CRUD state", () => {
  const { service } = fixture()
  const created = service.create({
    type: "trending",
    chainId: 1,
    name: "一分钟热度",
    params: { window: 60, threshold: 8 },
    enabled: true,
  })

  assert.equal(created.id, "alert-1")
  assert.equal(created.type, "trending")
  assert.deepEqual(created.params, { window: 60, threshold: 8 })
  assert.equal(service.list({ chainId: 1 }).rules.length, 1)

  const updated = service.update(created.id, { enabled: false, params: { window: 300, threshold: 12 } })
  assert.equal(updated.enabled, false)
  assert.deepEqual(updated.params, { window: 300, threshold: 12 })
  assert.equal(service.remove(created.id), true)
  assert.equal(service.remove(created.id), false)
})

test("trending alerts trigger once per collection snapshot key", () => {
  const { service } = fixture()
  service.create({ type: "trending", chainId: 1, params: { window: 60, threshold: 3 } })
  const snapshot = {
    type: "trending_snapshot",
    chainId: 1,
    window: 60,
    snapshotId: "1-60-100",
    collections: [
      { address: "0x1111111111111111111111111111111111111111", name: "Alpha", mintCount: 4 },
      { address: "0x2222222222222222222222222222222222222222", name: "Beta", mintCount: 2 },
    ],
  }

  const first = service.evaluate(snapshot)
  assert.equal(first.length, 1)
  assert.equal(first[0].type, "trending")
  assert.equal(first[0].subject.address, snapshot.collections[0].address)
  assert.equal(first[0].metrics.mintCount, 4)
  assert.deepEqual(service.evaluate(snapshot), [])

  const next = service.evaluate({ ...snapshot, snapshotId: "1-60-101" })
  assert.equal(next.length, 1)
})

test("contract, SeaDrop and wallet rules match real event fields", () => {
  const { service } = fixture()
  const contract = "0x3333333333333333333333333333333333333333"
  const wallet = "0x4444444444444444444444444444444444444444"
  service.create({ type: "contract_mint", chainId: 1, params: { address: contract } })
  service.create({ type: "seadrop_start", chainId: 1, params: { leadMinutes: 10 } })
  service.create({ type: "wallet_activity", chainId: 1, params: { address: wallet } })

  const mint = service.evaluate({ type: "mint", id: "mint-1", chainId: 1, address: contract, quantity: "2" })
  assert.equal(mint.length, 1)
  assert.equal(mint[0].type, "contract_mint")

  const radar = service.evaluate({
    type: "seadrop_radar",
    chainId: 1,
    snapshotId: "radar-1",
    drops: [{ id: "drop-1", contract, startTime: "2026-08-17T00:08:00.000Z", stageType: "public" }],
  })
  assert.equal(radar.length, 1)
  assert.equal(radar[0].type, "seadrop_start")

  const walletAlerts = service.evaluate({ type: "wallet_activity", id: "tx-1", chainId: 1, address: wallet, txHash: "0xabc" })
  assert.equal(walletAlerts.length, 1)
  assert.equal(walletAlerts[0].type, "wallet_activity")
})

test("disabled rules, other chains and expired SeaDrop stages stay silent", () => {
  const { service } = fixture()
  service.create({ type: "contract_mint", chainId: 1, enabled: false, params: { address: "0x5555555555555555555555555555555555555555" } })
  service.create({ type: "seadrop_start", chainId: 1, params: { leadMinutes: 5 } })
  assert.deepEqual(service.evaluate({ type: "mint", id: "mint-x", chainId: 2, address: "0x5555555555555555555555555555555555555555" }), [])
  assert.deepEqual(service.evaluate({
    type: "seadrop_radar",
    chainId: 1,
    snapshotId: "expired",
    drops: [{ id: "old", startTime: "2026-08-16T23:59:00.000Z" }],
  }), [])
})
