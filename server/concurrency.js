// Shared bounded-concurrency helper. Chain reads are latency-bound, not CPU-bound, so
// the useful limit is "how many in-flight requests will the RPC tolerate", not core count.
export async function mapWithLimit(items, limit, mapper) {
  const output = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      output[index] = await mapper(items[index], index)
    }
  })
  await Promise.all(workers)
  return output
}
