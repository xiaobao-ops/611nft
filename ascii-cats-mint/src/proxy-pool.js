const DEFAULT_MAX_REPLACEMENTS = 20;
const DEFAULT_DEADLINE_MS = 60_000;

export function createReserveProxyClient({ proxyUrls }) {
  if (!Array.isArray(proxyUrls)) {
    throw new Error('reserve proxy URLs must be an array');
  }

  const queue = [...proxyUrls];
  let cursor = 0;
  return Object.freeze({
    async acquire(count) {
      if (!Number.isSafeInteger(count) || count < 1) {
        throw new Error('reserve proxy count must be a positive integer');
      }
      const selected = queue.slice(cursor, cursor + count);
      cursor += selected.length;
      if (selected.length < count) {
        throw new Error(
          `reserve proxy file requested ${count} proxies but only ${selected.length} remain`,
        );
      }
      return selected;
    },
  });
}

function validateOptions({
  staticProxyUrls,
  apiClient,
  replacementClient,
  createDispatcher,
  verifyEgressIps,
  maxReplacements,
  deadlineMs,
  now,
}) {
  if (!Array.isArray(staticProxyUrls)) {
    throw new Error('static proxy URLs must be an array');
  }
  if (typeof apiClient?.acquire !== 'function') {
    throw new Error('proxy API client is required');
  }
  if (
    replacementClient !== undefined &&
    typeof replacementClient?.acquire !== 'function'
  ) {
    throw new Error('proxy replacement client is invalid');
  }
  if (typeof createDispatcher !== 'function') {
    throw new Error('proxy dispatcher factory is required');
  }
  if (typeof verifyEgressIps !== 'function') {
    throw new Error('proxy egress verifier is required');
  }
  if (!Number.isSafeInteger(maxReplacements) || maxReplacements < 0) {
    throw new Error('proxy replacement limit must be a non-negative integer');
  }
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
    throw new Error('proxy pool deadline must be a positive integer');
  }
  if (typeof now !== 'function') {
    throw new Error('proxy pool clock is required');
  }
}

function normalizeIndexes(indexes) {
  if (!Array.isArray(indexes) || indexes.length === 0) {
    throw new Error('proxy pool indexes must be a non-empty array');
  }
  const normalized = [...indexes].sort((left, right) => left - right);
  if (
    normalized.some((index) => !Number.isSafeInteger(index) || index < 0) ||
    new Set(normalized).size !== normalized.length
  ) {
    throw new Error('proxy pool indexes must be unique non-negative integers');
  }
  return normalized;
}

function validateReport(report, expectedCount) {
  if (!Array.isArray(report?.results) || report.results.length !== expectedCount) {
    throw new Error('proxy egress verification returned an invalid report');
  }
  return report.results.map((result, position) => {
    if (result?.index !== position) {
      throw new Error('proxy egress verification returned an invalid report');
    }
    const ok = result.ok === true && typeof result.ip === 'string' && result.ip.length > 0;
    return { ok, ip: ok ? result.ip : null };
  });
}

export function createHybridProxyPool({
  staticProxyUrls,
  apiClient,
  replacementClient = apiClient,
  createDispatcher,
  verifyEgressIps,
  maxReplacements = DEFAULT_MAX_REPLACEMENTS,
  deadlineMs = DEFAULT_DEADLINE_MS,
  now = Date.now,
}) {
  validateOptions({
    staticProxyUrls,
    apiClient,
    replacementClient,
    createDispatcher,
    verifyEgressIps,
    maxReplacements,
    deadlineMs,
    now,
  });

  const slots = new Map();
  const createdDispatchers = new Set();
  const closedDispatchers = new Set();
  const historicalUrls = new Set(staticProxyUrls);
  let locked = false;
  let closed = false;
  let preparePromise;
  let prepareKey;
  let refreshPromise;
  let closePromise;

  const closeDispatcher = async (dispatcher) => {
    if (!dispatcher || closedDispatchers.has(dispatcher)) return null;
    try {
      await dispatcher.close?.();
      closedDispatchers.add(dispatcher);
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  };

  const closeDispatchers = async (dispatchers, { suppressErrors = false } = {}) => {
    const errors = (await Promise.all(dispatchers.map(closeDispatcher))).filter(Boolean);
    if (!suppressErrors && errors.length > 0) {
      throw new AggregateError(errors, `failed to close ${errors.length} proxy dispatcher(s)`);
    }
  };

  const closeAllDispatchers = async (options) => {
    await closeDispatchers([...createdDispatchers], options);
  };

  const buildDispatcher = (url) => {
    const dispatcher = createDispatcher(url);
    if (!dispatcher || (typeof dispatcher !== 'object' && typeof dispatcher !== 'function')) {
      throw new Error('proxy dispatcher factory returned an invalid dispatcher');
    }
    createdDispatchers.add(dispatcher);
    return dispatcher;
  };

  const createRunContext = () => {
    const startedAt = now();
    const expiresAt = startedAt + deadlineMs;
    let replacementCount = 0;

    const assertBeforeDeadline = () => {
      if (now() >= expiresAt) throw new Error('proxy pool preparation deadline exceeded');
    };

    const acquireFresh = async (client, count) => {
      assertBeforeDeadline();
      const urls = await client.acquire(count);
      assertBeforeDeadline();
      if (!Array.isArray(urls) || urls.length < count) {
        throw new Error(
          `proxy API requested ${count} proxies but received ${Array.isArray(urls) ? urls.length : 0}`,
        );
      }
      const selected = urls.slice(0, count);
      const batch = new Set();
      for (const url of selected) {
        if (typeof url !== 'string' || url.length === 0) {
          throw new Error('proxy API returned an invalid proxy URL');
        }
        if (batch.has(url)) {
          throw new Error('proxy API returned a repeated proxy URL');
        }
        if (historicalUrls.has(url)) {
          throw new Error('proxy API returned a previously acquired proxy URL');
        }
        batch.add(url);
      }
      for (const url of selected) historicalUrls.add(url);
      return selected;
    };

    const verify = async (batchSlots) => {
      assertBeforeDeadline();
      const report = await verifyEgressIps(batchSlots.map(({ dispatcher }) => dispatcher));
      assertBeforeDeadline();
      return validateReport(report, batchSlots.length);
    };

    return Object.freeze({
      acquireFresh,
      verify,
      addReplacements(count) {
        replacementCount += count;
      },
      replacementCount() {
        return replacementCount;
      },
    });
  };

  const classifySlots = (batchSlots, results) => {
    const pending = new Set();
    const retainedByIp = new Map();
    const successfulByIp = new Map();

    for (let position = 0; position < batchSlots.length; position += 1) {
      const slot = batchSlots[position];
      const result = results[position];
      if (!result.ok) {
        pending.add(slot.index);
        continue;
      }
      const group = successfulByIp.get(result.ip) ?? [];
      group.push(slot);
      successfulByIp.set(result.ip, group);
    }

    for (const [ip, group] of successfulByIp) {
      group.sort((left, right) => left.index - right.index);
      const [kept, ...duplicates] = group;
      kept.ip = ip;
      retainedByIp.set(ip, kept.index);
      for (const duplicate of duplicates) pending.add(duplicate.index);
    }

    return { pending, retainedByIp };
  };

  const repairPending = async ({ pending, retainedByIp, context }) => {
    while (pending.size > 0) {
      const replacementIndexes = [...pending].sort((left, right) => left - right);
      pending.clear();

      await closeDispatchers(
        replacementIndexes.map((index) => slots.get(index)?.dispatcher),
      );

      if (context.replacementCount() + replacementIndexes.length > maxReplacements) {
        throw new Error('proxy replacement limit exceeded');
      }

      const replacementUrls = await context.acquireFresh(
        replacementClient,
        replacementIndexes.length,
      );
      const replacementSlots = replacementIndexes.map((index, position) => {
        const slot = {
          index,
          url: replacementUrls[position],
          dispatcher: buildDispatcher(replacementUrls[position]),
          ip: null,
        };
        slots.set(index, slot);
        return slot;
      });
      context.addReplacements(replacementSlots.length);

      const replacementResults = await context.verify(replacementSlots);
      const acceptedInBatch = new Map();
      for (let position = 0; position < replacementSlots.length; position += 1) {
        const slot = replacementSlots[position];
        const result = replacementResults[position];
        if (!result.ok || retainedByIp.has(result.ip)) {
          pending.add(slot.index);
          continue;
        }
        const existing = acceptedInBatch.get(result.ip);
        if (!existing) {
          slot.ip = result.ip;
          acceptedInBatch.set(result.ip, slot);
          continue;
        }
        if (slot.index < existing.index) {
          pending.add(existing.index);
          existing.ip = null;
          slot.ip = result.ip;
          acceptedInBatch.set(result.ip, slot);
        } else {
          pending.add(slot.index);
        }
      }
      for (const [ip, slot] of acceptedInBatch) {
        if (!pending.has(slot.index)) retainedByIp.set(ip, slot.index);
      }
    }
  };

  const assertReadySlots = (indexes) => {
    if (
      slots.size !== indexes.length ||
      [...slots.values()].some((slot) => typeof slot.ip !== 'string') ||
      new Set([...slots.values()].map(({ ip }) => ip)).size !== indexes.length
    ) {
      throw new Error('proxy pool could not establish unique egress IPs');
    }
  };

  const runPrepare = async (indexes) => {
    const context = createRunContext();

    try {
      if (closed) throw new Error('proxy pool is closed');

      const staticIndexes = indexes.filter((index) => index < staticProxyUrls.length);
      for (const index of staticIndexes) {
        const url = staticProxyUrls[index];
        if (typeof url !== 'string' || url.length === 0) {
          throw new Error(`static proxy URL is missing for index ${index}`);
        }
        slots.set(index, { index, url, dispatcher: buildDispatcher(url), ip: null });
      }

      const dynamicIndexes = indexes.filter((index) => index >= staticProxyUrls.length);
      const initialDynamicUrls = dynamicIndexes.length > 0
        ? await context.acquireFresh(apiClient, dynamicIndexes.length)
        : [];
      for (let position = 0; position < dynamicIndexes.length; position += 1) {
        const index = dynamicIndexes[position];
        const url = initialDynamicUrls[position];
        slots.set(index, { index, url, dispatcher: buildDispatcher(url), ip: null });
      }

      const initialSlots = indexes.map((index) => slots.get(index));
      const initialResults = await context.verify(initialSlots);
      const { pending, retainedByIp } = classifySlots(initialSlots, initialResults);
      await repairPending({ pending, retainedByIp, context });
      assertReadySlots(indexes);

      locked = true;
      return Object.freeze({
        ready: true,
        indexes: Object.freeze([...indexes]),
        replacementCount: context.replacementCount(),
      });
    } catch (error) {
      locked = false;
      await closeAllDispatchers({ suppressErrors: true });
      throw error;
    }
  };

  const runRefresh = async (indexes) => {
    const context = createRunContext();
    try {
      if (closed) throw new Error('proxy pool is closed');
      if (!locked) throw new Error('proxy pool is not prepared and locked');

      const currentSlots = indexes.map((index) => slots.get(index));
      if (currentSlots.some((slot) => !slot)) {
        throw new Error('proxy pool refresh found an unassigned slot');
      }
      const currentResults = await context.verify(currentSlots);
      const { pending, retainedByIp } = classifySlots(currentSlots, currentResults);
      await repairPending({ pending, retainedByIp, context });
      assertReadySlots(indexes);

      return Object.freeze({
        ready: true,
        refreshed: true,
        indexes: Object.freeze([...indexes]),
        replacementCount: context.replacementCount(),
      });
    } catch (error) {
      locked = false;
      await closeAllDispatchers({ suppressErrors: true });
      throw error;
    }
  };

  return Object.freeze({
    prepare({ indexes } = {}) {
      let normalized;
      try {
        normalized = normalizeIndexes(indexes);
      } catch (error) {
        return Promise.reject(error);
      }
      const key = normalized.join(',');
      if (preparePromise) {
        if (key !== prepareKey) {
          return Promise.reject(new Error('proxy pool prepare already started for different indexes'));
        }
        return preparePromise;
      }
      prepareKey = key;
      preparePromise = runPrepare(normalized);
      return preparePromise;
    },

    refresh({ indexes } = {}) {
      let normalized;
      try {
        normalized = normalizeIndexes(indexes);
      } catch (error) {
        return Promise.reject(error);
      }
      const key = normalized.join(',');
      if (!preparePromise || key !== prepareKey) {
        return Promise.reject(new Error('proxy pool refresh indexes do not match preparation'));
      }
      if (refreshPromise) return refreshPromise;

      const currentRefresh = (async () => {
        await preparePromise;
        return runRefresh(normalized);
      })();
      refreshPromise = currentRefresh;
      const clearRefresh = () => {
        if (refreshPromise === currentRefresh) refreshPromise = undefined;
      };
      currentRefresh.then(clearRefresh, clearRefresh);
      return currentRefresh;
    },

    dispatcherFor(index) {
      if (!locked) throw new Error('proxy pool is not prepared and locked');
      const slot = slots.get(index);
      if (!slot) throw new Error(`proxy dispatcher is not assigned for index ${index}`);
      return slot.dispatcher;
    },

    close() {
      if (closePromise) return closePromise;
      closed = true;
      const currentClose = (async () => {
        if (preparePromise) {
          try {
            await preparePromise;
          } catch {
            // Preparation already performed best-effort cleanup.
          }
        }
        if (refreshPromise) {
          try {
            await refreshPromise;
          } catch {
            // Refresh already performed best-effort cleanup.
          }
        }
        locked = false;
        await closeAllDispatchers();
      })();
      closePromise = currentClose;
      currentClose.catch(() => {
        if (closePromise === currentClose) closePromise = undefined;
      });
      return currentClose;
    },
  });
}
