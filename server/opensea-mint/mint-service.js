import {
  createWalletClient,
  decodeAbiParameters,
  decodeEventLog,
  encodeFunctionData,
  formatEther,
  getAddress,
  http,
  isAddress,
  keccak256,
} from 'viem';
import {mapWithLimit} from '../concurrency.js';
import {baseNonce} from '../nonce-baseline.js';
import {gasBufferBps, loadAppConfig, openSeaChainIdentifier} from './config.js';
import {fetchOpenSea} from './fetch.js';
import {fetchOpenSeaDropCatalog, fetchOpenSeaWalletMintRoutes} from './drops.js';
import {resolveNftTarget} from './target.js';
import {inspectNftIntelligence} from './intelligence.js';
import {openSeaStageIdentity} from './stage-select.js';
import {
  buildDirectSeaDropPlans,
  buildSeaDropCredentialPlans,
  decodeMintAllowList,
  decodeMintPublic,
  decodeMintSigned,
  aggregateSupplyBlocker,
  parseSeaDropCredentials,
  revalidateDirectSeaDropBatch,
  revalidateDirectSeaDropPlan,
  revalidateSeaDropCredentialBatch,
  revalidateSeaDropCredentialPlan,
  serializeSeaDropCredentialInspection,
  serializeSeaDropInspection,
  SEADROP_MINT_ALLOWLIST_SELECTOR,
  SEADROP_MINT_PUBLIC_SELECTOR,
  SEADROP_MINT_SIGNED_SELECTOR,
} from './seadrop.js';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const MINT_SIGNED_SELECTOR = SEADROP_MINT_SIGNED_SELECTOR;

const ERC721_TRANSFER_ABI = [{
  type: 'event',
  name: 'Transfer',
  inputs: [
    {name: 'from', type: 'address', indexed: true},
    {name: 'to', type: 'address', indexed: true},
    {name: 'tokenId', type: 'uint256', indexed: true},
  ],
}];

const MINT_ACTION_QUERY = `query MintActionTimelineQuery(
  $address: Address!
  $fromAssets: [AssetQuantityInput!]!
  $toAssets: [AssetQuantityInput!]!
  $recipient: Address
  $capabilities: WalletCapabilities
) {
  swap(
    address: $address
    fromAssets: $fromAssets
    toAssets: $toAssets
    recipient: $recipient
    action: MINT
    capabilities: $capabilities
  ) {
    actions {
      __typename
      ... on TransactionAction {
        transactionSubmissionData {
          to data value
          chain { networkId identifier gasLimitBufferMultiplier }
        }
      }
      ... on MintAction {
        relayerFulfillment { requestId sameChain crossChain }
        transactionSubmissionData {
          to data value
          chain { networkId identifier gasLimitBufferMultiplier }
        }
      }
    }
    errors { __typename }
  }
}`;

// osmint built its own clients from its own env. Here the host owns chains and
// RPC endpoints, so both arrive by injection.
function readClientFor(chainId, clientForChain) {
  if (typeof clientForChain !== 'function') throw new TypeError('clientForChain is required');
  const publicClient = clientForChain(chainId);
  if (!publicClient) throw new Error(`No RPC client is available for chain ${chainId}.`);
  return publicClient;
}

// executeMintPlan signs with a per-wallet wallet client, so it needs a write
// endpoint URL. That URL cannot be recovered from the read client: the host
// wraps its RPC pool in a custom() transport, which exposes no url, and
// chain.rpcUrls holds viem's own public endpoint -- falling back to it would
// broadcast a mint through a node nobody selected. So the write endpoint is an
// explicit dependency, resolved the same way executeEntries resolves it.
function resolveClients({chainId, clientForChain, writeRpcForChain, env = process.env}) {
  if (typeof writeRpcForChain !== 'function') throw new TypeError('writeRpcForChain is required');
  const publicClient = readClientFor(chainId, clientForChain);
  const chain = publicClient.chain;
  if (!chain?.id) throw new Error(`The injected client for chain ${chainId} carries no viem chain; signing needs one.`);
  const resolvedChainId = Number(chain.id);
  const rpcUrl = writeRpcForChain(resolvedChainId);
  if (typeof rpcUrl !== 'string' || !/^https?:\/\//i.test(rpcUrl)) {
    throw new Error(`writeRpcForChain(${resolvedChainId}) must return an http(s) URL string, received ${rpcUrl === undefined ? 'undefined' : JSON.stringify(rpcUrl)}.`);
  }
  return {
    chainConfig: {
      key: chain.name || String(resolvedChainId),
      chainId: resolvedChainId,
      chainIdentifier: openSeaChainIdentifier(resolvedChainId, env),
      rpcUrl,
    },
    chain,
    publicClient,
    rpcUrl,
  };
}

// osmint's own pool is gone; the repo's mapWithLimit runs the work. Only the
// limit arithmetic is kept, because osmint reads 0 as "no limit" while
// mapWithLimit wants an explicit one.
async function mapConcurrent(items, configuredConcurrency, worker) {
  if (!items.length) return [];
  const limit = Number(configuredConcurrency) === 0
    ? items.length
    : Math.max(1, Math.min(Number(configuredConcurrency) || 1, items.length));
  return mapWithLimit(items, limit, worker);
}

function createConcurrencyLimiter(configuredConcurrency) {
  const limit = Math.max(1, Number(configuredConcurrency) || 1);
  let active = 0;
  const queue = [];

  const drain = () => {
    while (active < limit && queue.length) {
      const {task, resolve, reject} = queue.shift();
      active += 1;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  };

  return (task) => new Promise((resolve, reject) => {
    queue.push({task, resolve, reject});
    drain();
  });
}

async function requestMintAction({
  opensea,
  accountAddress,
  contractAddress,
  quantity,
  tokenId,
  chainIdentifier,
  fetchImpl = fetch,
}) {
  const variables = {
    address: accountAddress,
    fromAssets: [{asset: {chain: chainIdentifier, contractAddress: ZERO_ADDRESS}}],
    toAssets: [{
      asset: {chain: chainIdentifier, contractAddress, tokenId},
      quantity: quantity.toString(),
    }],
    capabilities: {eip7702: false},
  };
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    origin: opensea.origin,
    referer: `${opensea.origin}/`,
    'user-agent': opensea.userAgent,
    'x-app-id': opensea.appId,
  };
  if (opensea.cookies) headers.cookie = opensea.cookies;

  const response = await fetchOpenSea(opensea, opensea.graphqlUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({operationName: 'MintActionTimelineQuery', variables, query: MINT_ACTION_QUERY}),
    signal: AbortSignal.timeout(opensea.requestTimeoutMs),
  }, fetchImpl);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`OpenSea GraphQL returned non-JSON HTTP ${response.status}.`);
  }
  if (!response.ok) throw new Error(`OpenSea GraphQL HTTP ${response.status}.`);

  const swap = body?.data?.swap;
  if (!swap) {
    const details = (body?.errors || []).map((item) => item?.message).filter(Boolean).join('; ');
    throw new Error(`OpenSea returned no mint plan${details ? `: ${details}` : '.'}`);
  }
  const action = (swap.actions || []).find((item) => (
    item?.transactionSubmissionData?.to && item?.transactionSubmissionData?.data
  ));
  if (!action) {
    const names = (swap.errors || []).map((item) => item?.__typename).filter(Boolean).join(', ');
    throw new Error(`OpenSea returned no executable mint action${names ? `: ${names}` : '.'}`);
  }
  return {action, errors: swap.errors || []};
}

export function normalizeSubmission(action, chainConfig) {
  const submission = action.transactionSubmissionData;
  const relayer = action.relayerFulfillment;
  if (relayer && (relayer.crossChain === true || relayer.sameChain === false)) {
    throw new Error('Cross-chain relayer actions are not supported.');
  }
  if (submission.chain?.identifier && submission.chain.identifier !== chainConfig.chainIdentifier) {
    throw new Error(`Returned chain is ${submission.chain.identifier}, expected ${chainConfig.chainIdentifier}.`);
  }
  if (submission.chain?.networkId && Number(submission.chain.networkId) !== chainConfig.chainId) {
    throw new Error(`Returned chain id is ${submission.chain.networkId}, expected ${chainConfig.chainId}.`);
  }
  if (!isAddress(submission.to)) throw new Error('OpenSea returned an invalid transaction target.');
  if (!/^0x[0-9a-fA-F]+$/.test(submission.data) || submission.data.length < 10) {
    throw new Error('OpenSea returned invalid transaction calldata.');
  }
  let value;
  try {
    value = BigInt(submission.value ?? '0');
  } catch {
    throw new Error('OpenSea returned an invalid transaction value.');
  }
  if (value < 0n) throw new Error('OpenSea returned a negative transaction value.');

  return {
    to: getAddress(submission.to),
    data: submission.data,
    value,
    actionType: action.__typename,
    isSeaDropMintSigned: submission.data.slice(0, 10).toLowerCase() === MINT_SIGNED_SELECTOR,
  };
}

export function assertSupportedMintSelector(data) {
  const selector = String(data || '').slice(0, 10).toLowerCase();
  const supportedSelectors = new Set([
    SEADROP_MINT_PUBLIC_SELECTOR,
    SEADROP_MINT_ALLOWLIST_SELECTOR,
    SEADROP_MINT_SIGNED_SELECTOR,
  ]);
  if (!supportedSelectors.has(selector)) {
    throw new Error(`OpenSea returned unsupported mint selector ${selector}; automatic mint is disabled for this action.`);
  }
  return selector;
}

async function buildTransactionPlan({
  publicClient,
  account,
  contractAddress,
  quantity,
  tokenId,
  chainConfig,
  opensea,
  seaDropAddress,
  env,
  fetchImpl = fetch,
}) {
  const {action, errors} = await requestMintAction({
    opensea,
    accountAddress: account.address,
    contractAddress,
    quantity,
    tokenId,
    chainIdentifier: chainConfig.chainIdentifier,
    fetchImpl,
  });
  const transaction = normalizeSubmission(action, chainConfig);
  const selector = assertSupportedMintSelector(transaction.data);
  const targetBytecode = await publicClient.getBytecode({address: transaction.to});
  if (!targetBytecode || targetBytecode === '0x') {
    throw new Error(`OpenSea returned a transaction target without contract bytecode: ${transaction.to}.`);
  }
  if (selector === MINT_SIGNED_SELECTOR
    && transaction.to.toLowerCase() !== seaDropAddress.toLowerCase()) {
    throw new Error(`OpenSea returned mintSigned calldata for an unexpected target: ${transaction.to}.`);
  }
  let directSeaDrop = null;
  if (selector === SEADROP_MINT_PUBLIC_SELECTOR) {
    if (transaction.to.toLowerCase() !== seaDropAddress.toLowerCase()) {
      throw new Error(`OpenSea returned mintPublic calldata for an unexpected target: ${transaction.to}.`);
    }
    const decoded = decodeMintPublic(transaction.data);
    if (decoded.nftContract.toLowerCase() !== contractAddress.toLowerCase()) {
      throw new Error(`OpenSea returned mintPublic calldata for a different NFT contract: ${decoded.nftContract}.`);
    }
    if (decoded.quantity !== quantity) {
      throw new Error(`OpenSea returned mint quantity ${decoded.quantity}, expected ${quantity}.`);
    }
    if (decoded.minterIfNotPayer !== ZERO_ADDRESS) {
      throw new Error('OpenSea returned a delegated SeaDrop payer, which this panel does not support.');
    }
    directSeaDrop = {
      nftContract: decoded.nftContract,
      feeRecipient: decoded.feeRecipient,
      quantity: decoded.quantity,
      mode: 'public',
    };
  }
  if ([SEADROP_MINT_ALLOWLIST_SELECTOR, SEADROP_MINT_SIGNED_SELECTOR].includes(selector)) {
    if (transaction.to.toLowerCase() !== seaDropAddress.toLowerCase()) {
      throw new Error(`OpenSea returned whitelist calldata for an unexpected target: ${transaction.to}.`);
    }
    const decoded = selector === SEADROP_MINT_ALLOWLIST_SELECTOR
      ? decodeMintAllowList(transaction.data)
      : decodeMintSigned(transaction.data);
    if (decoded.nftContract.toLowerCase() !== contractAddress.toLowerCase()) {
      throw new Error(`OpenSea returned whitelist calldata for a different NFT contract: ${decoded.nftContract}.`);
    }
    if (decoded.quantity !== quantity) throw new Error(`OpenSea returned mint quantity ${decoded.quantity}, expected ${quantity}.`);
    if (decoded.minterIfNotPayer !== ZERO_ADDRESS) throw new Error('OpenSea returned a delegated SeaDrop payer, which this panel does not support.');
    if (decoded.feeRecipient === ZERO_ADDRESS) throw new Error('OpenSea returned a zero SeaDrop fee recipient.');
    const credentialValue = decoded.mintParams.mintPrice * decoded.quantity;
    if (transaction.value !== credentialValue) {
      throw new Error(`OpenSea returned whitelist value ${transaction.value}, expected ${credentialValue}.`);
    }
    const credential = {
      address: account.address,
      feeRecipient: decoded.feeRecipient,
      minterIfNotPayer: decoded.minterIfNotPayer,
      mintParams: decoded.mintParams,
      ...(decoded.mode === 'allowlist' ? {proof: decoded.proof} : {salt: decoded.salt, signature: decoded.signature}),
    };
    directSeaDrop = {
      nftContract: decoded.nftContract,
      feeRecipient: decoded.feeRecipient,
      quantity: decoded.quantity,
      mode: decoded.mode,
      credential,
    };
  }
  const [balance, estimatedGas, gasPrice] = await Promise.all([
    publicClient.getBalance({address: account.address}),
    publicClient.estimateGas({
      account,
      to: transaction.to,
      data: transaction.data,
      value: transaction.value,
    }),
    publicClient.getGasPrice(),
  ]);
  const gasLimit = estimatedGas * gasBufferBps(env) / 10000n;
  const estimatedFee = gasLimit * gasPrice;
  return {
    account,
    transaction,
    errors,
    balance,
    estimatedGas,
    gasLimit,
    gasPrice,
    estimatedFee,
    estimatedTotal: transaction.value + estimatedFee,
    directSeaDrop,
  };
}

export function serializePlan(plan) {
  const data = plan.transaction?.data || null;
  const credentialParams = plan.directSeaDrop?.credential?.mintParams || null;
  return {
    address: plan.account.address,
    transaction: {
      to: plan.transaction.to,
      selector: data ? data.slice(0, 10) : null,
      dataHash: data ? keccak256(data) : null,
      value: plan.transaction.value.toString(),
      valueEth: formatEther(plan.transaction.value),
      actionType: plan.transaction.actionType,
      isSeaDropMintSigned: plan.transaction.isSeaDropMintSigned,
    },
    balance: plan.balance.toString(),
    balanceEth: formatEther(plan.balance),
    estimatedGas: plan.estimatedGas.toString(),
    gasLimit: plan.gasLimit.toString(),
    gasPrice: plan.gasPrice.toString(),
    estimatedFee: plan.estimatedFee.toString(),
    estimatedFeeEth: formatEther(plan.estimatedFee),
    estimatedTotal: plan.estimatedTotal.toString(),
    estimatedTotalEth: formatEther(plan.estimatedTotal),
    openSeaStageUuid: plan.openSeaStageUuid || null,
    credential: credentialParams ? {
      mode: plan.directSeaDrop.mode,
      walletAllowance: credentialParams.maxTotalMintableByWallet.toString(),
      stageSupplyLimit: credentialParams.maxTokenSupplyForStage?.toString() ?? null,
      startTime: credentialParams.startTime.toString(),
      endTime: credentialParams.endTime.toString(),
    } : null,
  };
}

function protectionValue(protections, key) {
  const value = protections?.[key];
  return value === null || value === undefined || value === '' ? null : BigInt(value);
}

export function enforceSniperProtections({readyPlans, inspection = null, protections = null, quantity = 1n}) {
  if (!protections) return;
  const minEligibleWallets = Number(protections.minEligibleWallets || 0);
  if (minEligibleWallets && readyPlans.length < minEligibleWallets) {
    throw new Error(`Sniper protection requires at least ${minEligibleWallets} eligible wallets; only ${readyPlans.length} passed.`);
  }
  const maxMintPriceWei = protectionValue(protections, 'maxMintPriceWei');
  if (maxMintPriceWei !== null) {
    const overPrice = readyPlans.find((plan) => plan.transaction.value / BigInt(quantity) > maxMintPriceWei);
    if (overPrice) throw new Error(`Mint price exceeds the sniper limit for ${overPrice.account.address}.`);
  }
  const maxGasPriceWei = protectionValue(protections, 'maxGasPriceWei');
  if (maxGasPriceWei !== null) {
    const overGas = readyPlans.find((plan) => plan.gasPrice > maxGasPriceWei);
    if (overGas) throw new Error('Current gas price exceeds the sniper limit.');
  }
  const maxTotalWei = protectionValue(protections, 'maxTotalWei');
  if (maxTotalWei !== null) {
    const total = readyPlans.reduce((sum, plan) => sum + plan.estimatedTotal, 0n);
    if (total > maxTotalWei) throw new Error(`Estimated batch total ${formatEther(total)} ETH exceeds the sniper limit.`);
  }
  const minSupply = protectionValue(protections, 'minSupply');
  if (minSupply !== null) {
    const supplyLeft = inspection?.supplyLeft;
    if (supplyLeft === null || supplyLeft === undefined) {
      throw new Error('Remaining supply cannot be verified for the selected sniper route.');
    }
    if (BigInt(supplyLeft) < minSupply) {
      throw new Error(`Remaining supply ${supplyLeft} is below the sniper minimum of ${minSupply}.`);
    }
  }
}

function finalizePreview(preview, protections) {
  if (preview.readyPlans.length) {
    enforceSniperProtections({
      readyPlans: preview.readyPlans,
      inspection: preview.inspection,
      protections,
      quantity: preview.quantity,
    });
  }
  return {...preview, protections};
}

function catalogSupply(catalog) {
  const currentSupply = catalog?.totalSupply === null || catalog?.totalSupply === undefined
    ? null
    : BigInt(catalog.totalSupply);
  const maxSupply = catalog?.maxSupply === null || catalog?.maxSupply === undefined
    ? null
    : BigInt(catalog.maxSupply);
  const supplyLeft = currentSupply !== null && maxSupply !== null
    ? (maxSupply > currentSupply ? maxSupply - currentSupply : 0n)
    : null;
  return {currentSupply, maxSupply, supplyLeft};
}

function matchingOpenSeaStage(catalog, stageUuid) {
  const stage = catalog?.stages?.find((item) => item.uuid === stageUuid);
  if (!stage) throw new Error('The selected OpenSea sales stage no longer exists. Refresh NFT intelligence.');
  if (stage.category !== 'allowlist') throw new Error('Scheduled OpenSea credential polling requires an Allowlist stage.');
  return stage;
}

async function previewScheduledOpenSeaMint({
  clients,
  appConfig,
  catalog,
  stageUuid,
  accounts,
  contractAddress,
  quantity,
  tokenId,
  concurrency,
  requestedScheduleAt,
  protections,
  openSeaStageSelections = null,
  clock = Date.now,
}) {
  const selectedByAddress = new Map((openSeaStageSelections || []).map((selection) => [
    String(selection.address || selection.account?.address || '').toLowerCase(),
    matchingOpenSeaStage(catalog, selection.stage?.uuid),
  ]));
  const defaultStage = selectedByAddress.size ? null : matchingOpenSeaStage(catalog, stageUuid);
  const accountStages = accounts.map((account) => ({
    account,
    stage: selectedByAddress.get(account.address.toLowerCase()) || defaultStage,
  }));
  if (accountStages.some((item) => !item.stage)) throw new Error('A selected wallet has no OpenSea stage assignment.');
  for (const {stage} of accountStages) {
    if (BigInt(quantity) > BigInt(stage.maxPerWallet)) {
      throw new Error(`Requested quantity ${quantity} exceeds the OpenSea stage wallet limit of ${stage.maxPerWallet}.`);
    }
  }
  const uniqueStages = [...new Map(accountStages.map(({stage}) => [stage.uuid, stage])).values()];
  const overlapStart = Math.max(...uniqueStages.map((stage) => Number(stage.startTime)));
  const overlapEnd = Math.min(...uniqueStages.map((stage) => Number(stage.endTime)));
  if (overlapStart > overlapEnd) {
    throw new Error('Selected wallet stages do not share a broadcast window; arm each non-overlapping stage separately.');
  }
  const scheduledAt = resolveScheduledAt({
    requestedScheduleAt,
    inspection: {drop: {startTime: overlapStart, endTime: overlapEnd}},
    scheduling: appConfig.mint.scheduling,
    nowMs: clock(),
  });
  const [block, gasPrice] = await Promise.all([
    clients.publicClient.getBlock({blockTag: 'latest'}),
    clients.publicClient.getGasPrice(),
  ]);
  const gasLimit = appConfig.mint.scheduling.gasLimit;
  const estimatedFee = gasLimit * gasPrice;
  const outcomes = await mapConcurrent(accountStages, concurrency, async ({account, stage}) => {
    try {
      const value = BigInt(stage.mintPrice) * BigInt(quantity);
      const balance = await clients.publicClient.getBalance({address: account.address});
      const estimatedTotal = value + estimatedFee;
      if (balance < estimatedTotal) {
        return {
          type: 'skipped',
          address: account.address,
          reason: `Insufficient balance: ${formatEther(balance)} ETH available, about ${formatEther(estimatedTotal)} ETH required.`,
        };
      }
      return {
        type: 'ready',
        plan: {
          account,
          transaction: {
            to: appConfig.seaDrop.address,
            data: null,
            value,
            actionType: 'PendingOpenSeaCredential',
            isSeaDropMintSigned: true,
          },
          balance,
          estimatedGas: gasLimit,
          gasLimit,
          gasPrice,
          estimatedFee,
          estimatedTotal,
          directSeaDrop: null,
          waitingForOpenSeaCredential: true,
          openSeaStageUuid: stage.uuid,
          openSeaStage: stage,
        },
      };
    } catch (error) {
      return {
        type: 'failed',
        address: account.address,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });
  const supply = catalogSupply(catalog);
  const phase = Number(block.timestamp) < overlapStart ? 'not_started'
    : Number(block.timestamp) > overlapEnd ? 'ended' : 'live';
  const stageGroups = uniqueStages.map((stage) => ({
    identity: openSeaStageIdentity({
      chainId: clients.chain?.id ?? clients.chainConfig?.chainId,
      contractAddress,
      stage,
    }),
    walletAddresses: accountStages.filter((item) => item.stage.uuid === stage.uuid).map((item) => item.account.address),
  }));
  return finalizePreview({
    ...clients,
    contractAddress,
    quantity,
    tokenId,
    concurrency,
    executionMode: 'scheduled',
    scheduledAt,
    mintRoute: 'opensea_scheduled',
    routeReason: 'OpenSea Allowlist sniper waits for the active stage, then acquires and verifies wallet-specific credentials.',
    inspection: {
      mode: 'opensea_auto',
      phase,
      stageUuid: uniqueStages.length === 1 ? uniqueStages[0].uuid : null,
      stageLabel: uniqueStages.length === 1 ? uniqueStages[0].label : `${uniqueStages.length} wallet-specific stages`,
      mintPrice: uniqueStages.length === 1 ? String(uniqueStages[0].mintPrice) : null,
      mintPriceEth: uniqueStages.length === 1 ? formatEther(BigInt(uniqueStages[0].mintPrice)) : null,
      maxTotalMintableByWallet: uniqueStages.length === 1 ? String(uniqueStages[0].maxPerWallet) : null,
      startTime: overlapStart,
      endTime: overlapEnd,
      startAt: new Date(overlapStart * 1000).toISOString(),
      endAt: new Date(overlapEnd * 1000).toISOString(),
      currentSupply: supply.currentSupply?.toString() ?? null,
      maxSupply: supply.maxSupply?.toString() ?? null,
      supplyLeft: supply.supplyLeft?.toString() ?? null,
    },
    openSeaCatalog: catalog,
    openSeaStage: uniqueStages.length === 1 ? uniqueStages[0] : null,
    openSeaStageGroups: stageGroups,
    readyPlans: outcomes.filter((item) => item.type === 'ready').map((item) => item.plan),
    skippedWallets: outcomes.filter((item) => item.type === 'skipped'),
    failedWallets: outcomes.filter((item) => item.type === 'failed'),
    saleMode: 'auto',
  }, protections);
}

export async function previewMint({
  contractAddress,
  quantity,
  tokenId,
  chainId,
  concurrency,
  accounts,
  clientForChain,
  writeRpcForChain,
  executionMode = 'immediate',
  requestedScheduleAt = null,
  saleMode = 'auto',
  whitelistCredentials = null,
  protections = null,
  openSeaCatalog = null,
  openSeaStageUuid = null,
  openSeaStageSelections = null,
  env = process.env,
  fetchImpl = fetch,
  clock = Date.now,
}) {
  const address = getAddress(contractAddress);
  const appConfig = loadAppConfig(env);
  const clients = resolveClients({chainId, clientForChain, writeRpcForChain, env});
  if (!['auto', 'public', 'allowlist', 'signed'].includes(saleMode)) {
    throw new Error('saleMode must be auto, public, allowlist, or signed.');
  }
  if (saleMode === 'auto'
    && executionMode === 'scheduled'
    && openSeaCatalog
    && (openSeaStageUuid || openSeaStageSelections?.length)) {
    return previewScheduledOpenSeaMint({
      clients,
      appConfig,
      catalog: openSeaCatalog,
      stageUuid: openSeaStageUuid,
      accounts,
      contractAddress: address,
      quantity,
      tokenId,
      concurrency,
      requestedScheduleAt,
      protections,
      openSeaStageSelections,
      clock,
    });
  }
  if (saleMode === 'allowlist' || saleMode === 'signed') {
    const credentials = whitelistCredentials instanceof Map
      ? whitelistCredentials
      : parseSeaDropCredentials(whitelistCredentials, saleMode);
    const direct = await buildSeaDropCredentialPlans({
      publicClient: clients.publicClient,
      accounts,
      contractAddress: address,
      quantity,
      concurrency,
      mode: saleMode,
      credentials,
      allowNotStarted: executionMode === 'scheduled',
      scheduledGasLimit: executionMode === 'scheduled' ? appConfig.mint.scheduling.gasLimit : null,
      env,
    });
    const credentialWindows = direct.readyPlans.map((plan) => plan.directSeaDrop.credential.mintParams);
    const sharedWindow = credentialWindows.length ? {
      startTime: Math.max(...credentialWindows.map((params) => Number(params.startTime))),
      endTime: Math.min(...credentialWindows.map((params) => Number(params.endTime))),
    } : null;
    if (executionMode === 'scheduled' && sharedWindow && sharedWindow.startTime > sharedWindow.endTime) {
      throw new Error('Selected wallets do not share a common whitelist credential window.');
    }
    const scheduledAt = executionMode === 'scheduled' && sharedWindow
      ? resolveScheduledAt({
        requestedScheduleAt,
        inspection: {drop: sharedWindow},
        scheduling: appConfig.mint.scheduling,
        nowMs: clock(),
      })
      : null;
    let readyPlans = direct.readyPlans;
    const failedWallets = [...direct.failedWallets];
    if (scheduledAt) {
      const targetTimestamp = Math.floor(Date.parse(scheduledAt) / 1000);
      readyPlans = direct.readyPlans.filter((plan) => {
        const params = plan.directSeaDrop.credential.mintParams;
        const eligible = targetTimestamp >= Number(params.startTime) && targetTimestamp <= Number(params.endTime);
        if (!eligible) failedWallets.push({
          type: 'failed',
          address: plan.account.address,
          message: 'Scheduled time is outside this wallet credential window.',
        });
        return eligible;
      });
    }
    return finalizePreview({
      ...clients,
      contractAddress: address,
      quantity,
      tokenId,
      concurrency,
      executionMode,
      scheduledAt,
      mintRoute: `seadrop_${saleMode}`,
      routeReason: `SeaDrop v1 ${saleMode} credential route.`,
      inspection: serializeSeaDropCredentialInspection(direct.inspection),
      readyPlans,
      skippedWallets: direct.skippedWallets,
      failedWallets,
      saleMode,
    }, protections);
  }
  if (saleMode === 'public' || executionMode === 'scheduled') {
    const direct = await buildDirectSeaDropPlans({
      publicClient: clients.publicClient,
      accounts,
      contractAddress: address,
      quantity,
      concurrency,
      allowNotStarted: executionMode === 'scheduled',
      scheduledGasLimit: executionMode === 'scheduled' ? appConfig.mint.scheduling.gasLimit : null,
      env,
    });
    const scheduledAt = executionMode === 'scheduled' && direct.readyPlans.length
      ? resolveScheduledAt({
        requestedScheduleAt,
        inspection: direct.inspection,
        scheduling: appConfig.mint.scheduling,
        nowMs: clock(),
      })
      : null;
    return finalizePreview({
      ...clients,
      contractAddress: address,
      quantity,
      tokenId,
      concurrency,
      executionMode,
      scheduledAt,
      mintRoute: 'seadrop_direct',
      routeReason: executionMode === 'scheduled'
        ? 'Scheduled Mint uses on-chain SeaDrop public calldata.'
        : 'Public Mint uses on-chain SeaDrop public calldata.',
      inspection: serializeSeaDropInspection(direct.inspection),
      readyPlans: direct.readyPlans,
      skippedWallets: direct.skippedWallets,
      failedWallets: direct.failedWallets,
      saleMode: 'public',
    }, protections);
  }
  const outcomes = await mapConcurrent(accounts, concurrency, async (account) => {
    try {
      const plan = await buildTransactionPlan({
        publicClient: clients.publicClient,
        account,
        contractAddress: address,
        quantity,
        tokenId,
        chainConfig: clients.chainConfig,
        opensea: appConfig.opensea,
        seaDropAddress: appConfig.seaDrop.address,
        env,
        fetchImpl,
      });
      if (plan.balance < plan.estimatedTotal) {
        return {
          type: 'skipped',
          address: account.address,
          reason: `Insufficient balance: ${formatEther(plan.balance)} ETH available, about ${formatEther(plan.estimatedTotal)} ETH required.`,
        };
      }
      return {type: 'ready', plan};
    } catch (error) {
      return {
        type: 'failed',
        address: account.address,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });

  const openSeaReadyPlans = outcomes.filter((item) => item.type === 'ready').map((item) => item.plan);
  const skippedWallets = outcomes.filter((item) => item.type === 'skipped');
  const failedWallets = outcomes.filter((item) => item.type === 'failed');
  let readyPlans = openSeaReadyPlans;
  let mintRoute = 'opensea';
  let routeReason = null;
  let inspection = null;
  let fallbackSkippedWallets = [];
  let fallbackFailedWallets = [];
  if (failedWallets.length) {
    try {
      const direct = await buildDirectSeaDropPlans({
        publicClient: clients.publicClient,
        accounts: failedWallets.map((item) => accounts.find((account) => account.address.toLowerCase() === item.address.toLowerCase())).filter(Boolean),
        contractAddress: address,
        quantity,
        concurrency,
        env,
      });
      readyPlans = [...openSeaReadyPlans, ...direct.readyPlans];
      mintRoute = openSeaReadyPlans.length && direct.readyPlans.length
        ? 'mixed'
        : direct.readyPlans.length ? 'seadrop_direct' : openSeaReadyPlans.length ? 'opensea' : 'seadrop_direct';
      routeReason = [...new Set(failedWallets.map((item) => item.message))].join('; ');
      inspection = direct.inspection;
      fallbackSkippedWallets = direct.skippedWallets;
      fallbackFailedWallets = direct.failedWallets.map((item) => {
        const original = failedWallets.find((failed) => failed.address.toLowerCase() === item.address.toLowerCase());
        return {
          ...item,
          message: `${original?.message || 'OpenSea plan unavailable.'} SeaDrop fallback: ${item.message}`,
        };
      });
      const fallbackHandledAddresses = new Set([
        ...direct.readyPlans.map((plan) => plan.account.address.toLowerCase()),
        ...direct.skippedWallets.map((item) => item.address.toLowerCase()),
        ...direct.failedWallets.map((item) => item.address.toLowerCase()),
      ]);
      for (let index = failedWallets.length - 1; index >= 0; index -= 1) {
        if (fallbackHandledAddresses.has(failedWallets[index].address.toLowerCase())) failedWallets.splice(index, 1);
      }
      const aggregateBlocker = aggregateSupplyBlocker(
        direct.inspection.supplyLeft,
        quantity,
        readyPlans.length,
      );
      if (aggregateBlocker && direct.readyPlans.length) {
        for (const plan of direct.readyPlans) {
          fallbackFailedWallets.push({type: 'failed', address: plan.account.address, message: aggregateBlocker});
        }
        readyPlans = openSeaReadyPlans;
      }
    } catch (directError) {
      const fallbackMessage = directError instanceof Error ? directError.message : String(directError);
      routeReason = [...new Set(failedWallets.map((item) => item.message))].join('; ');
      if (!openSeaReadyPlans.length) mintRoute = 'seadrop_direct';
      for (const item of failedWallets) {
        item.message = `${item.message} SeaDrop v1 fallback unavailable: ${fallbackMessage}`;
      }
    }
  }

  return finalizePreview({
    ...clients,
    contractAddress: address,
    quantity,
    tokenId,
    concurrency,
    executionMode,
    scheduledAt: null,
    mintRoute,
    routeReason,
    inspection: inspection ? serializeSeaDropInspection(inspection) : null,
    readyPlans,
    skippedWallets: [...skippedWallets, ...fallbackSkippedWallets],
    failedWallets: fallbackFailedWallets.length ? fallbackFailedWallets : failedWallets,
    saleMode,
  }, protections);
}

export function resolveScheduledAt({
  requestedScheduleAt,
  inspection,
  scheduling,
  nowMs = Date.now(),
}) {
  const requestedMs = requestedScheduleAt ? Date.parse(requestedScheduleAt) : inspection.drop.startTime * 1000;
  if (!Number.isFinite(requestedMs)) throw new Error('Scheduled Mint time is invalid.');
  const targetTimestamp = Math.floor(requestedMs / 1000);
  if (targetTimestamp < inspection.drop.startTime || targetTimestamp > inspection.drop.endTime) {
    throw new Error(
      `Scheduled Mint time must be inside the selected sale window: ${new Date(inspection.drop.startTime * 1000).toISOString()} - ${new Date(inspection.drop.endTime * 1000).toISOString()}.`,
    );
  }
  if (requestedMs - nowMs <= scheduling.preflightLeadMs + 500) {
    throw new Error('Scheduled Mint time is too close; use immediate Mint or choose a later time.');
  }
  if (requestedMs - nowMs > scheduling.maxWaitMs) {
    throw new Error(`Scheduled Mint exceeds the maximum wait of ${Math.floor(scheduling.maxWaitMs / 3600000)} hours.`);
  }
  return new Date(requestedMs).toISOString();
}

export async function requoteSeaDropPlan(publicClient, plan) {
  if (!plan.transaction.data.toLowerCase().startsWith(SEADROP_MINT_PUBLIC_SELECTOR)) {
    return {changed: false, oldValue: plan.transaction.value, newValue: plan.transaction.value};
  }
  const words = plan.transaction.data.slice(10);
  if (words.length < 64 * 4) throw new Error('SeaDrop mintPublic calldata is shorter than expected.');
  const nftContract = getAddress(`0x${words.slice(24, 64)}`);
  const quantity = BigInt(`0x${words.slice(64 * 3, 64 * 4)}`);
  const response = await publicClient.call({
    to: plan.transaction.to,
    data: encodeFunctionData({
      abi: [{
        type: 'function',
        name: 'getPublicDrop',
        stateMutability: 'view',
        inputs: [{name: 'nftContract', type: 'address'}],
        outputs: [{
          name: 'publicDrop',
          type: 'tuple',
          components: [
            {name: 'mintPrice', type: 'uint80'},
            {name: 'startTime', type: 'uint48'},
            {name: 'endTime', type: 'uint48'},
            {name: 'maxTotalMintableByWallet', type: 'uint16'},
            {name: 'feeBps', type: 'uint16'},
            {name: 'restrictFeeRecipients', type: 'bool'},
          ],
        }],
      }],
      functionName: 'getPublicDrop',
      args: [nftContract],
    }),
  });
  if (!response.data) throw new Error('SeaDrop getPublicDrop returned no data.');
  const [drop] = decodeAbiParameters([{
    type: 'tuple',
    components: [
      {name: 'mintPrice', type: 'uint80'},
      {name: 'startTime', type: 'uint48'},
      {name: 'endTime', type: 'uint48'},
      {name: 'maxTotalMintableByWallet', type: 'uint16'},
      {name: 'feeBps', type: 'uint16'},
      {name: 'restrictFeeRecipients', type: 'bool'},
    ],
  }], response.data);
  const oldValue = plan.transaction.value;
  const newValue = BigInt(drop.mintPrice) * quantity;
  if (newValue !== oldValue) {
    plan.transaction.value = newValue;
    plan.estimatedTotal = newValue + plan.estimatedFee;
  }
  return {changed: newValue !== oldValue, oldValue, newValue};
}

export function extractMintedErc721Tokens(receipt, contractAddress, ownerAddress) {
  const contractKey = getAddress(contractAddress).toLowerCase();
  const ownerKey = getAddress(ownerAddress).toLowerCase();
  const tokens = [];
  for (const log of receipt?.logs || []) {
    if (String(log.address).toLowerCase() !== contractKey) continue;
    try {
      const decoded = decodeEventLog({
        abi: ERC721_TRANSFER_ABI,
        data: log.data,
        topics: log.topics,
        strict: true,
      });
      if (decoded.eventName !== 'Transfer') continue;
      if (decoded.args.from.toLowerCase() !== ZERO_ADDRESS) continue;
      if (decoded.args.to.toLowerCase() !== ownerKey) continue;
      tokens.push(decoded.args.tokenId.toString());
    } catch {
      // Ignore unrelated or non-standard logs from the collection contract.
    }
  }
  return [...new Set(tokens)];
}

export async function executeMintPlan({plan, preview, contractAddress}) {
  const startedAt = performance.now();
  const configuredGasPriceWei = protectionValue(preview.protections, 'gasPriceWei');
  // The revalidation and the balance/fee reads share no inputs — the latter only
  // needs plan.account.address, which is already known — so they go out together
  // rather than one after the other. Two sequential waves cost an extra round
  // trip on the one path where latency decides whether the mint lands.
  //
  // allSettled, not Promise.all: the checks below must keep reporting in their
  // original order. A price increase has to surface as "preview again" even when
  // the wallet is also short on funds, because re-previewing is what fixes it,
  // and Promise.all would surface whichever rejected first instead.
  const [quoteResult, fundingResult] = await Promise.allSettled([
    ['allowlist', 'signed'].includes(plan.directSeaDrop?.mode)
      ? revalidateSeaDropCredentialPlan({publicClient: preview.publicClient, plan})
      : plan.directSeaDrop
        ? revalidateDirectSeaDropPlan({publicClient: preview.publicClient, plan})
      : requoteSeaDropPlan(preview.publicClient, plan),
    Promise.all([
      preview.publicClient.getBalance({address: plan.account.address}),
      currentFeeRequest(preview.publicClient).then((value) => applyGasPriceOverride(value, configuredGasPriceWei)),
    ]),
  ]);
  if (quoteResult.status === 'rejected') throw quoteResult.reason;
  const quote = quoteResult.value;
  const revalidatedAt = performance.now();
  const revalidatedAtIso = new Date().toISOString();
  if (quote.changed && quote.newValue > quote.oldValue) {
    throw new Error(`Mint price increased from ${formatEther(quote.oldValue)} ETH to ${formatEther(quote.newValue)} ETH. Preview again.`);
  }
  if (fundingResult.status === 'rejected') throw fundingResult.reason;
  const [balance, fees] = fundingResult.value;
  const currentGasPrice = fees.reservationFeePerGas;
  plan.balance = balance;
  const maxGasPriceWei = protectionValue(preview.protections, 'maxGasPriceWei');
  if (maxGasPriceWei !== null && currentGasPrice > maxGasPriceWei) {
    throw new Error(`Current gas price exceeds the sniper limit for ${plan.account.address}.`);
  }
  const maxMintPriceWei = protectionValue(preview.protections, 'maxMintPriceWei');
  if (maxMintPriceWei !== null && plan.transaction.value / BigInt(preview.quantity) > maxMintPriceWei) {
    throw new Error(`Mint price exceeds the sniper limit for ${plan.account.address}.`);
  }
  plan.gasPrice = currentGasPrice;
  plan.estimatedFee = plan.gasLimit * currentGasPrice;
  plan.estimatedTotal = plan.transaction.value + plan.estimatedFee;
  if (balance < plan.estimatedTotal) {
    throw new Error(`Insufficient balance: ${formatEther(balance)} ETH available, about ${formatEther(plan.estimatedTotal)} ETH required.`);
  }
  const walletClient = createWalletClient({
    account: plan.account,
    chain: preview.chain,
    transport: http(preview.rpcUrl),
  });
  let hash;
  const broadcastStartedIso = new Date().toISOString();
  try {
    hash = await walletClient.sendTransaction({
      account: plan.account,
      to: plan.transaction.to,
      data: plan.transaction.data,
      value: plan.transaction.value,
      gas: plan.gasLimit,
      ...feeRequestFields(fees),
    });
  } catch (error) {
    const wrapped = new Error(`Mint transaction broadcast failed: ${error instanceof Error ? error.message : String(error)}`, {cause: error});
    wrapped.code = 'MINT_BROADCAST_UNKNOWN';
    throw wrapped;
  }
  const broadcastAt = performance.now();
  const broadcastAtIso = new Date().toISOString();
  let receipt;
  try {
    receipt = await preview.publicClient.waitForTransactionReceipt({hash});
  } catch (error) {
    const wrapped = new Error(`Mint receipt status is unknown for ${hash}: ${error instanceof Error ? error.message : String(error)}`, {cause: error});
    wrapped.code = 'MINT_RECEIPT_UNKNOWN';
    wrapped.hash = hash;
    throw wrapped;
  }
  const confirmedAt = performance.now();
  if (receipt.status !== 'success') {
    const wrapped = new Error(`Transaction reverted: ${hash}`);
    wrapped.code = 'MINT_REVERTED';
    wrapped.hash = hash;
    throw wrapped;
  }
  const confirmedAtIso = new Date().toISOString();
  const mintTime = await resolveReceiptMintTime(preview.publicClient, receipt, confirmedAtIso);
  const tokenIds = extractMintedErc721Tokens(receipt, contractAddress, plan.account.address);
  return {
    address: plan.account.address,
    hash,
    status: 'confirmed',
    blockNumber: receipt.blockNumber.toString(),
    valueEth: formatEther(plan.transaction.value),
    requoted: quote.changed,
    tokenIds,
    mintedAt: mintTime.mintedAt,
    chainTimestamp: mintTime.chainTimestamp,
    timing: {
      revalidateMs: Math.round(revalidatedAt - startedAt),
      broadcastMs: Math.round(broadcastAt - revalidatedAt),
      confirmMs: Math.round(confirmedAt - broadcastAt),
      totalMs: Math.round(confirmedAt - startedAt),
    },
    timestamps: {
      revalidatedAt: revalidatedAtIso,
      broadcastStartedAt: broadcastStartedIso,
      broadcastSubmittedAt: broadcastAtIso,
      confirmedAt: confirmedAtIso,
    },
  };
}

export async function executeMintPlanWithRetry({
  plan,
  preview,
  contractAddress,
  maxAttempts = 1,
  delayMs = 0,
  onRetry = () => {},
}) {
  const attempts = Math.max(1, Number(maxAttempts) || 1);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await executeMintPlan({plan, preview, contractAddress});
      return {...result, attempts: attempt};
    } catch (error) {
      const retryable = error?.code === 'MINT_REVERTED';
      if (!retryable || attempt >= attempts) throw error;
      onRetry({attempt, nextAttempt: attempt + 1, error, hash: error.hash || null});
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error('Mint retry attempts exhausted.');
}

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('Mint task stopped.', 'AbortError');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function abortableSleep(milliseconds, signal) {
  throwIfAborted(signal);
  if (!signal) return new Promise((resolve) => setTimeout(resolve, milliseconds));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError(signal));
    }
    signal.addEventListener('abort', onAbort, {once: true});
  });
}

export async function waitForChainTimestamp({publicClient, targetMs, now = () => Date.now(), signal = null}) {
  let anchorTimestampMs = null;
  let anchorObservedAt = null;
  while (true) {
    throwIfAborted(signal);
    const block = await publicClient.getBlock({blockTag: 'latest'});
    throwIfAborted(signal);
    const blockTimestampMs = Number(block.timestamp) * 1000;
    const observedAt = now();
    if (anchorTimestampMs !== blockTimestampMs) {
      anchorTimestampMs = blockTimestampMs;
      anchorObservedAt = observedAt;
    }
    const estimatedChainTime = anchorTimestampMs + Math.max(0, observedAt - anchorObservedAt);
    const remaining = targetMs - estimatedChainTime;
    if (remaining <= 0) return {blockTimestamp: Number(block.timestamp), estimatedChainTime};
    // Once chain time is calibrated inside the final second, use the local
    // monotonic estimate. A last-minute getBlock round trip can consume the
    // broadcast lead window on a busy RPC.
    if (remaining <= 1000) {
      await abortableSleep(remaining, signal);
      return {
        blockTimestamp: Number(block.timestamp),
        estimatedChainTime: targetMs,
      };
    }
    const delay = remaining > 60_000 ? Math.min(30_000, Math.floor(remaining / 4))
      : remaining > 5_000 ? 1000
        : Math.max(50, Math.min(250, remaining));
    await abortableSleep(delay, signal);
  }
}

async function currentFeeRequest(publicClient) {
  try {
    const fees = await publicClient.estimateFeesPerGas({type: 'eip1559'});
    if (fees.maxFeePerGas !== undefined && fees.maxPriorityFeePerGas !== undefined) {
      return {
        type: 'eip1559',
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        reservationFeePerGas: fees.maxFeePerGas,
      };
    }
  } catch {
    // Fall back to a legacy gas price on chains without EIP-1559 fee fields.
  }
  const gasPrice = await publicClient.getGasPrice();
  return {type: 'legacy', gasPrice, reservationFeePerGas: gasPrice};
}

async function resolveReceiptMintTime(publicClient, receipt, fallbackIso) {
  if (receipt?.blockNumber === undefined || typeof publicClient.getBlock !== 'function') {
    return {mintedAt: fallbackIso, chainTimestamp: null};
  }
  try {
    const block = await publicClient.getBlock({blockNumber: receipt.blockNumber});
    const chainTimestamp = Number(block.timestamp);
    if (!Number.isSafeInteger(chainTimestamp) || chainTimestamp <= 0) {
      return {mintedAt: fallbackIso, chainTimestamp: null};
    }
    return {
      mintedAt: new Date(chainTimestamp * 1000).toISOString(),
      chainTimestamp,
    };
  } catch {
    return {mintedAt: fallbackIso, chainTimestamp: null};
  }
}

async function rebuildScheduledSignedItem({
  preview,
  item,
  targetMs,
  credentialMode,
  feesOverride = null,
  waitForTarget,
  signal,
  env,
}) {
  await waitForTarget({publicClient: preview.publicClient, targetMs, signal});
  throwIfAborted(signal);
  if (credentialMode) {
    await revalidateSeaDropCredentialPlan({
      publicClient: preview.publicClient,
      plan: item.plan,
      targetTimestamp: Math.floor(targetMs / 1000),
      env,
    });
  } else {
    await revalidateDirectSeaDropPlan({publicClient: preview.publicClient, plan: item.plan});
  }
  const configuredGasPriceWei = protectionValue(preview.protections, 'gasPriceWei');
  const fees = feesOverride || applyGasPriceOverride(
    await currentFeeRequest(preview.publicClient),
    configuredGasPriceWei,
  );
  const [nonce, balance] = await Promise.all([
    preview.publicClient.getTransactionCount({address: item.plan.account.address, blockTag: 'pending'}),
    preview.publicClient.getBalance({address: item.plan.account.address}),
  ]);
  const required = item.plan.transaction.value + item.plan.gasLimit * fees.reservationFeePerGas;
  if (balance < required) throw new Error(`Insufficient balance before retry: ${formatEther(balance)} ETH available, ${formatEther(required)} ETH reserved.`);
  const request = {
    chainId: preview.chain?.id ?? preview.chainConfig?.chainId,
    type: fees.type,
    nonce,
    gas: item.plan.gasLimit,
    to: item.plan.transaction.to,
    data: item.plan.transaction.data,
    value: item.plan.transaction.value,
    ...feeRequestFields(fees),
  };
  const serializedTransaction = await item.plan.account.signTransaction(request);
  return {...item, request, serializedTransaction};
}

async function resignScheduledItemWithFreshNonce({preview, item, signal}) {
  throwIfAborted(signal);
  const fees = feesFromRequest(item.request);
  const [nonce, balance] = await Promise.all([
    preview.publicClient.getTransactionCount({address: item.plan.account.address, blockTag: 'pending'}),
    preview.publicClient.getBalance({address: item.plan.account.address}),
  ]);
  const required = item.plan.transaction.value + item.plan.gasLimit * fees.reservationFeePerGas;
  if (balance < required) {
    throw new Error(`Insufficient balance before nonce retry: ${formatEther(balance)} ETH available, ${formatEther(required)} ETH reserved.`);
  }
  const request = {
    ...item.request,
    nonce,
    ...feeRequestFields(fees),
  };
  const serializedTransaction = await item.plan.account.signTransaction(request);
  return {...item, request, serializedTransaction, signedAtIso: new Date().toISOString()};
}

function stageIdentityMatches(left, right, {chainId, contractAddress} = {}) {
  const leftIdentity = openSeaStageIdentity({chainId, contractAddress, stage: left});
  const rightIdentity = openSeaStageIdentity({chainId, contractAddress, stage: right});
  return Object.keys(leftIdentity).every((key) => Object.is(leftIdentity[key], rightIdentity[key]));
}

function assertOpenSeaRouteMatchesStage(route, stage, quantity) {
  if (!['allowlist', 'signed'].includes(route.mode) || !route.credential?.mintParams) {
    throw new Error('OpenSea returned a non-Allowlist route for the armed stage.');
  }
  if (route.stageUuid && route.stageUuid !== stage.uuid) {
    throw new Error('OpenSea returned credentials for a different sales stage.');
  }
  const params = route.credential.mintParams;
  if (Number(params.startTime) !== Number(stage.startTime)
    || Number(params.endTime) !== Number(stage.endTime)
    || BigInt(params.mintPrice) !== BigInt(stage.mintPrice)) {
    throw new Error('OpenSea returned credentials for a different sales stage.');
  }
  const catalogLimit = BigInt(stage.maxPerWallet);
  if (catalogLimit > 0n && BigInt(params.maxTotalMintableByWallet) > catalogLimit) {
    throw new Error('OpenSea credential wallet allowance exceeds the selected stage limit.');
  }
  if (BigInt(quantity) > BigInt(params.maxTotalMintableByWallet)) {
    throw new Error('Requested quantity exceeds the OpenSea credential wallet allowance.');
  }
  const stageSupply = BigInt(stage.stageSupply || 0);
  if (stageSupply > 0n
    && params.maxTokenSupplyForStage !== null
    && params.maxTokenSupplyForStage !== undefined
    && BigInt(params.maxTokenSupplyForStage) !== stageSupply) {
    throw new Error('OpenSea credential stage supply does not match the selected stage.');
  }
  if (params.feeBps !== null
    && params.feeBps !== undefined
    && BigInt(params.feeBps) !== BigInt(stage.feeBps || 0)) {
    throw new Error('OpenSea credential fee does not match the selected stage.');
  }
  if (params.restrictFeeRecipients !== null
    && params.restrictFeeRecipients !== undefined
    && Boolean(params.restrictFeeRecipients) !== Boolean(stage.restrictFeeRecipients)) {
    throw new Error('OpenSea credential fee-recipient restriction does not match the selected stage.');
  }
  const stageFeeRecipient = String(stage.feeRecipient || ZERO_ADDRESS).toLowerCase();
  const routeFeeRecipient = String(route.credential.feeRecipient || ZERO_ADDRESS).toLowerCase();
  if (stageFeeRecipient !== ZERO_ADDRESS && routeFeeRecipient !== stageFeeRecipient) {
    throw new Error('OpenSea credential fee recipient does not match the selected stage.');
  }
}

async function buildOpenSeaScheduledPlan({
  publicClient,
  account,
  route,
  stage,
  chainId,
  contractAddress,
  quantity,
  seaDropAddress,
  gasLimit,
  balance = null,
  gasPrice = null,
}) {
  assertOpenSeaRouteMatchesStage(route, stage, quantity);
  if (!route.transaction?.data || route.transaction.data === '0x') {
    throw new Error('OpenSea returned an empty Mint calldata payload.');
  }
  const expectedValue = BigInt(stage.mintPrice) * BigInt(quantity);
  if (BigInt(route.transaction.value) !== expectedValue) {
    throw new Error('OpenSea Mint value does not match the selected stage price.');
  }
  if (route.transaction.to.toLowerCase() !== seaDropAddress.toLowerCase()) {
    throw new Error(`OpenSea returned an unexpected SeaDrop target: ${route.transaction.to}.`);
  }
  const funding = balance !== null && gasPrice !== null
    ? {balance, gasPrice}
    : await Promise.all([
      publicClient.getBalance({address: account.address}),
      publicClient.getGasPrice(),
    ]).then(([resolvedBalance, resolvedGasPrice]) => ({balance: resolvedBalance, gasPrice: resolvedGasPrice}));
  const transaction = {
    ...route.transaction,
    actionType: 'OpenSeaMintAPI',
    isSeaDropMintSigned: route.mode === 'signed',
  };
  const estimatedFee = gasLimit * funding.gasPrice;
  return {
    account,
    transaction,
    errors: [],
    balance: funding.balance,
    estimatedGas: gasLimit,
    gasLimit,
    gasPrice: funding.gasPrice,
    estimatedFee,
    estimatedTotal: transaction.value + estimatedFee,
    directSeaDrop: {
      nftContract: contractAddress,
      feeRecipient: route.credential.feeRecipient,
      quantity: BigInt(quantity),
      mode: route.mode,
      credential: route.credential,
    },
    openSeaStageUuid: stage.uuid,
    openSeaStage: stage,
    openSeaStageIdentity: openSeaStageIdentity({chainId, contractAddress, stage}),
  };
}

function applyGasPriceOverride(fees, gasPriceWei) {
  if (gasPriceWei === null) return fees;
  if (fees.type === 'eip1559') {
    return {
      ...fees,
      maxFeePerGas: gasPriceWei,
      // A configured gas price is an explicit user instruction. Keep both
      // EIP-1559 fee fields aligned so the transaction is not broadcast with
      // a stale RPC priority fee that can underbid the selected amount.
      maxPriorityFeePerGas: gasPriceWei,
      reservationFeePerGas: gasPriceWei,
    };
  }
  return {type: 'legacy', gasPrice: gasPriceWei, reservationFeePerGas: gasPriceWei};
}

function feeRequestFields(fees) {
  return fees.type === 'eip1559'
    ? {maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas}
    : {gasPrice: fees.gasPrice};
}

function feesFromRequest(request) {
  if (request?.type === 'eip1559' || request?.maxFeePerGas !== undefined) {
    const maxFeePerGas = BigInt(request.maxFeePerGas);
    const maxPriorityFeePerGas = BigInt(request.maxPriorityFeePerGas ?? maxFeePerGas);
    return {
      type: 'eip1559',
      maxFeePerGas,
      maxPriorityFeePerGas,
      reservationFeePerGas: maxFeePerGas,
    };
  }
  const gasPrice = BigInt(request.gasPrice);
  return {type: 'legacy', gasPrice, reservationFeePerGas: gasPrice};
}

function isNonceBroadcastError(message) {
  return /nonce\s+(?:too\s+low|has already been used|already\s+used)|invalid\s+nonce|transaction nonce.*(?:low|used)/i.test(message);
}

function isAlreadyKnownBroadcastError(message) {
  return /already known|known transaction|transaction already imported/i.test(message);
}

async function broadcastSignedTransaction(publicClient, serializedTransaction) {
  try {
    return await publicClient.sendRawTransaction({serializedTransaction});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isAlreadyKnownBroadcastError(message)) return keccak256(serializedTransaction);
    throw error;
  }
}

async function observedValue(method, args) {
  if (typeof method !== 'function') return {value: null, error: 'unsupported'};
  try {
    return {value: await method(args), error: null};
  } catch (error) {
    return {value: null, error: error instanceof Error ? error.message : String(error)};
  }
}

async function readOpenSeaNonceCounts(publicClient, address) {
  const [latest, pending] = await Promise.all([
    observedValue(publicClient.getTransactionCount?.bind(publicClient), {address, blockTag: 'latest'}),
    observedValue(publicClient.getTransactionCount?.bind(publicClient), {address, blockTag: 'pending'}),
  ]);
  return {latest: latest.value, pending: pending.value, errors: {latest: latest.error, pending: pending.error}};
}

async function readOpenSeaNonceBaseline(publicClient, address) {
  const counts = await readOpenSeaNonceCounts(publicClient, address);
  return baseNonce(counts);
}

function createOpenSeaNonceAllocator(publicClient, address) {
  let nextNonce = null;
  let blocked = null;
  let tail = Promise.resolve();

  return {
    async take() {
      const allocation = tail.then(async () => {
        if (blocked) throw blocked;
        if (nextNonce === null) nextNonce = await readOpenSeaNonceBaseline(publicClient, address);
        if (!Number.isSafeInteger(nextNonce)) throw new Error('OpenSea nonce is outside JavaScript safe integer range.');
        const nonce = nextNonce;
        nextNonce += 1;
        return nonce;
      });
      tail = allocation.then(() => undefined, () => undefined);
      return allocation;
    },
    async release(nonce) {
      const release = tail.then(() => {
        if (blocked || nextNonce !== nonce + 1) return false;
        nextNonce = nonce;
        return true;
      });
      tail = release.then(() => undefined, () => undefined);
      return release;
    },
    block(error) {
      if (!blocked) blocked = error instanceof Error ? error : new Error(String(error));
    },
    blocked() {
      return blocked;
    },
  };
}

async function reconcileOpenSeaRawTransaction({publicClient, hash, address, nonce}) {
  const [receipt, transaction, counts] = await Promise.all([
    observedValue(publicClient.getTransactionReceipt?.bind(publicClient), {hash}),
    observedValue(publicClient.getTransaction?.bind(publicClient), {hash}),
    readOpenSeaNonceCounts(publicClient, address),
  ]);
  return {
    hash,
    nonce,
    receipt: receipt.value,
    transaction: transaction.value,
    latestNonce: counts.latest,
    pendingNonce: counts.pending,
    lookupErrors: {
      receipt: receipt.error,
      transaction: transaction.error,
      ...counts.errors,
    },
  };
}

function openSeaSubmissionUnknown({hash, nonce, cause, observation}) {
  const message = cause instanceof Error ? cause.message : String(cause);
  const error = new Error(`OpenSea submission status is unknown for ${hash} at nonce ${nonce}: ${message}`, {cause});
  error.code = 'MINT_SUBMISSION_UNKNOWN';
  error.hash = hash;
  error.nonce = nonce;
  error.nonceBlocked = true;
  error.observation = observation;
  return error;
}

function observationForHash(value, hash) {
  if (!value) return null;
  const observedHash = value.transactionHash || value.hash;
  return !observedHash || String(observedHash).toLowerCase() === hash.toLowerCase() ? value : null;
}

function serializableNonce(value) {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : String(value);
}

function serializeOpenSeaObservation(observation) {
  if (!observation) return null;
  const receipt = observation.receipt;
  const transaction = observation.transaction;
  return {
    hash: String(observation.hash || ''),
    nonce: serializableNonce(observation.nonce),
    receipt: receipt ? {
      transactionHash: String(receipt.transactionHash || observation.hash || ''),
      status: receipt.status === null || receipt.status === undefined ? null : String(receipt.status),
      blockHash: receipt.blockHash ? String(receipt.blockHash) : null,
      blockNumber: receipt.blockNumber === null || receipt.blockNumber === undefined
        ? null
        : String(receipt.blockNumber),
    } : null,
    transaction: transaction ? {
      hash: String(transaction.hash || observation.hash || ''),
      nonce: serializableNonce(transaction.nonce),
      blockHash: transaction.blockHash ? String(transaction.blockHash) : null,
      blockNumber: transaction.blockNumber === null || transaction.blockNumber === undefined
        ? null
        : String(transaction.blockNumber),
    } : null,
    latestNonce: serializableNonce(observation.latestNonce),
    pendingNonce: serializableNonce(observation.pendingNonce),
    lookupErrors: Object.fromEntries(Object.entries(observation.lookupErrors || {}).map(([key, value]) => (
      [key, value === null || value === undefined ? null : String(value)]
    ))),
  };
}

async function submitOpenSeaRawTransaction({publicClient, item, onSubmitted = () => {}}) {
  const localHash = keccak256(item.serializedTransaction);
  let rpcHash;
  try {
    rpcHash = await broadcastSignedTransaction(publicClient, item.serializedTransaction);
    if (String(rpcHash).toLowerCase() !== localHash.toLowerCase()) {
      throw new Error(`RPC returned ${rpcHash} for locally signed transaction ${localHash}.`);
    }
  } catch (error) {
    const observation = await reconcileOpenSeaRawTransaction({
      publicClient,
      hash: localHash,
      address: item.plan.account.address,
      nonce: item.nonce,
    });
    const receipt = observationForHash(observation.receipt, localHash);
    const transaction = observationForHash(observation.transaction, localHash);
    const evidence = serializeOpenSeaObservation({...observation, receipt, transaction});
    if (receipt) {
      try { onSubmitted(localHash); } catch {}
      return {hash: localHash, receipt, transaction, accepted: true, confirmationPending: false, reconciled: true, observation: evidence};
    }
    if (transaction) {
      try { onSubmitted(localHash); } catch {}
      return {hash: localHash, receipt: null, transaction, accepted: true, confirmationPending: true, reconciled: true, observation: evidence};
    }
    throw openSeaSubmissionUnknown({hash: localHash, nonce: item.nonce, cause: error, observation: evidence});
  }

  try { onSubmitted(localHash); } catch {}
  try {
    const receipt = await publicClient.waitForTransactionReceipt({hash: localHash});
    return {
      hash: localHash,
      receipt,
      transaction: null,
      accepted: true,
      confirmationPending: false,
      reconciled: false,
      observation: null,
    };
  } catch (error) {
    const observation = await reconcileOpenSeaRawTransaction({
      publicClient,
      hash: localHash,
      address: item.plan.account.address,
      nonce: item.nonce,
    });
    const receipt = observationForHash(observation.receipt, localHash);
    const transaction = observationForHash(observation.transaction, localHash);
    const evidence = serializeOpenSeaObservation({...observation, receipt, transaction});
    if (receipt) {
      return {hash: localHash, receipt, transaction, accepted: true, confirmationPending: false, reconciled: true, observation: evidence};
    }
    if (transaction) {
      return {hash: localHash, receipt: null, transaction, accepted: true, confirmationPending: true, reconciled: true, observation: evidence};
    }
    throw openSeaSubmissionUnknown({hash: localHash, nonce: item.nonce, cause: error, observation: evidence});
  }
}

function isPermanentPublicMintFailure(message) {
  return /sold\s*out|insufficient\s+(?:collection\s+)?supply|supply\s+(?:is\s+)?insufficient|per[- ]wallet|max(?:imum)?[^.\n]*(?:mint|wallet|allowance)|wallet[^.\n]*(?:limit|allowance)|already[^.\n]*mint|minted[^.\n]*(?:maximum|limit)|stage[^.\n]*ended|sale[^.\n]*ended|invalid[^.\n]*(?:quantity|price|stage)|unauthorized|not[^.\n]*eligible/i.test(message);
}

async function publicMintRevertIsPermanent({publicClient, plan}) {
  if (typeof publicClient.call !== 'function') return false;
  try {
    await publicClient.call({
      account: plan.account.address,
      to: plan.transaction.to,
      data: plan.transaction.data,
      value: plan.transaction.value,
    });
    return false;
  } catch (error) {
    const message = error instanceof Error
      ? `${error.shortMessage || ''} ${error.message || ''}`.trim()
      : String(error);
    return isPermanentPublicMintFailure(message);
  }
}

async function readOpenSeaSigningContext({preview, plan, nonceAllocator = null}) {
  const configuredGasPriceWei = protectionValue(preview.protections, 'gasPriceWei');
  const [rawFees, nonce, balance] = await Promise.all([
    currentFeeRequest(preview.publicClient),
    nonceAllocator
      ? Promise.resolve(null)
      : readOpenSeaNonceBaseline(preview.publicClient, plan.account.address),
    preview.publicClient.getBalance({address: plan.account.address}),
  ]);
  const fees = applyGasPriceOverride(rawFees, configuredGasPriceWei);
  return {fees, nonce, balance, readAt: performance.now()};
}

async function signOpenSeaWalletPlan({
  preview,
  plan,
  maxGasPriceWei,
  signal,
  signingContextPromise = null,
  nonceAllocator = null,
}) {
  const prefetched = !nonceAllocator && signingContextPromise ? await signingContextPromise : null;
  if (prefetched && !prefetched.context) {
    throw prefetched.error || new Error('Unable to prefetch gas, nonce, and wallet balance.');
  }
  const context = prefetched?.context || await readOpenSeaSigningContext({preview, plan, nonceAllocator});
  const {fees, balance} = context;
  if (maxGasPriceWei !== null && fees.reservationFeePerGas > maxGasPriceWei) {
    throw new Error('Current gas price exceeds the sniper limit before signing.');
  }
  const required = plan.transaction.value + plan.gasLimit * fees.reservationFeePerGas;
  if (balance < required) {
    throw new Error(
      `Insufficient balance before signing: ${formatEther(balance)} ETH available, ${formatEther(required)} ETH reserved.`,
    );
  }
  const nonce = context.nonce ?? await nonceAllocator.take();
  const request = {
    chainId: preview.chain?.id ?? preview.chainConfig?.chainId,
    type: fees.type,
    nonce,
    gas: plan.gasLimit,
    to: plan.transaction.to,
    data: plan.transaction.data,
    value: plan.transaction.value,
    ...(fees.type === 'eip1559'
      ? {maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas}
      : {gasPrice: fees.gasPrice}),
  };
  let serializedTransaction;
  try {
    serializedTransaction = await plan.account.signTransaction(request);
  } catch (error) {
    if (context.nonce === null && nonceAllocator) await nonceAllocator.release(nonce);
    throw error;
  }
  throwIfAborted(signal);
  return {plan, request, serializedTransaction, nonce};
}

export async function executeScheduledOpenSeaWalletPlan({
  preview,
  plan,
  contractAddress,
  scheduledAt,
  signLeadMs = 1500,
  broadcastLeadMs = 150,
  retry = {maxAttempts: 1, delayMs: 0},
  waitForTarget = waitForChainTimestamp,
  sleep = abortableSleep,
  signingContextPromise = null,
  nonceAllocator = null,
  signal = null,
  onStage = () => {},
  onWallet = () => {},
}) {
  const startedAt = performance.now();
  const targetMs = Date.parse(scheduledAt);
  if (!Number.isFinite(targetMs)) throw new Error('Scheduled OpenSea Mint time is invalid.');
  const maxGasPriceWei = protectionValue(preview.protections, 'maxGasPriceWei');
  const maxAttempts = Math.max(1, Number(retry?.maxAttempts || 1));
  const retryDelayMs = Math.max(0, Number(retry?.delayMs || 0));
  let item = null;
  let lastHash = null;
  let activeSigningContextPromise = signingContextPromise;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAborted(signal);
    try {
      if (!item) {
        await waitForTarget({publicClient: preview.publicClient, targetMs: targetMs - signLeadMs, signal});
        throwIfAborted(signal);
        onStage('signing');
        const signedAt = performance.now();
        item = await signOpenSeaWalletPlan({
          preview,
          plan,
          maxGasPriceWei,
          signal,
          signingContextPromise: activeSigningContextPromise,
          nonceAllocator,
        });
        item.signedAt = signedAt;
        item.signedAtIso = new Date().toISOString();
        onWallet({plan, status: 'signed', nonce: item.nonce, attempt});
      }
      await waitForTarget({publicClient: preview.publicClient, targetMs: targetMs - broadcastLeadMs, signal});
      throwIfAborted(signal);
      onStage('broadcasting');
      const broadcastStartedAt = performance.now();
      const broadcastStartedIso = new Date().toISOString();
      let broadcastAt = null;
      let broadcastAtIso = null;
      const submission = await submitOpenSeaRawTransaction({
        publicClient: preview.publicClient,
        item,
        onSubmitted(hash) {
          lastHash = hash;
          broadcastAt = performance.now();
          broadcastAtIso = new Date().toISOString();
          onWallet({plan, status: 'sending', hash, attempt});
        },
      });
      const {hash, receipt} = submission;
      lastHash = hash;
      if (broadcastAt === null) {
        broadcastAt = performance.now();
        broadcastAtIso = new Date().toISOString();
      }
      if (!receipt && submission.confirmationPending) {
        const acceptedAt = performance.now();
        const acceptedAtIso = new Date().toISOString();
        const result = {
          address: plan.account.address,
          hash,
          nonce: item.nonce,
          status: 'confirmation_pending',
          accepted: true,
          blockNumber: null,
          valueEth: formatEther(plan.transaction.value),
          requoted: false,
          tokenIds: [],
          mintedAt: null,
          chainTimestamp: null,
          attempts: attempt,
          reconciled: true,
          openSeaStageIdentity: plan.openSeaStageIdentity || null,
          observation: submission.observation,
          timing: {
            revalidateMs: Math.round((item.signedAt || startedAt) - startedAt),
            broadcastMs: Math.round(broadcastAt - broadcastStartedAt),
            totalMs: Math.round(acceptedAt - startedAt),
          },
          timestamps: {
            signedAt: item.signedAtIso || null,
            broadcastStartedAt: broadcastStartedIso,
            broadcastSubmittedAt: broadcastAtIso,
            acceptedAt: acceptedAtIso,
          },
        };
        onWallet({plan, status: 'confirmation_pending', result});
        return {type: 'confirmation_pending', plan, result, accepted: true, nonceBlocked: false};
      }
      if (receipt.status === 'success') {
        const confirmedAt = performance.now();
        const confirmedAtIso = new Date().toISOString();
        const mintTime = await resolveReceiptMintTime(preview.publicClient, receipt, confirmedAtIso);
        const result = {
          address: plan.account.address,
          hash,
          status: 'confirmed',
          blockNumber: receipt.blockNumber.toString(),
          valueEth: formatEther(plan.transaction.value),
          requoted: false,
          tokenIds: extractMintedErc721Tokens(receipt, contractAddress, plan.account.address),
          mintedAt: mintTime.mintedAt,
          chainTimestamp: mintTime.chainTimestamp,
          attempts: attempt,
          reconciled: submission.reconciled,
          openSeaStageIdentity: plan.openSeaStageIdentity || null,
          timing: {
            revalidateMs: Math.round((item.signedAt || startedAt) - startedAt),
            broadcastMs: Math.round(broadcastAt - broadcastStartedAt),
            confirmMs: Math.round(confirmedAt - broadcastAt),
            totalMs: Math.round(confirmedAt - startedAt),
          },
          timestamps: {
            signedAt: item.signedAtIso || null,
            broadcastStartedAt: broadcastStartedIso,
            broadcastSubmittedAt: broadcastAtIso,
            confirmedAt: confirmedAtIso,
          },
        };
        onWallet({plan, status: 'confirmed', result});
        return {type: 'confirmed', plan, result};
      }
      if (attempt >= maxAttempts) {
        const error = new Error(`Transaction reverted: ${hash}`);
        error.code = 'MINT_REVERTED';
        error.hash = hash;
        throw error;
      }
      onWallet({plan, status: 'retrying', error: `Transaction reverted; preparing retry ${attempt + 1}/${maxAttempts}.`, hash, attempt});
      if (retryDelayMs) await sleep(retryDelayMs, signal);
      item = null;
      activeSigningContextPromise = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error?.code === 'MINT_SUBMISSION_UNKNOWN') {
        nonceAllocator?.block(error);
        const failed = {
          type: 'failed',
          plan,
          error: message,
          code: error.code,
          hash: error.hash,
          nonce: error.nonce,
          nonceBlocked: true,
          observation: error.observation,
          openSeaStageIdentity: plan.openSeaStageIdentity || null,
        };
        onWallet({
          plan,
          status: 'failed',
          error: message,
          hash: error.hash,
          nonce: error.nonce,
          nonceBlocked: true,
        });
        return failed;
      }
      const hasBroadcastHash = Boolean(error?.hash);
      const retryable = !hasBroadcastHash && attempt < maxAttempts;
      if (retryable && attempt < maxAttempts) {
        onWallet({plan, status: 'retrying', error: `Mint attempt ${attempt} failed; retry ${attempt + 1}/${maxAttempts}: ${message}`, ...(error?.hash ? {hash: error.hash} : {}), attempt});
        if (retryDelayMs) await sleep(retryDelayMs, signal);
        if (!item) activeSigningContextPromise = null;
        continue;
      }
      if (!hasBroadcastHash && item?.nonce !== undefined && nonceAllocator) {
        await nonceAllocator.release(item.nonce);
      }
      onWallet({plan, status: 'failed', error: message, ...(error?.hash ? {hash: error.hash} : {})});
      return {
        type: 'failed',
        plan,
        error: message,
        ...(error?.code ? {code: error.code} : {}),
        ...(error?.hash ? {hash: error.hash} : {}),
        openSeaStageIdentity: plan.openSeaStageIdentity || null,
      };
    }
  }
  return {type: 'failed', plan, error: 'Mint retry attempts exhausted.', ...(lastHash ? {hash: lastHash} : {})};
}

function pollingMinimum(preview) {
  return Math.max(1, Number(preview.protections?.minEligibleWallets || 0));
}

export function assertOpenSeaCredentialMinimum(acquiredCount, minimum) {
  if (Number(acquiredCount) < Number(minimum)) {
    throw new Error(`OpenSea returned credentials for ${acquiredCount} wallet(s); the sniper minimum is ${minimum}.`);
  }
}

export async function executeScheduledOpenSeaMintPlans({
  preview,
  plans,
  contractAddress,
  scheduledAt,
  preflightLeadMs,
  signLeadMs = 1500,
  broadcastLeadMs = 150,
  retry = {maxAttempts: 1, delayMs: 0},
  opensea,
  seaDropAddress,
  credentialPolling,
  onStage = () => {},
  onWallet = () => {},
  fetchCatalog = fetchOpenSeaDropCatalog,
  fetchRoutes = fetchOpenSeaWalletMintRoutes,
  executeWalletPlan = executeScheduledOpenSeaWalletPlan,
  workerCount = 10,
  waitForTarget = waitForChainTimestamp,
  sleep = abortableSleep,
  now = () => Date.now(),
  signal = null,
  env = process.env,
  fetchImpl = fetch,
}) {
  throwIfAborted(signal);
  const targetMs = Date.parse(scheduledAt);
  if (!Number.isFinite(targetMs)) throw new Error('Scheduled OpenSea Mint time is invalid.');
  const stageContext = {
    chainId: preview.chain?.id ?? preview.chainConfig?.chainId,
    contractAddress,
  };
  const armedStageByPlan = new Map();
  for (const plan of plans) {
    const stageUuid = plan.openSeaStageUuid || plan.openSeaStage?.uuid || preview.openSeaStage?.uuid;
    const catalogStage = matchingOpenSeaStage(preview.openSeaCatalog, stageUuid);
    const armedStage = plan.openSeaStage || catalogStage;
    if (!stageIdentityMatches(armedStage, catalogStage, stageContext)) {
      throw new Error('The armed OpenSea stage no longer matches the confirmed preview. Review the stage and arm a new task.');
    }
    armedStageByPlan.set(plan, armedStage);
  }

  await waitForTarget({publicClient: preview.publicClient, targetMs: targetMs - preflightLeadMs, signal});
  throwIfAborted(signal);
  onStage('preflighting');
  const refreshedCatalog = await fetchCatalog({
    opensea,
    chainIdentifier: preview.chainConfig.chainIdentifier,
    contractAddress,
    slug: preview.openSeaCatalog.slug,
    signal,
    fetchImpl,
  });
  throwIfAborted(signal);
  const refreshedStageByPlan = new Map();
  for (const plan of plans) {
    const armedStage = armedStageByPlan.get(plan);
    const refreshedStage = matchingOpenSeaStage(refreshedCatalog, armedStage.uuid);
    if (!stageIdentityMatches(armedStage, refreshedStage, stageContext)) {
      throw new Error('The armed OpenSea stage changed after confirmation. Review the stage and arm a new task.');
    }
    refreshedStageByPlan.set(plan, refreshedStage);
  }
  const supply = catalogSupply(refreshedCatalog);
  const configuredGasPriceWei = protectionValue(preview.protections, 'gasPriceWei');
  const [rpcGasPrice, balances] = await Promise.all([
    preview.publicClient.getGasPrice(),
    Promise.all(plans.map((plan) => preview.publicClient.getBalance({address: plan.account.address}))),
  ]);
  const gasPrice = configuredGasPriceWei ?? rpcGasPrice;
  throwIfAborted(signal);
  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index];
    plan.balance = balances[index];
    plan.gasPrice = gasPrice;
    plan.estimatedFee = plan.gasLimit * gasPrice;
    plan.estimatedTotal = plan.transaction.value + plan.estimatedFee;
    if (plan.balance < plan.estimatedTotal) {
      onWallet({plan, status: 'failed', error: 'Insufficient balance at the final OpenSea stage preflight.'});
    } else {
      onWallet({plan, status: 'preflighted'});
    }
  }
  const fundedPlans = plans.filter((plan) => plan.balance >= plan.estimatedTotal);
  if (!fundedPlans.length) throw new Error('No wallet passed the final OpenSea stage balance check.');
  enforceSniperProtections({
    readyPlans: fundedPlans,
    inspection: {supplyLeft: supply.supplyLeft?.toString() ?? null},
    protections: preview.protections,
    quantity: preview.quantity,
  });

  // Start credential polling as soon as the final preflight is complete. The
  // OpenSea route may be unavailable until the stage opens, so polling early
  // gives the API time to produce calldata before signing/broadcasting.
  onStage('credential_polling');
  const pending = fundedPlans.map((plan) => ({
    account: plan.account,
    placeholder: plan,
    stage: refreshedStageByPlan.get(plan),
    reason: 'Waiting for OpenSea to activate the selected stage.',
  }));
  for (const item of pending) onWallet({plan: item.placeholder, status: 'credential_waiting'});
  const minimum = pollingMinimum(preview);

  // Credential acquisition is a hard barrier. No wallet is signed or broadcast
  // until every poller reaches a terminal state and the configured wallet
  // minimum can be checked against the complete result set.
  const workerLimit = Math.max(1, Math.min(Number(workerCount) || 10, fundedPlans.length));
  const outcomes = await mapConcurrent(pending, workerLimit, async (item) => {
    const deadline = now() + credentialPolling.timeoutMs;
    let reason = item.reason;
    while (now() <= deadline) {
      throwIfAborted(signal);
      let route = null;
      let nextDelayMs = credentialPolling.intervalMs;
      try {
        const routes = await fetchRoutes({
          opensea,
          catalog: {...refreshedCatalog, activeStageUuid: item.stage.uuid},
          accounts: [item.account],
          quantity: preview.quantity,
          seaDropAddress,
          concurrency: 1,
          signal,
          fetchImpl,
        });
        route = routes.find((candidate) => candidate.address?.toLowerCase() === item.account.address.toLowerCase()) || routes[0] || null;
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      }
      if (route?.status === 'ready') {
        try {
          const plan = await buildOpenSeaScheduledPlan({
            publicClient: preview.publicClient,
            account: item.account,
            route,
            stage: item.stage,
            chainId: stageContext.chainId,
            contractAddress,
            quantity: preview.quantity,
            seaDropAddress,
            gasLimit: item.placeholder.gasLimit,
            balance: item.placeholder.balance,
            gasPrice: item.placeholder.gasPrice,
          });
          onWallet({plan, status: 'credential_ready'});
          return {type: 'credential_ready', plan};
        } catch (error) {
          reason = error instanceof Error ? error.message : String(error);
          onWallet({plan: item.placeholder, status: 'failed', error: reason});
          return {type: 'failed', plan: item.placeholder, error: reason};
        }
      }
      if (route?.status === 'ineligible') {
        reason = route.reason || 'OpenSea confirmed this wallet is not eligible for the active stage.';
        onWallet({plan: item.placeholder, status: 'failed', error: reason});
        return {type: 'failed', plan: item.placeholder, error: reason};
      }
      if (route?.status === 'rate_limited' && route.retryAfterMs) {
        nextDelayMs = Math.max(nextDelayMs, route.retryAfterMs);
      }
      reason = route?.reason || reason || 'OpenSea Mint credentials are not available yet.';
      if (now() >= deadline) break;
      await sleep(Math.min(nextDelayMs, Math.max(0, deadline - now())), signal);
    }
    const error = `OpenSea credential polling timed out: ${reason}`;
    onWallet({plan: item.placeholder, status: 'failed', error});
    return {type: 'failed', plan: item.placeholder, error};
  });
  const readyEntries = outcomes
    .map((outcome, index) => ({outcome, index}))
    .filter(({outcome}) => outcome.type === 'credential_ready');
  const acquiredWalletCount = new Set(readyEntries.map(({outcome}) => (
    outcome.plan.account.address.toLowerCase()
  ))).size;
  assertOpenSeaCredentialMinimum(acquiredWalletCount, minimum);

  const groups = new Map();
  for (const entry of readyEntries) {
    const plan = entry.outcome.plan;
    const address = plan.account.address.toLowerCase();
    const group = groups.get(address) || {
      address,
      walletAddress: plan.account.address,
      entries: [],
      stageGroups: new Map(),
    };
    group.entries.push(entry);
    const identity = plan.openSeaStageIdentity;
    const identityKey = JSON.stringify(identity);
    const stageGroup = group.stageGroups.get(identityKey) || {identity, planCount: 0};
    stageGroup.planCount += 1;
    group.stageGroups.set(identityKey, stageGroup);
    groups.set(address, group);
  }
  const executionGroups = [...groups.values()].flatMap((group) => (
    [...group.stageGroups.values()].map((stageGroup) => ({
      walletAddress: group.walletAddress,
      openSeaStageIdentity: stageGroup.identity,
      planCount: stageGroup.planCount,
      nonceScope: 'wallet',
    }))
  ));
  const finalOutcomes = [...outcomes];
  await mapConcurrent([...groups.values()], workerLimit, async (group) => {
    const nonceAllocator = createOpenSeaNonceAllocator(preview.publicClient, group.address);
    for (const entry of group.entries) {
      const blockedBy = nonceAllocator.blocked();
      if (blockedBy) {
        const error = `Skipped because an earlier OpenSea submission for this wallet has unknown status: ${blockedBy.message}`;
        const skipped = {
          type: 'failed',
          plan: entry.outcome.plan,
          error,
          code: 'MINT_NONCE_BLOCKED',
          nonceBlocked: true,
          openSeaStageIdentity: entry.outcome.plan.openSeaStageIdentity || null,
          ...(blockedBy.hash ? {blockedByHash: blockedBy.hash} : {}),
        };
        onWallet({plan: entry.outcome.plan, status: 'failed', error, nonceBlocked: true});
        finalOutcomes[entry.index] = skipped;
        continue;
      }
      const result = await executeWalletPlan({
        preview,
        plan: entry.outcome.plan,
        contractAddress,
        scheduledAt,
        signLeadMs,
        broadcastLeadMs,
        retry,
        waitForTarget,
        sleep,
        nonceAllocator,
        signal,
        onStage,
        onWallet,
        env,
      });
      finalOutcomes[entry.index] = result;
      if (result?.nonceBlocked && !nonceAllocator.blocked()) {
        const error = new Error(result.error || 'OpenSea submission status is unknown.');
        error.hash = result.hash;
        nonceAllocator.block(error);
      }
    }
  });
  return {
    inspection: {supplyLeft: supply.supplyLeft?.toString() ?? null},
    executionGroups,
    results: finalOutcomes,
  };
}

export async function executeScheduledMintPlans({
  preview,
  plans,
  contractAddress,
  scheduledAt,
  preflightLeadMs,
  signLeadMs = 1500,
  broadcastLeadMs = 150,
  broadcastConcurrency = 100,
  receiptConcurrency = 100,
  retry = {maxAttempts: 1, delayMs: 0},
  waitForTarget = waitForChainTimestamp,
  sleep = abortableSleep,
  signal = null,
  onStage = () => {},
  onWallet = () => {},
  env = process.env,
}) {
  throwIfAborted(signal);
  const targetMs = Date.parse(scheduledAt);
  if (!Number.isFinite(targetMs)) throw new Error('Scheduled Mint time is invalid.');

  await waitForTarget({publicClient: preview.publicClient, targetMs: targetMs - preflightLeadMs, signal});
  throwIfAborted(signal);
  onStage('preflighting');
  const preflightAtIso = new Date().toISOString();
  const revalidateStartedAt = performance.now();
  const credentialMode = ['allowlist', 'signed'].includes(plans[0]?.directSeaDrop?.mode);
  const batch = credentialMode
    ? await revalidateSeaDropCredentialBatch({
      publicClient: preview.publicClient,
      plans,
      targetTimestamp: Math.floor(targetMs / 1000),
      env,
    })
    : await revalidateDirectSeaDropBatch({
      publicClient: preview.publicClient,
      plans,
      targetTimestamp: Math.floor(targetMs / 1000),
      env,
    });
  throwIfAborted(signal);
  for (const failure of batch.failedPlans) {
    onWallet({plan: failure.plan, status: 'failed', error: failure.message});
  }
  if (!batch.readyPlans.length) throw new Error('No wallet passed the scheduled Mint recheck.');
  const configuredGasPriceWei = protectionValue(preview.protections, 'gasPriceWei');
  const fees = applyGasPriceOverride(
    await currentFeeRequest(preview.publicClient),
    configuredGasPriceWei,
  );
  const maxGasPriceWei = protectionValue(preview.protections, 'maxGasPriceWei');
  if (maxGasPriceWei !== null && fees.reservationFeePerGas > maxGasPriceWei) {
    throw new Error('Current gas price exceeds the sniper limit at scheduled preflight.');
  }
  for (const plan of batch.readyPlans) {
    plan.gasPrice = fees.reservationFeePerGas;
    plan.estimatedFee = plan.gasLimit * fees.reservationFeePerGas;
    plan.estimatedTotal = plan.transaction.value + plan.estimatedFee;
  }
  enforceSniperProtections({
    readyPlans: batch.readyPlans,
    inspection: batch.inspection,
    protections: preview.protections,
    quantity: batch.readyPlans[0].directSeaDrop.quantity,
  });
  const preparedOutcomes = await mapConcurrent(batch.readyPlans, preview.concurrency, async (plan) => {
    try {
      throwIfAborted(signal);
      const [nonce, balance] = await Promise.all([
        preview.publicClient.getTransactionCount({address: plan.account.address, blockTag: 'pending'}),
        preview.publicClient.getBalance({address: plan.account.address}),
      ]);
      const required = plan.transaction.value + plan.gasLimit * fees.reservationFeePerGas;
      throwIfAborted(signal);
      if (balance < required) {
        throw new Error(
          `Insufficient balance at scheduled recheck: ${formatEther(balance)} ETH available, ${formatEther(required)} ETH reserved.`,
        );
      }
  const request = {
        chainId: preview.chain.id,
        type: fees.type,
        nonce,
        gas: plan.gasLimit,
        to: plan.transaction.to,
        data: plan.transaction.data,
        value: plan.transaction.value,
        ...feeRequestFields(fees),
      };
      onWallet({plan, status: 'preflighted', nonce, required, at: preflightAtIso});
      return {type: 'ready', plan, request};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onWallet({plan, status: 'failed', error: message});
      return {type: 'failed', plan, error: message};
    }
  });
  const prepared = preparedOutcomes.filter((item) => item.type === 'ready');
  if (!prepared.length) {
    const reasons = preparedOutcomes
      .filter((item) => item.type === 'failed' && item.error)
      .map((item) => `${item.plan.account.address}: ${item.error}`)
      .join('; ');
    throw new Error(`No wallet passed balance, nonce, and fee preparation.${reasons ? ` ${reasons}` : ''}`);
  }
  const preparedAt = performance.now();

  // Every scheduled route signs at the configured lead boundary. All RPC reads
  // were prepared at preflight, so this boundary only performs local signing.
  await waitForTarget({publicClient: preview.publicClient, targetMs: targetMs - signLeadMs, signal});
  throwIfAborted(signal);
  const batchChanged = batch.changed;
  onStage('signing');
  const signingStartedIso = new Date().toISOString();
  const signedOutcomes = await Promise.all(prepared.map(async (item) => {
    try {
      throwIfAborted(signal);
      // Use the nonce, balance, and fee snapshot prepared during preflight so
      // the final signing and broadcast windows stay free of RPC reads.
      const request = item.request;
      const serializedTransaction = await item.plan.account.signTransaction(request);
      throwIfAborted(signal);
      const signedAtIso = new Date().toISOString();
      onWallet({plan: item.plan, status: 'signed', nonce: request.nonce, at: signedAtIso});
      return {...item, type: 'signed', request, serializedTransaction, signedAtIso};
    } catch (error) {
      throwIfAborted(signal);
      const message = error instanceof Error ? error.message : String(error);
      onWallet({plan: item.plan, status: 'failed', error: message});
      return {...item, type: 'failed', error: message};
    }
  }));
  const signed = signedOutcomes.filter((item) => item.type === 'signed');
  if (!signed.length) throw new Error('No scheduled Mint transaction could be signed.');

  await waitForTarget({publicClient: preview.publicClient, targetMs: targetMs - broadcastLeadMs, signal});
  throwIfAborted(signal);
  onStage('broadcasting');
  const broadcastStartedAt = performance.now();
  const broadcastStartedIso = new Date().toISOString();
  const maxAttempts = Math.max(1, Number(retry?.maxAttempts || 1));
  const retryDelayMs = Math.max(0, Number(retry?.delayMs || 0));
  const credentialModeForRetry = ['allowlist', 'signed'].includes(batch.readyPlans[0]?.directSeaDrop?.mode);
  const sendWithLimit = createConcurrencyLimiter(Math.min(broadcastConcurrency, signed.length));
  const waitForReceiptWithLimit = createConcurrencyLimiter(Math.min(receiptConcurrency, signed.length));
  const results = await Promise.all(signed.map(async (initial) => {
    let item = initial;
    let lastHash = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      throwIfAborted(signal);
      let attemptHash = null;
      try {
        attemptHash = await sendWithLimit(
          () => broadcastSignedTransaction(preview.publicClient, item.serializedTransaction),
        );
        lastHash = attemptHash;
        const broadcastAt = performance.now();
        const broadcastAtIso = new Date().toISOString();
        onWallet({plan: item.plan, status: 'sending', hash: attemptHash, attempt, at: broadcastAtIso});
        let receipt;
        try {
          receipt = await waitForReceiptWithLimit(
            () => preview.publicClient.waitForTransactionReceipt({hash: attemptHash}),
          );
        } catch (error) {
          // A receipt timeout leaves the transaction outcome unknown. Never
          // create a second nonce until the original hash is resolved.
          const message = error instanceof Error ? error.message : String(error);
          onWallet({plan: item.plan, status: 'failed', error: `Receipt status is unknown for ${attemptHash}: ${message}`, hash: attemptHash});
          return {type: 'failed', plan: item.plan, error: message, hash: attemptHash};
        }
        if (receipt.status === 'success') {
          const confirmedAt = performance.now();
          const confirmedAtIso = new Date().toISOString();
          const mintTime = await resolveReceiptMintTime(preview.publicClient, receipt, confirmedAtIso);
          const result = {
            address: item.plan.account.address,
            hash: attemptHash,
            status: 'confirmed',
            blockNumber: receipt.blockNumber.toString(),
            valueEth: formatEther(item.plan.transaction.value),
            requoted: batchChanged,
            tokenIds: extractMintedErc721Tokens(receipt, contractAddress, item.plan.account.address),
            mintedAt: mintTime.mintedAt,
            chainTimestamp: mintTime.chainTimestamp,
            attempts: attempt,
            timing: {
              revalidateMs: Math.round(preparedAt - revalidateStartedAt),
              broadcastMs: Math.round(broadcastAt - broadcastStartedAt),
              confirmMs: Math.round(confirmedAt - broadcastAt),
              totalMs: Math.round(confirmedAt - revalidateStartedAt),
            },
            timestamps: {
              preflightAt: preflightAtIso,
              signingStartedAt: signingStartedIso,
              signedAt: item.signedAtIso || null,
              broadcastStartedAt: broadcastStartedIso,
              broadcastSubmittedAt: broadcastAtIso,
              confirmedAt: confirmedAtIso,
            },
          };
          onWallet({plan: item.plan, status: 'confirmed', result});
          return {type: 'confirmed', plan: item.plan, result};
        }
        if (attempt >= maxAttempts) {
          const message = `Transaction reverted: ${attemptHash}`;
          onWallet({plan: item.plan, status: 'failed', error: message, hash: attemptHash});
          return {type: 'failed', plan: item.plan, error: message, hash: attemptHash};
        }
        if (!credentialModeForRetry && await publicMintRevertIsPermanent({publicClient: preview.publicClient, plan: item.plan})) {
          const message = `Transaction reverted permanently: ${attemptHash}`;
          onWallet({plan: item.plan, status: 'failed', error: message, hash: attemptHash});
          return {type: 'failed', plan: item.plan, error: message, hash: attemptHash};
        }
        onWallet({plan: item.plan, status: 'retrying', error: `Transaction reverted; preparing retry ${attempt + 1}/${maxAttempts}.`, hash: attemptHash, attempt});
        if (retryDelayMs) await sleep(retryDelayMs, signal);
        // A reverted early broadcast consumed the nonce. Wait for the stage
        // boundary, then revalidate and sign a fresh transaction with a new nonce.
        item = await rebuildScheduledSignedItem({
          preview,
          item,
          targetMs,
          credentialMode: credentialModeForRetry,
          feesOverride: feesFromRequest(item.request),
          waitForTarget,
          signal,
          env,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt < maxAttempts && !attemptHash) {
          if (isNonceBroadcastError(message)) {
            try {
              item = await resignScheduledItemWithFreshNonce({preview, item, signal});
            } catch (nonceError) {
              const nonceMessage = nonceError instanceof Error ? nonceError.message : String(nonceError);
              onWallet({plan: item.plan, status: 'failed', error: nonceMessage});
              return {type: 'failed', plan: item.plan, error: nonceMessage};
            }
          }
          onWallet({plan: item.plan, status: 'retrying', error: `Broadcast failed; retry ${attempt + 1}/${maxAttempts}: ${message}`, attempt});
          if (retryDelayMs) await sleep(retryDelayMs, signal);
          continue;
        }
        onWallet({plan: item.plan, status: 'failed', error: message, ...(attemptHash ? {hash: attemptHash} : {})});
        return {type: 'failed', plan: item.plan, error: message, ...(attemptHash ? {hash: attemptHash} : {})};
      }
    }
    return {type: 'failed', plan: item.plan, error: 'Mint retry attempts exhausted.', ...(lastHash ? {hash: lastHash} : {})};
  }));
  return {inspection: batch.inspection, results};
}

// Single wiring surface for the routes. Chains, RPC endpoints and signers all
// arrive by injection: this module reads env only for OpenSea/SeaDrop settings
// and never holds a private key, so the host keeps sole ownership of the key
// store (see server/nft-management.js for the same arrangement).
export function createOpenSeaMintService({
  clientForChain,
  writeRpcForChain,
  accountForWallet,
  env = process.env,
  fetchImpl = fetch,
  clock = Date.now,
  // Allowlist eligibility stays at the edge so callers can inject the wallet
  // authorization flow without coupling the mint planner to session storage.
  fetchWalletEligibilities = null,
} = {}) {
  if (typeof clientForChain !== 'function') throw new TypeError('clientForChain is required');
  if (typeof writeRpcForChain !== 'function') throw new TypeError('writeRpcForChain is required');
  const appConfig = loadAppConfig(env);

  // accountForWallet may read the key store from disk, so it is awaited.
  // Already-built signers pass through untouched, which is what the tests use.
  async function accountsFor(wallets = []) {
    const resolved = [];
    for (const wallet of wallets) {
      if (wallet && typeof wallet.signTransaction === 'function') {
        resolved.push(wallet);
        continue;
      }
      if (typeof accountForWallet !== 'function') {
        throw new Error('createOpenSeaMintService requires accountForWallet to resolve wallet ids.');
      }
      const account = await accountForWallet(wallet);
      if (!account?.address) throw new Error(`No signer is available for wallet ${String(wallet)}.`);
      resolved.push(account);
    }
    return resolved;
  }

  function chainIdentifier(chainId) {
    return openSeaChainIdentifier(chainId, env);
  }

  async function resolveTarget({input, chainId = null, supportedChainIdentifiers = []}) {
    return resolveNftTarget({
      input,
      preferredChainIdentifier: chainId === null ? null : chainIdentifier(chainId),
      supportedChainIdentifiers,
      opensea: appConfig.opensea,
      fetchImpl,
    });
  }

  async function fetchDropCatalog({chainId, contractAddress, slug = null, signal = null}) {
    return fetchOpenSeaDropCatalog({
      opensea: appConfig.opensea,
      chainIdentifier: chainIdentifier(chainId),
      contractAddress: getAddress(contractAddress),
      slug,
      signal,
      fetchImpl,
    });
  }

  async function fetchWalletMintRoutes({
    catalog,
    wallets = [],
    accounts = null,
    quantity = 1n,
    concurrency = 2,
    signal = null,
  }) {
    return fetchOpenSeaWalletMintRoutes({
      opensea: appConfig.opensea,
      catalog,
      accounts: accounts || await accountsFor(wallets),
      quantity,
      seaDropAddress: appConfig.seaDrop.address,
      concurrency,
      signal,
      fetchImpl,
    });
  }

  // Backs the resolve route: on-chain SeaDrop state plus whatever OpenSea will
  // tell us. Each OpenSea lookup is isolated because none of them is required
  // for a public mint, and a rate limit on one must not blank the whole report.
  async function inspect({
    chainId,
    contractAddress,
    wallets = [],
    accounts = null,
    quantity = 1n,
    credentials = null,
    slug = null,
    signal = null,
  }) {
    const publicClient = readClientFor(chainId, clientForChain);
    const resolvedAccounts = accounts || await accountsFor(wallets);
    let catalog = null;
    let catalogError = null;
    try {
      catalog = await fetchDropCatalog({chainId, contractAddress, slug, signal});
    } catch (error) {
      catalogError = error instanceof Error ? error.message : String(error);
    }
    let walletRoutes = [];
    let walletEligibilities = [];
    if (catalog && resolvedAccounts.length) {
      try {
        walletRoutes = await fetchWalletMintRoutes({catalog, accounts: resolvedAccounts, quantity, signal});
      } catch {
        // Route calldata is an optimisation; the direct SeaDrop path still works.
      }
      if (typeof fetchWalletEligibilities === 'function') {
        try {
          walletEligibilities = await fetchWalletEligibilities({
            opensea: appConfig.opensea,
            catalog,
            accounts: resolvedAccounts,
            fetchImpl,
          });
        } catch {
          // Eligibility needs a wallet signature per address; treat it as advisory.
        }
      }
    }
    return inspectNftIntelligence({
      publicClient,
      contractAddress,
      accounts: resolvedAccounts,
      quantity,
      credentials,
      openSeaCatalog: catalog,
      openSeaCatalogError: catalogError,
      openSeaWalletRoutes: walletRoutes,
      openSeaWalletEligibilities: walletEligibilities,
      env,
    });
  }

  async function preview({wallets = [], accounts = null, ...options}) {
    return previewMint({
      ...options,
      accounts: accounts || await accountsFor(wallets),
      clientForChain,
      writeRpcForChain,
      env,
      fetchImpl,
      clock,
    });
  }

  function executePlan(options) {
    return executeMintPlanWithRetry({
      maxAttempts: appConfig.mint.retry.maxAttempts,
      delayMs: appConfig.mint.retry.delayMs,
      ...options,
    });
  }

  function executeScheduled(options) {
    const {scheduling} = appConfig.mint;
    return executeScheduledMintPlans({
      preflightLeadMs: scheduling.preflightLeadMs,
      signLeadMs: scheduling.signLeadMs,
      broadcastLeadMs: scheduling.broadcastLeadMs,
      broadcastConcurrency: scheduling.publicBroadcastConcurrency,
      receiptConcurrency: scheduling.publicReceiptConcurrency,
      retry: appConfig.mint.retry,
      env,
      ...options,
    });
  }

  function executeScheduledOpenSea(options) {
    const {scheduling} = appConfig.mint;
    return executeScheduledOpenSeaMintPlans({
      preflightLeadMs: scheduling.preflightLeadMs,
      signLeadMs: scheduling.signLeadMs,
      broadcastLeadMs: scheduling.broadcastLeadMs,
      retry: appConfig.mint.retry,
      opensea: appConfig.opensea,
      seaDropAddress: appConfig.seaDrop.address,
      credentialPolling: appConfig.opensea.credentialPolling,
      workerCount: scheduling.workerCount,
      now: clock,
      env,
      fetchImpl,
      ...options,
    });
  }

  return {
    config: appConfig,
    chainIdentifier,
    accountsFor,
    resolveTarget,
    fetchDropCatalog,
    fetchWalletMintRoutes,
    inspect,
    preview,
    executePlan,
    executeScheduled,
    executeScheduledOpenSea,
  };
}
