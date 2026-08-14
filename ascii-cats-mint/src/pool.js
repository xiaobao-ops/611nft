// Bounded worker pool: runs `fn` over `items` with at most `limit` in flight,
// returning results in input order. Used to fan out the 50-wallet mint without
// opening 50 simultaneous ticket/RPC requests. `fn` is expected to resolve (the
// mint orchestrator catches per-wallet failures itself) so one bad wallet does
// not reject the whole batch.
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  const workerCount = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  async function worker() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
