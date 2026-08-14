import { CHAIN_ID } from './constants.js';
import { mapWithConcurrency } from './pool.js';
import { assertGasWithinLimits, sanitizeRuntimeError } from './safety.js';
import { validateTicket } from './ticket.js';

const MAX_READ_RETRY_DELAY_MS = 60_000;

function receiptSucceeded(receipt) {
  return receipt?.status === 1 || receipt?.status === 1n || receipt?.status === true;
}

function assertTransactionHash(txHash) {
  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new Error('invalid transaction hash returned after broadcast; manual inspection required');
  }
  return txHash;
}

function mintAttemptCount(config) {
  return 1 + Math.max(0, Number(config.failedReceiptRetries || 0));
}

function emitNotification(callback, payload, log) {
  if (typeof callback !== 'function') return;
  try {
    Promise.resolve(callback(payload)).catch(() => {
      log?.('notification callback failed');
    });
  } catch {
    log?.('notification callback failed');
  }
}

async function prepareMintTransaction({
  config,
  walletAddress,
  chain,
  ticket,
}) {
  await chain.verifyTicket(ticket, walletAddress);
  const gasEstimate = await chain.estimateMint(ticket);
  const feeData = await chain.getFeeData();
  const feeOverrides = assertGasWithinLimits({ gasEstimate, feeData, config });
  return Object.freeze({
    gasLimit: gasEstimate,
    ...feeOverrides,
  });
}

async function simulateMintTransaction({ chain, ticket, transactionOverrides }) {
  if (typeof chain.simulateMint !== 'function') return;
  await chain.simulateMint(ticket, transactionOverrides);
}

async function sendAndSaveMint({
  walletAddress,
  chain,
  ticket,
  stateStore,
  transactionOverrides,
}) {
  const tx = await chain.sendMint(ticket, transactionOverrides);
  const txHash = assertTransactionHash(tx?.hash);
  await stateStore.saveSubmitted({ txHash, wallet: walletAddress });
  return txHash;
}

async function finishSubmittedTransaction({
  submitted,
  config,
  walletAddress,
  chain,
  stateStore,
}) {
  if (String(submitted.wallet).toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error('submitted transaction belongs to a different wallet');
  }

  const status = await chain.transactionStatus(submitted.txHash);
  if (status === 'failed') {
    throw new Error('submitted mint transaction failed; refusing automatic replacement');
  }

  if (status !== 'pending' && status !== 'confirmed') {
    throw new Error(`unknown submitted transaction status: ${status}`);
  }

  const receipt = await chain.waitForTransaction(
    submitted.txHash,
    config.confirmations,
  );
  if (!receiptSucceeded(receipt)) {
    throw new Error('submitted mint transaction failed; refusing automatic replacement');
  }
  await chain.verifyMintReceipt(receipt, walletAddress);

  if (!(await chain.hasMinted(walletAddress))) {
    throw new Error('submitted mint transaction confirmed but wallet has not minted');
  }

  await stateStore.clear();
  return { status: 'minted', txHash: submitted.txHash, recovered: true };
}

// Resolve any persisted per-wallet state into a terminal result, or null when
// there is no state and the wallet may proceed. Fails closed on prepared /
// ticket-requested / unknown / failed states so a restart never blindly
// requests another Ticket or re-broadcasts.
export async function resolveExistingState({
  stateStore,
  config,
  walletAddress,
  chain,
}) {
  const submitted = await stateStore.load();
  if (!submitted) return null;

  if (submitted.status === 'prepared') {
    throw new Error('prepared mint state requires manual inspection; refusing automatic send');
  }
  if (submitted.status === 'ticket-requested') {
    throw new Error(
      'ticket-requested mint state requires manual inspection; refusing automatic send',
    );
  }
  if (
    submitted.status === 'submitted' ||
    (submitted.status === undefined && submitted.txHash && submitted.wallet)
  ) {
    return finishSubmittedTransaction({
      submitted,
      config,
      walletAddress,
      chain,
      stateStore,
    });
  }
  throw new Error('unknown mint state requires manual inspection; refusing automatic send');
}

async function inspectExistingStateReadOnly({ stateStore }) {
  const state = await stateStore.load();
  if (!state) return null;
  throw new Error(
    `${state.status || 'unknown'} mint state requires manual inspection; dry-run will not modify persisted state`,
  );
}

// Real broadcast for a single wallet after Mint is open: recheck, reserve,
// fetch + validate the wallet-bound ticket, gas/fee guard, send, persist the
// hash before waiting, verify, and clear. Optional failed-receipt retry only
// runs after the first receipt is known failed and a fresh simulation passes.
export async function executeOpenMint({
  config,
  walletAddress,
  chain,
  ticketClient,
  stateStore,
  claimTicketSalt,
  log,
}) {
  if (await chain.hasMinted(walletAddress)) {
    return { status: 'already-minted' };
  }

  await stateStore.reservePrepared({ wallet: walletAddress });
  await stateStore.markTicketRequested({ wallet: walletAddress });

  const payload = await ticketClient.request(walletAddress);
  const ticket = validateTicket(payload);
  let transactionOverrides = await prepareMintTransaction({
    config,
    walletAddress,
    chain,
    ticket,
  });
  claimTicketSalt?.(ticket.salt);

  const attempts = mintAttemptCount(config);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const txHash = await sendAndSaveMint({
      walletAddress,
      chain,
      ticket,
      stateStore,
      transactionOverrides,
    });
    const receipt = await chain.waitForTransaction(txHash, config.confirmations);
    if (receiptSucceeded(receipt)) {
      await chain.verifyMintReceipt(receipt, walletAddress);
      if (!(await chain.hasMinted(walletAddress))) {
        throw new Error('mint transaction confirmed but wallet has not minted');
      }

      await stateStore.clear();
      return { status: 'minted', txHash };
    }

    if (attempt >= attempts) {
      throw new Error('mint transaction failed; retry budget exhausted');
    }

    log?.(
      `wallet ${walletAddress} mint receipt failed; simulating retry ${attempt + 1}/${attempts}`,
    );
    transactionOverrides = await prepareMintTransaction({
      config,
      walletAddress,
      chain,
      ticket,
    });
    await simulateMintTransaction({ chain, ticket, transactionOverrides });
  }
  throw new Error('mint transaction failed; retry budget exhausted');
}

// Poll mintOpen/totalMinted until Mint opens, with capped exponential backoff on
// transient read failures. Returns once mintOpen is true.
export async function waitForMintOpen({ chain, config, sleep, log }) {
  let readFailures = 0;
  for (;;) {
    let mintOpen;
    try {
      mintOpen = await chain.isMintOpen();
      readFailures = 0;
    } catch {
      const retryDelay = Math.min(
        config.pollIntervalMs * 2 ** readFailures,
        MAX_READ_RETRY_DELAY_MS,
      );
      readFailures += 1;
      log(`monitor read failed; retrying in ${retryDelay}ms`);
      await sleep(retryDelay);
      continue;
    }

    if (mintOpen) {
      log('mintOpen=true totalMinted=skipped');
      return;
    }

    let totalMinted = 'unavailable';
    try {
      totalMinted = await chain.totalMinted();
    } catch {
      // Supply is telemetry only. A failed informational read must not turn a
      // healthy mintOpen read into exponential backoff at the opening edge.
    }
    log(`mintOpen=false totalMinted=${totalMinted}`);
    await sleep(config.pollIntervalMs);
  }
}

export async function runAutoMint({
  config,
  walletAddress,
  chain,
  ticketClient,
  stateStore,
  sleep,
  log,
  onMintOpen,
  onMintSuccess,
}) {
  const actualChainId = Number(await chain.getChainId());
  if (actualChainId !== CHAIN_ID) {
    throw new Error(`wrong chain ID: expected ${CHAIN_ID}, received ${actualChainId}`);
  }

  const existing = await resolveExistingState({
    stateStore,
    config,
    walletAddress,
    chain,
  });
  if (existing) return existing;

  if (await chain.hasMinted(walletAddress)) {
    return { status: 'already-minted' };
  }

  await waitForMintOpen({ chain, config, sleep, log });
  emitNotification(onMintOpen, { pendingCount: 1 }, log);
  const result = await executeOpenMint({
    config,
    walletAddress,
    chain,
    ticketClient,
    stateStore,
    log,
  });
  if (result.status === 'minted') {
    emitNotification(onMintSuccess, {
      index: 0,
      address: walletAddress,
      txHash: result.txHash,
      confirmedCount: 1,
      totalCount: 1,
      recovered: false,
    }, log);
  }
  return result;
}

export async function runSingleMint(options) {
  if (options.config.arm) return runAutoMint(options);

  const report = await runMultiMint({
    config: { ...options.config, arm: false, mintConcurrency: 1 },
    wallets: [
      {
        index: 0,
        address: options.walletAddress,
        chain: options.chain,
        ticketClient: options.ticketClient,
        stateStore: options.stateStore,
      },
    ],
    monitorChain: options.chain,
    sleep: options.sleep,
    log: options.log,
    onMintOpen: options.onMintOpen,
    onMintSuccess: options.onMintSuccess,
  });
  return report.results[0];
}

function summarize(results) {
  const counts = {};
  for (const { status } of results) {
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

// Multi-wallet orchestrator: one shared monitor loop, then a concurrency-capped
// fan-out that mints every pending wallet independently. Each wallet reuses the
// audited single-wallet primitives (resolveExistingState / executeOpenMint), and
// per-wallet failures are isolated so one bad wallet never aborts the batch.
//
// `wallets`: [{ index, address, chain, ticketClient, stateStore }]
// Dry-run (config.arm === false) samples state once and never requests a ticket
// or broadcasts; only config.arm === true reaches the optional pre-fan-out
// hook and executeOpenMint.
export async function runMultiMint({
  config,
  wallets,
  monitorChain,
  sleep,
  log,
  prepareBeforeMintOpen,
  beforeFanOut,
  onMintOpen,
  onMintSuccess,
}) {
  const actualChainId = Number(await monitorChain.getChainId());
  if (actualChainId !== CHAIN_ID) {
    throw new Error(`wrong chain ID: expected ${CHAIN_ID}, received ${actualChainId}`);
  }

  // Phase 1 — per-wallet recovery + already-minted filter (concurrency-capped).
  const prepared = await mapWithConcurrency(
    wallets,
    config.readConcurrency || config.mintConcurrency,
    async (entry) => {
      try {
        const existing = config.arm
          ? await resolveExistingState({
              stateStore: entry.stateStore,
              config,
              walletAddress: entry.address,
              chain: entry.chain,
            })
          : await inspectExistingStateReadOnly({ stateStore: entry.stateStore });
        if (existing) return { entry, outcome: existing };
        if (await entry.chain.hasMinted(entry.address)) {
          return { entry, outcome: { status: 'already-minted' } };
        }
        return { entry, outcome: null };
      } catch (error) {
        return {
          entry,
          outcome: {
            status: 'needs-inspection',
            error: sanitizeRuntimeError(error, config),
          },
        };
      }
    },
  );

  const pending = prepared.filter((item) => item.outcome === null);
  let mintOpen = false;
  let confirmedCount = 0;
  const recovered = prepared.filter((item) => item.outcome?.status === 'minted');
  for (const item of recovered) {
    confirmedCount += 1;
    emitNotification(onMintSuccess, {
      index: item.entry.index,
      address: item.entry.address,
      txHash: item.outcome.txHash,
      confirmedCount,
      totalCount: wallets.length,
      recovered: true,
    }, log);
  }

  // Phase 2 — monitor then fan out over pending wallets only.
  if (pending.length > 0) {
    if (!config.arm) {
      mintOpen = await monitorChain.isMintOpen();
      const totalMinted = await monitorChain.totalMinted();
      log(
        `dry-run: mintOpen=${mintOpen} totalMinted=${totalMinted} pending=${pending.length} (no ticket, no broadcast)`,
      );
      for (const item of pending) item.outcome = { status: 'dry-run-ready' };
    } else {
      if (typeof beforeFanOut !== 'function') {
        throw new Error('beforeFanOut is required in armed mode when wallets are pending');
      }
      let earlyPreparation = null;
      if (typeof prepareBeforeMintOpen === 'function') {
        try {
          earlyPreparation = Promise.resolve(prepareBeforeMintOpen({
            pending: pending.map(({ entry }) => entry),
          }));
        } catch (error) {
          earlyPreparation = Promise.reject(error);
        }
      }
      // Preparation deliberately overlaps the monitor loop. Observe rejection
      // immediately, then surface the original failure at the Mint-open gate.
      earlyPreparation?.catch(() => {});
      log(`armed: monitoring for Mint open, ${pending.length} wallet(s) pending`);
      await waitForMintOpen({ chain: monitorChain, config, sleep, log });
      mintOpen = true;
      emitNotification(onMintOpen, { pendingCount: pending.length }, log);
      await earlyPreparation;
      await beforeFanOut({ pending: pending.map(({ entry }) => entry) });
      log(`Mint open — firing ${pending.length} wallet(s), concurrency=${config.mintConcurrency}`);

      const claimedSalts = new Set();
      const claimTicketSalt = (salt) => {
        const normalized = salt.toLowerCase();
        if (claimedSalts.has(normalized)) {
          throw new Error('duplicate ticket salt in batch');
        }
        claimedSalts.add(normalized);
      };

      const minted = await mapWithConcurrency(
        pending,
        config.mintConcurrency,
        async ({ entry }) => {
          try {
            const outcome = await executeOpenMint({
              config,
              walletAddress: entry.address,
              chain: entry.chain,
              ticketClient: entry.ticketClient,
              stateStore: entry.stateStore,
              claimTicketSalt,
              log,
            });
            if (outcome.status === 'minted') {
              confirmedCount += 1;
              emitNotification(onMintSuccess, {
                index: entry.index,
                address: entry.address,
                txHash: outcome.txHash,
                confirmedCount,
                totalCount: wallets.length,
                recovered: false,
              }, log);
            }
            return outcome;
          } catch (error) {
            let persisted;
            let stateReadFailed = false;
            try {
              persisted = await entry.stateStore.load();
            } catch {
              stateReadFailed = true;
              // Preserve the original runtime error; unreadable state cannot
              // prove that a Ticket request or transaction was persisted.
            }
            const status =
              stateReadFailed ||
              persisted?.status === 'ticket-requested' ||
              persisted?.status === 'submitted'
                ? 'needs-inspection'
                : 'failed';
            return { status, error: sanitizeRuntimeError(error, config) };
          }
        },
      );
      pending.forEach((item, i) => {
        item.outcome = minted[i];
      });
    }
  }

  const results = prepared.map(({ entry, outcome }) => ({
    index: entry.index,
    address: entry.address,
    ...outcome,
  }));

  return Object.freeze({
    mode: config.arm ? 'armed' : 'dry-run',
    mintOpen,
    results,
    summary: summarize(results),
  });
}
