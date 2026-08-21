import assert from "node:assert/strict"
import test from "node:test"
import { selectRealtimeHealth } from "../server/realtime-health.js"

test("active WSS is the preferred realtime source", () => {
  assert.deepEqual(selectRealtimeHealth({
    wss: { state: "active", lastLatencyMs: 31 },
    upstreams: [{ state: "ready", latencyMs: 80 }],
  }), { source: "WSS 实时流", latencyMs: 31 })
})

test("ready HTTP RPC is used when WSS is not active", () => {
  assert.deepEqual(selectRealtimeHealth({
    wss: { state: "connecting", lastLatencyMs: 150 },
    upstreams: [
      { state: "ready", latencyMs: 72, lastLatencyMs: 74 },
      { state: "ready", latencyMs: 45, lastLatencyMs: 48 },
    ],
  }), { source: "HTTP RPC 补洞", latencyMs: 45 })
})

test("configured monitor source remains visible before latency is sampled", () => {
  assert.deepEqual(selectRealtimeHealth({
    wss: { state: "unconfigured", upstreams: [] },
    upstreams: [],
    monitorStatus: { source: "provider" },
  }), { source: "聚合数据源", latencyMs: null })
})
