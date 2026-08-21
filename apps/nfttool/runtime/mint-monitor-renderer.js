function defaultRaf(callback) { return setTimeout(() => callback(Date.now()), 16) }
function defaultCancel(handle) { clearTimeout(handle) }
function defaultIdle(callback) { return setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 8 }), 0) }
function defaultCancelIdle(handle) { clearTimeout(handle) }

export function stableSignature(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableSignature).join(",")}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSignature(value[key])}`).join(",")}}`
}

export function createRenderScheduler({
  render = () => {},
  now = () => (globalThis.performance?.now?.() ?? Date.now()),
  queueMicrotask = globalThis.queueMicrotask || ((callback) => Promise.resolve().then(callback)),
  requestAnimationFrame = globalThis.requestAnimationFrame || defaultRaf,
  cancelAnimationFrame = globalThis.cancelAnimationFrame || defaultCancel,
  requestIdleCallback = globalThis.requestIdleCallback || defaultIdle,
  cancelIdleCallback = globalThis.cancelIdleCallback || defaultCancelIdle,
} = {}) {
  const signatures = new Map()
  const pending = new Map()
  const idleJobs = new Map()
  const samples = []
  let microtaskQueued = false
  let frame = null
  let longTasks = 0

  function invalidate(region, signature, task = null) {
    if (signatures.get(region) === signature && !task) return false
    pending.set(region, { signature, task })
    if (!microtaskQueued) {
      microtaskQueued = true
      queueMicrotask(() => {
        microtaskQueued = false
        if (frame === null) frame = requestAnimationFrame(commit)
      })
    }
    return true
  }
  function commit() {
    frame = null
    const started = now()
    const work = [...pending.entries()]; pending.clear()
    for (const [region, item] of work) { signatures.set(region, item.signature); item.task?.(region) }
    render(work.map(([region, item]) => ({ region, signature: item.signature })))
    const elapsed = Math.max(0, now() - started)
    samples.push(elapsed); if (samples.length > 100) samples.shift()
    if (elapsed > 100) longTasks += 1
  }
  function cancelFrame() { if (frame !== null) cancelAnimationFrame(frame); frame = null; pending.clear() }
  function scheduleIdle(key, callback) {
    cancelIdle(key)
    const handle = requestIdleCallback(callback, { timeout: 1000 }); idleJobs.set(key, handle); return handle
  }
  function cancelIdle(key) { const handle = idleJobs.get(key); if (handle !== undefined) cancelIdleCallback(handle); idleJobs.delete(key) }
  function cancelAllIdle() { for (const key of idleJobs.keys()) cancelIdle(key) }
  function metrics() {
    const sorted = samples.slice().sort((a, b) => a - b)
    return { commits: samples.length, p95Ms: sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] : 0, longTasks }
  }
  return { cancelAllIdle, cancelFrame, cancelIdle, invalidate, metrics, scheduleIdle, signatures: () => new Map(signatures) }
}

export function keyedReconcile(root, rows, keyOf, renderRow) {
  if (!root) return
  const existing = new Map([...root.children].map((node) => [node.dataset?.key || node.getAttribute?.("data-key"), node]))
  const fragment = root.ownerDocument?.createDocumentFragment?.() || null
  for (const row of rows || []) {
    const key = String(keyOf(row)); const node = existing.get(key) || renderRow(row)
    if (node.dataset) node.dataset.key = key
    fragment?.append(node)
    existing.delete(key)
  }
  for (const node of existing.values()) node.remove()
  if (fragment) root.append(fragment)
}

export function createRegionSignatures({ metrics, toolbar, feed, detail, actionPanel } = {}) {
  return { metrics: stableSignature(metrics), toolbar: stableSignature(toolbar), feed: stableSignature(feed), detail: stableSignature(detail), actionPanel: stableSignature(actionPanel) }
}

