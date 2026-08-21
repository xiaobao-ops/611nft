function unique(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))]
}

export function liveMintImageSources(value) {
  const sources = []
  const visit = (entry) => {
    if (!entry || typeof entry !== "object") return
    sources.push(
      entry.projectImageUrl,
      entry.image_url,
      entry.imageUrl,
      entry.image_fallback_url,
      entry.imageFallbackUrl,
      entry.collection_snapshot?.image_url,
    )
    if (Array.isArray(entry.events)) entry.events.forEach(visit)
    if (entry.windows && typeof entry.windows === "object") {
      Object.values(entry.windows).forEach((rows) => Array.isArray(rows) && rows.forEach(visit))
    }
  }
  visit(value)
  return unique(sources)
}

export function createLiveMintImagePreloader({ ImageCtor = globalThis.Image, maxEntries = 256 } = {}) {
  const cache = new Map()

  function preloadSource(source) {
    if (!source || typeof ImageCtor !== "function") return Promise.resolve(false)
    if (cache.has(source)) return cache.get(source)
    const pending = new Promise((resolve) => {
      const image = new ImageCtor()
      let settled = false
      const finish = async (loaded) => {
        if (settled) return
        settled = true
        if (loaded && typeof image.decode === "function") await image.decode().catch(() => {})
        resolve(Boolean(image.complete && image.naturalWidth > 0))
      }
      image.decoding = "async"
      image.fetchPriority = "high"
      image.onload = () => { void finish(true) }
      image.onerror = () => { void finish(false) }
      image.src = source
      if (image.complete) queueMicrotask(() => { void finish(image.naturalWidth > 0) })
    }).then((loaded) => {
      if (!loaded) cache.delete(source)
      return loaded
    })
    cache.set(source, pending)
    while (cache.size > Math.max(1, Number(maxEntries) || 256)) cache.delete(cache.keys().next().value)
    return pending
  }

  return async function preloadLiveMintImages(value) {
    const sources = liveMintImageSources(value)
    if (!sources.length) return { requested: 0, loaded: 0 }
    const results = await Promise.all(sources.map(preloadSource))
    return { requested: sources.length, loaded: results.filter(Boolean).length }
  }
}

export const preloadLiveMintImages = createLiveMintImagePreloader()
