import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"

function matches(expected, provided) {
  if (!expected || !provided) return false
  const left = Buffer.from(expected)
  const right = Buffer.from(String(provided))
  return left.length === right.length && timingSafeEqual(left, right)
}

export function createTaskConfirmationStore({ ttlMs = 10 * 60 * 1000, now = Date.now } = {}) {
  const previews = new Map()

  function cleanup() {
    const timestamp = now()
    for (const [id, preview] of previews) if (preview.expiresAtMs <= timestamp) previews.delete(id)
  }

  function create(type, payload) {
    cleanup()
    const id = randomUUID()
    const confirmationToken = randomBytes(24).toString("hex")
    const expiresAtMs = now() + ttlMs
    previews.set(id, { id, type, payload, confirmationToken, expiresAtMs })
    return { previewId: id, confirmationToken, expiresAt: new Date(expiresAtMs).toISOString() }
  }

  function consume(type, previewId, confirmationToken) {
    cleanup()
    const preview = previews.get(String(previewId || ""))
    if (!preview) throw Object.assign(new Error("Task preview was not found or has expired"), { status: 404 })
    if (preview.type !== type) throw Object.assign(new Error("Task preview type does not match this operation"), { status: 409 })
    if (!matches(preview.confirmationToken, confirmationToken)) {
      throw Object.assign(new Error("Task confirmation is missing or invalid"), { status: 403 })
    }
    previews.delete(preview.id)
    return preview.payload
  }

  return { cleanup, consume, create, size: () => previews.size }
}
