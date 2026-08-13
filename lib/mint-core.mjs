import {
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  defineChain,
  encodeFunctionData,
  formatEther,
  getAddress,
  http,
  isAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {loadBarePrivateKeys, normalizePrivateKey} from './wallet-config.mjs';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const MINT_SIGNED_SELECTOR = '0x4b61cd6f';
export const SEADROP_MINT_PUBLIC_SELECTOR = '0x161ac21f';
export const DEFAULT_ROBINHOOD_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
export const DEFAULT_GRAPHQL_URL = 'https://gql.opensea.io/graphql';

export const MINT_ACTION_QUERY = `query MintActionTimelineQuery(
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
          to
          data
          value
          chain { networkId identifier gasLimitBufferMultiplier }
        }
      }
      ... on MintAction {
        relayerFulfillment { requestId sameChain crossChain }
        transactionSubmissionData {
          to
          data
          value
          chain { networkId identifier gasLimitBufferMultiplier }
        }
      }
    }
    errors { __typename }
  }
}`;

export const CHAIN_PRESETS = {
  hood: {
    chainIdentifier: 'robinhood',
    chainId: 4663,
    rpcUrl: DEFAULT_ROBINHOOD_RPC_URL,
    name: 'Robinhood Chain',
  },
  ethereum: {
    chainIdentifier: 'ethereum',
    chainId: 1,
    rpcUrl: 'https://ethereum-rpc.publicnode.com',
    name: 'Ethereum',
  },
};

export function parsePositiveInteger(value, name) {
  if (!/^[1-9]\d*$/.test(String(value))) {
    throw new Error(`${name} must be a positive integer`);
  }
  return BigInt(value);
}

export function parseConcurrency(value, name) {
  if (!/^\d+$/.test(String(value))) {
    throw new Error(`${name} must be a non-negative integer (0 means all wallets concurrently)`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is too large.`);
  return parsed;
}

export function loadAccounts(env = process.env) {
  const bareConfig = loadBarePrivateKeys({env});
  const singleKey = env.PRIVATE_KEY?.trim() || '';
  const listKey = env.PRIVATE_KEYS?.trim() || '';
  const indexedKeys = Object.entries(env)
    .map(([name, value]) => {
      const match = /^PRIVATE_KEY_(\d+)$/.exec(name);
      return match && value?.trim() ? {index: Number(match[1]), value: value.trim()} : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.index - right.index)
    .map(({value}) => value);

  if (bareConfig.invalidLines.length) {
    throw new Error(`Invalid .env wallet line${bareConfig.invalidLines.length === 1 ? '' : 's'}: ${bareConfig.invalidLines.join(', ')}. Enter one 64-character hexadecimal private key per line, without a name or 0x prefix.`);
  }

  const configuredSources = [bareConfig.keys.length && 'bare .env lines', singleKey && 'PRIVATE_KEY', listKey && 'PRIVATE_KEYS', indexedKeys.length && 'PRIVATE_KEY_N']
    .filter(Boolean);
  if (configuredSources.length > 1) {
    throw new Error(`Configure only one private-key source: ${configuredSources.join(', ')}.`);
  }

  const rawKeys = bareConfig.keys.length
    ? bareConfig.keys
    : listKey
      ? listKey.split(/[\s,]+/).filter(Boolean)
      : indexedKeys.length
        ? indexedKeys
        : singleKey
          ? [singleKey]
          : [];
  if (!rawKeys.length) {
    throw new Error('Missing private keys: enter one 64-character hexadecimal private key per line in .env.');
  }

  const accounts = rawKeys.map((privateKey, index) => {
    return privateKeyToAccount(normalizePrivateKey(privateKey, index));
  });
  const addresses = new Set(accounts.map(({address}) => address.toLowerCase()));
  if (addresses.size !== accounts.length) {
    throw new Error('Duplicate wallet address detected in private-key configuration.');
  }
  return accounts;
}

export function resolveChainConfig({chainKey, env = process.env} = {}) {
  const preset = chainKey && CHAIN_PRESETS[chainKey] ? CHAIN_PRESETS[chainKey] : null;
  const chainIdentifier = env.CHAIN_IDENTIFIER?.trim() || preset?.chainIdentifier || 'robinhood';
  const chainId = Number(env.CHAIN_ID?.trim() || preset?.chainId || '4663');
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error('CHAIN_ID must be a positive integer.');

  const configuredRpcUrl = env.RPC_URL?.trim();
  const rpcUrl = configuredRpcUrl || (
    chainIdentifier === 'robinhood' && chainId === 4663
      ? DEFAULT_ROBINHOOD_RPC_URL
      : preset?.rpcUrl || (() => {
        throw new Error('RPC_URL is required when using a chain other than Robinhood mainnet.');
      })()
  );

  return {
    chainKey: chainKey || (chainIdentifier === 'robinhood' ? 'hood' : chainIdentifier),
    chainIdentifier,
    chainId,
    rpcUrl,
    name: env.CHAIN_NAME?.trim() || preset?.name || chainIdentifier,
  };
}

export function buildChain({chainId, chainIdentifier, rpcUrl, name}) {
  return defineChain({
    id: chainId,
    name: name || chainIdentifier,
    nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
    rpcUrls: {
      default: {http: [rpcUrl]},
      public: {http: [rpcUrl]},
    },
  });
}

export function createClients({chainId, chainIdentifier, rpcUrl, name}) {
  const chain = buildChain({chainId, chainIdentifier, rpcUrl, name});
  const publicClient = createPublicClient({chain, transport: http(rpcUrl)});
  return {chain, publicClient, rpcUrl};
}

export async function mapConcurrent(items, configuredConcurrency, worker) {
  if (!items.length) return [];
  const limit = configuredConcurrency === 0
    ? items.length
    : Math.min(configuredConcurrency, items.length);
  const results = new Array(items.length);
  let cursor = 0;

  async function workerLoop() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({length: limit}, () => workerLoop()));
  return results;
}

export async function requestMintAction({graphqlUrl, accountAddress, contractAddress, quantity, tokenId, chainIdentifier}) {
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
    origin: 'https://opensea.io',
    referer: 'https://opensea.io/',
    'user-agent': process.env.USER_AGENT?.trim() || 'opensea-native-mint/1.0',
    'x-app-id': 'os2-web',
  };
  if (process.env.OPENSEA_COOKIES?.trim()) {
    headers.cookie = process.env.OPENSEA_COOKIES.trim();
  }

  const response = await fetch(graphqlUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      operationName: 'MintActionTimelineQuery',
      variables,
      query: MINT_ACTION_QUERY,
    }),
  });

  const bodyText = await response.text();
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new Error(`OpenSea GraphQL returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(`OpenSea GraphQL HTTP ${response.status}: ${JSON.stringify(body)}`);
  }

  const swap = body?.data?.swap;
  const topLevelErrors = Array.isArray(body?.errors) ? body.errors : [];
  if (!swap) {
    const details = topLevelErrors
      .map((error) => error?.message || error?.__typename)
      .filter(Boolean)
      .join('; ') || 'missing data.swap';
    throw new Error(`OpenSea returned no swap data: ${details}`);
  }
  const errors = swap?.errors ?? [];
  const actions = swap?.actions ?? [];
  const action = actions.find((candidate) => candidate?.transactionSubmissionData?.to && candidate?.transactionSubmissionData?.data);
  if (!action) {
    const names = errors
      .map((error) => error?.__typename)
      .filter(Boolean)
      .join(', ') || 'no executable action returned';
    throw new Error(`OpenSea returned no executable mint action: ${names}`);
  }

  return {action, variables, errors};
}

export function normalizeSubmission(action, {chainId, chainIdentifier}) {
  const submission = action.transactionSubmissionData;
  const relayer = action.relayerFulfillment;
  if (relayer && (relayer.crossChain === true || relayer.sameChain === false)) {
    throw new Error('OpenSea returned a cross-chain Relayer action; this script only accepts same-chain native ETH.');
  }

  if (submission.chain?.identifier && submission.chain.identifier !== chainIdentifier) {
    throw new Error(`Returned chain is ${submission.chain.identifier}, expected ${chainIdentifier}.`);
  }
  if (submission.chain?.networkId && Number(submission.chain.networkId) !== chainId) {
    throw new Error(`Returned chain id is ${submission.chain.networkId}, expected ${chainId}.`);
  }
  if (!isAddress(submission.to)) throw new Error('OpenSea returned an invalid transaction target.');
  if (!/^0x[0-9a-fA-F]*$/.test(submission.data) || submission.data.length < 10) {
    throw new Error('OpenSea returned invalid transaction calldata.');
  }

  return {
    to: getAddress(submission.to),
    data: submission.data,
    value: BigInt(submission.value ?? '0'),
    chain: submission.chain,
    actionType: action.__typename,
    isSeaDropMintSigned: submission.data.slice(0, 10).toLowerCase() === MINT_SIGNED_SELECTOR,
  };
}

export function serializePlan(plan) {
  return {
    address: plan.account.address,
    transaction: {
      to: plan.transaction.to,
      data: plan.transaction.data,
      value: plan.transaction.value.toString(),
      actionType: plan.transaction.actionType,
      isSeaDropMintSigned: plan.transaction.isSeaDropMintSigned,
    },
    errors: plan.errors,
    balance: plan.balance.toString(),
    estimatedGas: plan.estimatedGas.toString(),
    gasLimit: plan.gasLimit.toString(),
    gasPrice: plan.gasPrice.toString(),
    estimatedFee: plan.estimatedFee.toString(),
    estimatedTotal: plan.estimatedTotal.toString(),
    balanceEth: formatEther(plan.balance),
    valueEth: formatEther(plan.transaction.value),
    estimatedFeeEth: formatEther(plan.estimatedFee),
    estimatedTotalEth: formatEther(plan.estimatedTotal),
  };
}

export async function buildTransactionPlan({
  publicClient,
  account,
  contractAddress,
  quantity,
  tokenId,
  chainIdentifier,
  chainId,
  graphqlUrl,
  gasLimitBufferBps,
}) {
  const {action, errors} = await requestMintAction({
    graphqlUrl,
    accountAddress: account.address,
    contractAddress,
    quantity,
    tokenId,
    chainIdentifier,
  });
  const transaction = normalizeSubmission(action, {chainId, chainIdentifier});
  const balance = await publicClient.getBalance({address: account.address});
  const estimatedGas = await publicClient.estimateGas({
    account,
    to: transaction.to,
    data: transaction.data,
    value: transaction.value,
  });
  const gasBufferBps = BigInt(String(gasLimitBufferBps ?? process.env.GAS_LIMIT_BUFFER_BPS?.trim() ?? '12000'));
  if (gasBufferBps < 10000n || gasBufferBps > 20000n) throw new Error('GAS_LIMIT_BUFFER_BPS must be between 10000 and 20000.');
  const gasLimit = estimatedGas * gasBufferBps / 10000n;
  const gasPrice = await publicClient.getGasPrice();
  const estimatedFee = gasLimit * gasPrice;
  const estimatedTotal = transaction.value + estimatedFee;

  return {
    account,
    transaction,
    errors,
    balance,
    estimatedGas,
    gasLimit,
    gasPrice,
    estimatedFee,
    estimatedTotal,
  };
}

export async function requoteSeaDropPlan({publicClient, plan}) {
  const {transaction} = plan;
  if (!transaction?.data?.toLowerCase().startsWith(SEADROP_MINT_PUBLIC_SELECTOR)) {
    return {changed: false, oldValue: transaction.value, newValue: transaction.value};
  }

  const words = transaction.data.slice(10);
  if (words.length < 64 * 4) {
    throw new Error('SeaDrop mintPublic calldata is shorter than expected.');
  }
  const nftContract = getAddress(`0x${words.slice(24, 64)}`);
  const quantity = BigInt(`0x${words.slice(64 * 3, 64 * 4)}`);
  const response = await publicClient.call({
    to: transaction.to,
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

  const [publicDrop] = decodeAbiParameters([{
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
  const oldValue = transaction.value;
  const newValue = BigInt(publicDrop.mintPrice) * quantity;
  if (newValue !== oldValue) {
    transaction.value = newValue;
    plan.estimatedTotal = newValue + plan.estimatedFee;
  }
  return {
    changed: newValue !== oldValue,
    oldValue,
    newValue,
    unitPrice: BigInt(publicDrop.mintPrice),
    quantity,
  };
}

export async function sendTransactionPlan({plan, publicClient, chain, rpcUrl, noWait}) {
  const {account, transaction, gasLimit} = plan;
  if (plan.balance < plan.estimatedTotal) {
    throw new Error(`Insufficient native balance: have ${formatEther(plan.balance)} ETH, need about ${formatEther(plan.estimatedTotal)} ETH.`);
  }
  const walletClient = createWalletClient({account, chain, transport: http(rpcUrl)});
  const hash = await walletClient.sendTransaction({
    account,
    to: transaction.to,
    data: transaction.data,
    value: transaction.value,
    gas: gasLimit,
  });
  let receipt = null;
  if (!noWait) {
    receipt = await publicClient.waitForTransactionReceipt({hash});
  }
  return {hash, receipt};
}

export async function previewMint({
  contractAddress,
  quantity = 1n,
  tokenId = '0',
  chainKey,
  concurrency,
  accounts: configuredAccounts,
  env = process.env,
  onPlan,
} = {}) {
  const accounts = configuredAccounts || loadAccounts(env);
  if (!accounts.length) throw new Error('Select at least one wallet for preview.');
  const chainConfig = resolveChainConfig({chainKey, env});
  const {chain, publicClient, rpcUrl} = createClients(chainConfig);
  const graphqlUrl = env.OPENSEA_GRAPHQL_URL?.trim() || DEFAULT_GRAPHQL_URL;
  const configuredConcurrency = concurrency ?? parseConcurrency(env.WALLET_CONCURRENCY?.trim() || '0', 'WALLET_CONCURRENCY');
  const address = getAddress(contractAddress);

  const plans = new Array(accounts.length);
  const failures = new Array(accounts.length);
  const skipped = new Array(accounts.length);

  await mapConcurrent(accounts, configuredConcurrency, async (account, index) => {
    try {
      const plan = await buildTransactionPlan({
        publicClient,
        account,
        contractAddress: address,
        quantity,
        tokenId: String(tokenId),
        chainIdentifier: chainConfig.chainIdentifier,
        chainId: chainConfig.chainId,
        graphqlUrl,
        gasLimitBufferBps: env.GAS_LIMIT_BUFFER_BPS?.trim(),
      });
      if (onPlan) onPlan(plan, index, accounts.length);
      if (plan.balance < plan.estimatedTotal) {
        skipped[index] = {
          address: account.address,
          reason: `Insufficient native balance: have ${formatEther(plan.balance)} ETH, need about ${formatEther(plan.estimatedTotal)} ETH.`,
        };
        return;
      }
      plans[index] = plan;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures[index] = {address: account.address, message};
    }
  });

  return {
    accounts,
    chainConfig,
    chain,
    publicClient,
    rpcUrl,
    configuredConcurrency,
    contractAddress: address,
    quantity,
    tokenId: String(tokenId),
    readyPlans: plans.filter(Boolean),
    failedWallets: failures.filter(Boolean),
    skippedWallets: skipped.filter(Boolean),
  };
}

export async function sendMintBatch({
  readyPlans,
  publicClient,
  chain,
  rpcUrl,
  concurrency,
  noWait = false,
  requote = true,
  onResult,
} = {}) {
  const sendResults = await mapConcurrent(readyPlans, concurrency, async (plan) => {
    try {
      const quote = requote ? await requoteSeaDropPlan({publicClient, plan}) : null;
      if (quote?.changed && quote.newValue > quote.oldValue) {
        throw new Error(`Mint price increased from ${formatEther(quote.oldValue)} ETH to ${formatEther(quote.newValue)} ETH. Run preview again to confirm the new price.`);
      }
      const {hash, receipt} = await sendTransactionPlan({plan, publicClient, chain, rpcUrl, noWait});
      const result = {
        address: plan.account.address,
        hash,
        status: receipt?.status ?? 'sent',
        blockNumber: receipt?.blockNumber?.toString() ?? null,
        requoted: Boolean(quote?.changed),
        valueEth: formatEther(plan.transaction.value),
      };
      if (onResult) onResult(result);
      return result;
    } catch (error) {
      const result = {
        address: plan.account.address,
        error: error instanceof Error ? error.message : String(error),
      };
      if (onResult) onResult(result);
      return result;
    }
  });

  return {
    sent: sendResults.filter((result) => result?.hash),
    failed: sendResults.filter((result) => result?.error),
  };
}
