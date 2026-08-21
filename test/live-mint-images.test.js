import assert from "node:assert/strict"
import test from "node:test"
import { createLiveMintImagePreloader, liveMintImageSources } from "../src/live-mint-images.js"

test("Live Mint image discovery covers overview rows, events, fallbacks and collection updates", () => {
  assert.deepEqual(liveMintImageSources({
    events: [{ projectImageUrl: "/media/event" }],
    windows: { "1800": [{ image_url: "/media/row", image_fallback_url: "/media/fallback" }] },
    collection_snapshot: { image_url: "/media/snapshot" },
  }), ["/media/snapshot", "/media/event", "/media/row", "/media/fallback"])
})

test("Live Mint images finish loading and decoding before the preloader resolves", async () => {
  const decoded = []
  class ImageStub {
    complete = false
    naturalWidth = 0
    async decode() { decoded.push(this.src) }
    set src(value) {
      this._src = value
      queueMicrotask(() => {
        this.complete = true
        this.naturalWidth = 64
        this.onload()
      })
    }
    get src() { return this._src }
  }
  const preload = createLiveMintImagePreloader({ ImageCtor: ImageStub })
  const value = { events: [{ imageUrl: "/media/a" }, { image_url: "/media/b" }, { imageUrl: "/media/a" }] }
  assert.deepEqual(await preload(value), { requested: 2, loaded: 2 })
  assert.deepEqual(decoded.sort(), ["/media/a", "/media/b"])
  assert.deepEqual(await preload(value), { requested: 2, loaded: 2 })
  assert.equal(decoded.length, 2)
})

test("failed Live Mint image preloads are retryable", async () => {
  let attempts = 0
  class ImageStub {
    complete = false
    naturalWidth = 0
    set src(_value) {
      attempts += 1
      queueMicrotask(() => this.onerror())
    }
  }
  const preload = createLiveMintImagePreloader({ ImageCtor: ImageStub })
  assert.deepEqual(await preload({ image_url: "/media/broken" }), { requested: 1, loaded: 0 })
  assert.deepEqual(await preload({ image_url: "/media/broken" }), { requested: 1, loaded: 0 })
  assert.equal(attempts, 2)
})

test("Live Mint image preloader caps successful URL cache", async () => {
  class ImageStub {
    complete = false
    naturalWidth = 0
    set src(value) {
      this._src = value
      queueMicrotask(() => { this.complete = true; this.naturalWidth = 1; this.onload() })
    }
    get src() { return this._src }
  }
  let created = 0
  class CountingImage extends ImageStub { constructor() { super(); created += 1 } }
  const preload = createLiveMintImagePreloader({ ImageCtor: CountingImage, maxEntries: 2 })
  await preload({ events: [{ imageUrl: "/media/1" }, { imageUrl: "/media/2" }, { imageUrl: "/media/3" }] })
  await preload({ imageUrl: "/media/1" })
  assert.equal(created, 4)
})
