function latency(value) {
  if (value === null || value === undefined || value === "") return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null
}

function monitorSourceLabel(value) {
  const source = String(value || "")
  if (source === "provider") return "聚合数据源"
  if (source === "direct_rpc") return "HTTP RPC"
  return source
}

export function selectRealtimeHealth({ wss, upstreams = [], monitorStatus } = {}) {
  if (wss?.state === "active") {
    return { source: "WSS 实时流", latencyMs: latency(wss.lastLatencyMs) }
  }

  const rpc = upstreams
    .map((upstream) => ({
      ...upstream,
      measuredLatencyMs: latency(upstream.latencyMs ?? upstream.lastLatencyMs),
    }))
    .filter((upstream) => upstream.state === "ready" && upstream.measuredLatencyMs !== null)
    .sort((left, right) => left.measuredLatencyMs - right.measuredLatencyMs)[0]
  if (rpc) {
    const configuredWss = wss && wss.state !== "unconfigured"
    return {
      source: configuredWss ? "HTTP RPC 补洞" : "HTTP RPC",
      latencyMs: rpc.measuredLatencyMs,
    }
  }

  return {
    source: monitorSourceLabel(monitorStatus?.source),
    latencyMs: null,
  }
}
