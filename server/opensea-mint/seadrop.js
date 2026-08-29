import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  getAddress,
  keccak256,
  recoverTypedDataAddress,
} from 'viem';
import {gasBufferBps, loadAppConfig} from './config.js';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export const SEADROP_MINT_PUBLIC_SELECTOR = '0x161ac21f';
export const SEADROP_MINT_ALLOWLIST_SELECTOR = '0x4300a4e6';
export const SEADROP_MINT_SIGNED_SELECTOR = '0x4b61cd6f';

const MINT_PARAMS_COMPONENTS = [
  {name: 'mintPrice', type: 'uint256'},
  {name: 'maxTotalMintableByWallet', type: 'uint256'},
  {name: 'startTime', type: 'uint256'},
  {name: 'endTime', type: 'uint256'},
  {name: 'dropStageIndex', type: 'uint256'},
  {name: 'maxTokenSupplyForStage', type: 'uint256'},
  {name: 'feeBps', type: 'uint256'},
  {name: 'restrictFeeRecipients', type: 'bool'},
];

const MINT_PARAMS_ABI = {type: 'tuple', components: MINT_PARAMS_COMPONENTS};

const MINT_ALLOWLIST_ABI = [{
  type: 'function',
  name: 'mintAllowList',
  stateMutability: 'payable',
  inputs: [
    {name: 'nftContract', type: 'address'},
    {name: 'feeRecipient', type: 'address'},
    {name: 'minterIfNotPayer', type: 'address'},
    {name: 'quantity', type: 'uint256'},
    {name: 'mintParams', ...MINT_PARAMS_ABI},
    {name: 'proof', type: 'bytes32[]'},
  ],
  outputs: [],
}];

const MINT_SIGNED_ABI = [{
  type: 'function',
  name: 'mintSigned',
  stateMutability: 'payable',
  inputs: [
    {name: 'nftContract', type: 'address'},
    {name: 'feeRecipient', type: 'address'},
    {name: 'minterIfNotPayer', type: 'address'},
    {name: 'quantity', type: 'uint256'},
    {name: 'mintParams', ...MINT_PARAMS_ABI},
    {name: 'salt', type: 'uint256'},
    {name: 'signature', type: 'bytes'},
  ],
  outputs: [],
}];

const MINT_PARAMS_TUPLE_TYPE = {
  type: 'tuple',
  components: MINT_PARAMS_COMPONENTS,
};

const SIGNED_MINT_TYPES = {
  MintParams: MINT_PARAMS_COMPONENTS.map(({name, type}) => ({name, type})),
  SignedMint: [
    {name: 'nftContract', type: 'address'},
    {name: 'minter', type: 'address'},
    {name: 'feeRecipient', type: 'address'},
    {name: 'mintParams', type: 'MintParams'},
    {name: 'salt', type: 'uint256'},
  ],
};

const ALLOWLIST_ROOT_ABI = [{
  type: 'function',
  name: 'getAllowListMerkleRoot',
  stateMutability: 'view',
  inputs: [{name: 'nftContract', type: 'address'}],
  outputs: [{name: 'root', type: 'bytes32'}],
}];

const SIGNERS_ABI = [{
  type: 'function',
  name: 'getSigners',
  stateMutability: 'view',
  inputs: [{name: 'nftContract', type: 'address'}],
  outputs: [{name: 'signers', type: 'address[]'}],
}];

const SIGNED_PARAMS_ABI = [{
  type: 'function',
  name: 'getSignedMintValidationParams',
  stateMutability: 'view',
  inputs: [
    {name: 'nftContract', type: 'address'},
    {name: 'signer', type: 'address'},
  ],
  outputs: [{
    name: 'params',
    type: 'tuple',
    components: [
      {name: 'minMintPrice', type: 'uint256'},
      {name: 'maxMaxTotalMintableByWallet', type: 'uint256'},
      {name: 'minStartTime', type: 'uint256'},
      {name: 'maxEndTime', type: 'uint256'},
      {name: 'maxMaxTokenSupplyForStage', type: 'uint256'},
      {name: 'minFeeBps', type: 'uint256'},
      {name: 'maxFeeBps', type: 'uint256'},
    ],
  }],
}];

function asUint(value, name) {
  try {
    const result = BigInt(value);
    if (result < 0n) throw new Error();
    return result;
  } catch {
    throw new Error(`${name} must be a non-negative integer.`);
  }
}

export function normalizeMintParams(raw) {
  const source = raw?.mintParams || raw;
  if (!source || typeof source !== 'object') throw new Error('MintParams must be an object.');
  return {
    mintPrice: asUint(source.mintPrice, 'mintPrice'),
    maxTotalMintableByWallet: asUint(source.maxTotalMintableByWallet, 'maxTotalMintableByWallet'),
    startTime: asUint(source.startTime, 'startTime'),
    endTime: asUint(source.endTime, 'endTime'),
    dropStageIndex: asUint(source.dropStageIndex, 'dropStageIndex'),
    maxTokenSupplyForStage: asUint(source.maxTokenSupplyForStage, 'maxTokenSupplyForStage'),
    feeBps: asUint(source.feeBps, 'feeBps'),
    restrictFeeRecipients: Boolean(source.restrictFeeRecipients),
  };
}

function mintParamsArgs(params) {
  return [
    params.mintPrice,
    params.maxTotalMintableByWallet,
    params.startTime,
    params.endTime,
    params.dropStageIndex,
    params.maxTokenSupplyForStage,
    params.feeBps,
    params.restrictFeeRecipients,
  ];
}

export function encodeMintAllowList({nftContract, feeRecipient, quantity, mintParams, proof = []}) {
  return encodeFunctionData({
    abi: MINT_ALLOWLIST_ABI,
    functionName: 'mintAllowList',
    args: [getAddress(nftContract), getAddress(feeRecipient), ZERO_ADDRESS, BigInt(quantity), mintParams, proof],
  });
}

export function decodeMintAllowList(data) {
  const decoded = decodeFunctionData({abi: MINT_ALLOWLIST_ABI, data});
  if (decoded.functionName !== 'mintAllowList') throw new Error('Calldata is not SeaDrop mintAllowList.');
  const [nftContract, feeRecipient, minterIfNotPayer, quantity, rawParams, proof] = decoded.args;
  return {
    mode: 'allowlist',
    nftContract: getAddress(nftContract),
    feeRecipient: getAddress(feeRecipient),
    minterIfNotPayer: getAddress(minterIfNotPayer),
    quantity: BigInt(quantity),
    mintParams: normalizeMintParams(rawParams),
    proof: [...proof],
  };
}

export function encodeMintSigned({nftContract, feeRecipient, quantity, mintParams, salt, signature}) {
  return encodeFunctionData({
    abi: MINT_SIGNED_ABI,
    functionName: 'mintSigned',
    args: [getAddress(nftContract), getAddress(feeRecipient), ZERO_ADDRESS, BigInt(quantity), mintParams, BigInt(salt), signature],
  });
}

export function decodeMintSigned(data) {
  const decoded = decodeFunctionData({abi: MINT_SIGNED_ABI, data});
  if (decoded.functionName !== 'mintSigned') throw new Error('Calldata is not SeaDrop mintSigned.');
  const [nftContract, feeRecipient, minterIfNotPayer, quantity, rawParams, salt, signature] = decoded.args;
  return {
    mode: 'signed',
    nftContract: getAddress(nftContract),
    feeRecipient: getAddress(feeRecipient),
    minterIfNotPayer: getAddress(minterIfNotPayer),
    quantity: BigInt(quantity),
    mintParams: normalizeMintParams(rawParams),
    salt: BigInt(salt),
    signature,
  };
}

export function allowListLeaf(minter, mintParams) {
  return keccak256(encodeAbiParameters([
    {type: 'address'},
    MINT_PARAMS_TUPLE_TYPE,
  ], [getAddress(minter), mintParamsArgs(mintParams)]));
}

export function verifyMerkleProof(leaf, proof, root) {
  let computed = leaf.toLowerCase();
  for (const sibling of proof) {
    const normalized = sibling.toLowerCase();
    computed = computed < normalized
      ? keccak256(`${computed}${normalized.slice(2)}`)
      : keccak256(`${normalized}${computed.slice(2)}`);
  }
  return computed.toLowerCase() === String(root).toLowerCase();
}

function normalizeProof(proof) {
  if (!Array.isArray(proof)) throw new Error('Allowlist proof must be an array.');
  return proof.map((item) => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(item))) throw new Error('Allowlist proof contains an invalid bytes32 value.');
    return String(item);
  });
}

export function parseSeaDropCredentials(input, mode) {
  let parsed = input;
  if (typeof input === 'string') {
    try { parsed = JSON.parse(input); } catch { throw new Error('Whitelist credentials must be valid JSON.'); }
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? Object.entries(parsed).map(([address, value]) => ({address, ...value}))
      : [];
  const result = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') throw new Error('Each whitelist credential must be an object.');
    const address = getAddress(String(entry.address || entry.wallet || ''));
    const params = normalizeMintParams(entry);
    const credential = {
      address,
      feeRecipient: getAddress(String(entry.feeRecipient || ZERO_ADDRESS)),
      minterIfNotPayer: getAddress(String(entry.minterIfNotPayer || ZERO_ADDRESS)),
      mintParams: params,
    };
    if (mode === 'allowlist') credential.proof = normalizeProof(entry.proof);
    if (mode === 'signed') {
      credential.salt = asUint(entry.salt, 'salt');
      credential.signature = String(entry.signature || '');
      if (!/^0x[0-9a-fA-F]{130}$/.test(credential.signature)) {
        throw new Error(`Invalid signed mint signature for ${address}.`);
      }
    }
    const key = address.toLowerCase();
    if (result.has(key)) throw new Error(`Duplicate whitelist credential for ${address}.`);
    result.set(key, credential);
  }
  if (!result.size) throw new Error('No whitelist credentials were provided.');
  return result;
}

const PUBLIC_DROP_ABI = [{
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
}];

const FEE_RECIPIENTS_ABI = [{
  type: 'function',
  name: 'getAllowedFeeRecipients',
  stateMutability: 'view',
  inputs: [{name: 'nftContract', type: 'address'}],
  outputs: [{name: 'feeRecipients', type: 'address[]'}],
}];

const CREATOR_PAYOUT_ABI = [{
  type: 'function',
  name: 'getCreatorPayoutAddress',
  stateMutability: 'view',
  inputs: [{name: 'nftContract', type: 'address'}],
  outputs: [{name: 'payoutAddress', type: 'address'}],
}];

const MINT_PUBLIC_ABI = [{
  type: 'function',
  name: 'mintPublic',
  stateMutability: 'payable',
  inputs: [
    {name: 'nftContract', type: 'address'},
    {name: 'feeRecipient', type: 'address'},
    {name: 'minterIfNotPayer', type: 'address'},
    {name: 'quantity', type: 'uint256'},
  ],
  outputs: [],
}];

const MINT_STATS_ABI = [{
  type: 'function',
  name: 'getMintStats',
  stateMutability: 'view',
  inputs: [{name: 'minter', type: 'address'}],
  outputs: [
    {name: 'minterNumMinted', type: 'uint256'},
    {name: 'currentTotalSupply', type: 'uint256'},
    {name: 'maxSupply', type: 'uint256'},
  ],
}];

const NAME_ABI = [{
  type: 'function',
  name: 'name',
  stateMutability: 'view',
  inputs: [],
  outputs: [{name: 'name', type: 'string'}],
}];

function tupleValue(tuple, name, index) {
  return tuple?.[name] ?? tuple?.[index];
}

function normalizePublicDrop(raw) {
  return {
    mintPrice: BigInt(tupleValue(raw, 'mintPrice', 0)),
    startTime: Number(tupleValue(raw, 'startTime', 1)),
    endTime: Number(tupleValue(raw, 'endTime', 2)),
    maxTotalMintableByWallet: BigInt(tupleValue(raw, 'maxTotalMintableByWallet', 3)),
    feeBps: Number(tupleValue(raw, 'feeBps', 4)),
    restrictFeeRecipients: Boolean(tupleValue(raw, 'restrictFeeRecipients', 5)),
  };
}

function normalizeMintStats(raw) {
  return {
    minterNumMinted: BigInt(tupleValue(raw, 'minterNumMinted', 0)),
    currentTotalSupply: BigInt(tupleValue(raw, 'currentTotalSupply', 1)),
    maxSupply: BigInt(tupleValue(raw, 'maxSupply', 2)),
  };
}

export function classifyDropPhase(drop, chainTimestamp) {
  const configured = !(drop.mintPrice === 0n && drop.startTime === 0 && drop.endTime === 0);
  if (!configured) return 'unconfigured';
  if (chainTimestamp < drop.startTime) return 'not_started';
  if (chainTimestamp > drop.endTime) return 'ended';
  return 'live';
}

async function mapLimited(items, limit, worker) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, run));
  return results;
}

async function readWalletStats(publicClient, nftContract, account) {
  try {
    const raw = await publicClient.readContract({
      address: nftContract,
      abi: MINT_STATS_ABI,
      functionName: 'getMintStats',
      args: [account.address],
    });
    const stats = normalizeMintStats(raw);
    return {
      address: account.address,
      ...stats,
      perWalletLeft: stats.minterNumMinted,
      error: null,
    };
  } catch (error) {
    return {
      address: account.address,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function inspectSeaDrop({publicClient, contractAddress, accounts = [], env = process.env}) {
  const config = loadAppConfig(env);
  const seaDropAddress = config.seaDrop.address;
  const nftContract = getAddress(contractAddress);

  // The fixed reads below are issued in one wave, and the per-wallet stats run
  // alongside them under their own concurrency limit. The values do depend on
  // each other — feeRecipient is chosen by drop.restrictFeeRecipients and
  // perWalletLeft is derived from drop.maxTotalMintableByWallet — but those are
  // arithmetic dependencies, not fetch dependencies: nothing here decides *which*
  // call to make based on an earlier answer. Issuing them in four sequential
  // waves cost four round trips, and on a chain whose blocks are 101ms apart that
  // was the difference between arriving inside the target block and arriving
  // after it. Measured against Robinhood Chain: 322ms sequential, 175ms overlapped.
  //
  // The wallet reads keep statsConcurrency rather than joining the wave. Fanning
  // out one request per wallet is what pushes this chain's read pool into
  // backoff — see the note in transfer-gas.js about 40 wallets producing "All RPC
  // upstreams are backing off for chain 4663" — and a 53-wallet batch would do it
  // on every inspection.
  //
  // getPublicDrop keeps its own error path because a revert there means the
  // address is not a SeaDrop-configured collection at all, while the other
  // reads are allowed to fail individually and fall back to null.
  const [fixedResults, rawWalletStats] = await Promise.all([
    Promise.allSettled([
      publicClient.getBytecode({address: nftContract}),
      publicClient.getBytecode({address: seaDropAddress}),
      publicClient.getBlock({blockTag: 'latest'}),
      publicClient.readContract({
        address: seaDropAddress,
        abi: PUBLIC_DROP_ABI,
        functionName: 'getPublicDrop',
        args: [nftContract],
      }),
      publicClient.readContract({
        address: seaDropAddress,
        abi: FEE_RECIPIENTS_ABI,
        functionName: 'getAllowedFeeRecipients',
        args: [nftContract],
      }),
      publicClient.readContract({
        address: seaDropAddress,
        abi: CREATOR_PAYOUT_ABI,
        functionName: 'getCreatorPayoutAddress',
        args: [nftContract],
      }),
      publicClient.readContract({address: nftContract, abi: NAME_ABI, functionName: 'name'}),
      publicClient.readContract({
        address: nftContract,
        abi: MINT_STATS_ABI,
        functionName: 'getMintStats',
        args: [ZERO_ADDRESS],
      }),
    ]),
    mapLimited(
      accounts,
      config.seaDrop.statsConcurrency,
      (account) => readWalletStats(publicClient, nftContract, account),
    ),
  ]);
  const [
    nftCodeResult,
    routeCodeResult,
    blockResult,
    dropResult,
    allowedResult,
    creatorResult,
    nameResult,
    globalStatsResult,
  ] = fixedResults;

  // The bytecode and block reads were mandatory before and stay mandatory: a
  // rejection here is a broken RPC or a wrong chain, not a missing feature.
  if (blockResult.status === 'rejected') throw blockResult.reason;
  if (nftCodeResult.status === 'rejected') throw nftCodeResult.reason;
  if (routeCodeResult.status === 'rejected') throw routeCodeResult.reason;
  const nftCode = nftCodeResult.value;
  const routeCode = routeCodeResult.value;
  const block = blockResult.value;
  if (!nftCode || nftCode === '0x') throw new Error('The NFT address has no contract bytecode on the selected chain.');
  if (!routeCode || routeCode === '0x') throw new Error('SeaDrop v1 is not deployed on the selected chain.');

  if (dropResult.status === 'rejected') {
    const error = dropResult.reason;
    throw new Error(`SeaDrop v1 getPublicDrop failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const drop = normalizePublicDrop(dropResult.value);
  const chainTimestamp = Number(block.timestamp);
  const phase = classifyDropPhase(drop, chainTimestamp);

  const allowedFeeRecipients = allowedResult.status === 'fulfilled'
    ? Array.from(allowedResult.value, (address) => getAddress(address))
    : [];
  const creatorPayout = creatorResult.status === 'fulfilled' ? getAddress(creatorResult.value) : null;
  const name = nameResult.status === 'fulfilled' ? String(nameResult.value) : null;
  const globalStats = globalStatsResult.status === 'fulfilled' ? normalizeMintStats(globalStatsResult.value) : null;
  const feeRecipient = drop.restrictFeeRecipients
    ? allowedFeeRecipients[0] || null
    : config.seaDrop.defaultFeeRecipient;
  const walletStats = rawWalletStats.map((stats) => {
    if (!stats.error) {
      stats.perWalletLeft = drop.maxTotalMintableByWallet > stats.minterNumMinted
        ? drop.maxTotalMintableByWallet - stats.minterNumMinted
        : 0n;
    }
    return stats;
  });

  return {
    nftContract,
    seaDrop: seaDropAddress,
    name,
    creatorPayout,
    allowedFeeRecipients,
    feeRecipient,
    drop,
    phase,
    configured: phase !== 'unconfigured',
    chainTimestamp,
    globalStats,
    supplyLeft: globalStats
      ? (globalStats.maxSupply > globalStats.currentTotalSupply ? globalStats.maxSupply - globalStats.currentTotalSupply : 0n)
      : null,
    walletStats,
  };
}

export async function inspectSeaDropCredentialRoute({publicClient, contractAddress, mode, env = process.env}) {
  const config = loadAppConfig(env);
  const seaDropAddress = config.seaDrop.address;
  const [nftCode, routeCode, block] = await Promise.all([
    publicClient.getBytecode({address: getAddress(contractAddress)}),
    publicClient.getBytecode({address: seaDropAddress}),
    publicClient.getBlock({blockTag: 'latest'}),
  ]);
  if (!nftCode || nftCode === '0x') throw new Error('The NFT address has no contract bytecode on the selected chain.');
  if (!routeCode || routeCode === '0x') throw new Error('SeaDrop v1 is not deployed on the selected chain.');
  const [allowedResult, creatorResult, nameResult, rootResult, signersResult, globalStatsResult] = await Promise.allSettled([
    publicClient.readContract({address: seaDropAddress, abi: FEE_RECIPIENTS_ABI, functionName: 'getAllowedFeeRecipients', args: [getAddress(contractAddress)]}),
    publicClient.readContract({address: seaDropAddress, abi: CREATOR_PAYOUT_ABI, functionName: 'getCreatorPayoutAddress', args: [getAddress(contractAddress)]}),
    publicClient.readContract({address: getAddress(contractAddress), abi: NAME_ABI, functionName: 'name'}),
    mode === 'allowlist'
      ? publicClient.readContract({address: seaDropAddress, abi: ALLOWLIST_ROOT_ABI, functionName: 'getAllowListMerkleRoot', args: [getAddress(contractAddress)]})
      : Promise.resolve(null),
    mode === 'signed'
      ? publicClient.readContract({address: seaDropAddress, abi: SIGNERS_ABI, functionName: 'getSigners', args: [getAddress(contractAddress)]})
      : Promise.resolve([]),
    publicClient.readContract({
      address: getAddress(contractAddress),
      abi: MINT_STATS_ABI,
      functionName: 'getMintStats',
      args: [ZERO_ADDRESS],
    }),
  ]);
  const allowedFeeRecipients = allowedResult.status === 'fulfilled'
    ? Array.from(allowedResult.value, (address) => getAddress(address))
    : [];
  const creatorPayout = creatorResult.status === 'fulfilled' ? getAddress(creatorResult.value) : null;
  const feeRecipient = allowedFeeRecipients[0] || config.seaDrop.defaultFeeRecipient;
  const root = rootResult.status === 'fulfilled' ? String(rootResult.value) : null;
  const signers = signersResult.status === 'fulfilled' ? Array.from(signersResult.value, (address) => getAddress(address)) : [];
  const globalStats = globalStatsResult.status === 'fulfilled' ? normalizeMintStats(globalStatsResult.value) : null;
  if (mode === 'allowlist' && (!root || /^0x0{64}$/i.test(root))) throw new Error('No SeaDrop allowlist Merkle root is configured for this NFT.');
  if (mode === 'signed' && !signers.length) throw new Error('No SeaDrop signed-mint signer is configured for this NFT.');
  return {
    mode,
    nftContract: getAddress(contractAddress),
    seaDrop: seaDropAddress,
    name: nameResult.status === 'fulfilled' ? String(nameResult.value) : null,
    creatorPayout,
    allowedFeeRecipients,
    feeRecipient,
    root,
    signers,
    globalStats,
    supplyLeft: globalStats
      ? (globalStats.maxSupply > globalStats.currentTotalSupply ? globalStats.maxSupply - globalStats.currentTotalSupply : 0n)
      : null,
    chainTimestamp: Number(block.timestamp),
    chainId: publicClient.chain?.id || await publicClient.getChainId(),
  };
}

async function verifySignedCredential({publicClient, inspection, credential, signerParamsCache = new Map()}) {
  const params = credential.mintParams;
  const recovered = await recoverTypedDataAddress({
    domain: {
      name: 'SeaDrop',
      version: '1.0',
      chainId: inspection.chainId,
      verifyingContract: inspection.seaDrop,
    },
    types: SIGNED_MINT_TYPES,
    primaryType: 'SignedMint',
    message: {
      nftContract: inspection.nftContract,
      minter: credential.address,
      feeRecipient: credential.feeRecipient,
      mintParams: params,
      salt: credential.salt,
    },
    signature: credential.signature,
  });
  if (!inspection.signers.some((signer) => signer.toLowerCase() === recovered.toLowerCase())) {
    throw new Error(`Signature signer ${recovered} is not authorized for this NFT.`);
  }
  const cacheKey = recovered.toLowerCase();
  if (!signerParamsCache.has(cacheKey)) {
    signerParamsCache.set(cacheKey, publicClient.readContract({
      address: inspection.seaDrop,
      abi: SIGNED_PARAMS_ABI,
      functionName: 'getSignedMintValidationParams',
      args: [inspection.nftContract, recovered],
    }));
  }
  const allowed = await signerParamsCache.get(cacheKey);
  if (!allowed) throw new Error('Signed mint validation parameters could not be read.');
  const limits = {
    minMintPrice: BigInt(allowed.minMintPrice ?? allowed[0]),
    maxMaxTotalMintableByWallet: BigInt(allowed.maxMaxTotalMintableByWallet ?? allowed[1]),
    minStartTime: BigInt(allowed.minStartTime ?? allowed[2]),
    maxEndTime: BigInt(allowed.maxEndTime ?? allowed[3]),
    maxMaxTokenSupplyForStage: BigInt(allowed.maxMaxTokenSupplyForStage ?? allowed[4]),
    minFeeBps: BigInt(allowed.minFeeBps ?? allowed[5]),
    maxFeeBps: BigInt(allowed.maxFeeBps ?? allowed[6]),
  };
  if (params.mintPrice < limits.minMintPrice || params.maxTotalMintableByWallet > limits.maxMaxTotalMintableByWallet
    || params.startTime < limits.minStartTime || params.endTime > limits.maxEndTime
    || params.maxTokenSupplyForStage > limits.maxMaxTokenSupplyForStage
    || params.feeBps < limits.minFeeBps || params.feeBps > limits.maxFeeBps
    || !params.restrictFeeRecipients) {
    throw new Error('Signed mint parameters exceed the signer limits.');
  }
  return recovered;
}

export async function validateSeaDropCredential({
  publicClient,
  inspection,
  account,
  credential,
  quantity,
  targetTimestamp = null,
  allowInactive = false,
  signerParamsCache = new Map(),
}) {
  if (!credential) throw new Error('No whitelist credential was provided for this wallet.');
  if (credential.address.toLowerCase() !== account.address.toLowerCase()) throw new Error('Credential wallet does not match the selected wallet.');
  if (credential.minterIfNotPayer !== ZERO_ADDRESS) throw new Error('Delegated whitelist payer is not supported.');
  if (credential.feeRecipient === ZERO_ADDRESS) credential.feeRecipient = inspection.feeRecipient;
  const params = credential.mintParams;
  if (!inspection.creatorPayout || inspection.creatorPayout === ZERO_ADDRESS) throw new Error('SeaDrop creator payout address is not configured.');
  if (!credential.feeRecipient || credential.feeRecipient === ZERO_ADDRESS) throw new Error('SeaDrop fee recipient cannot be the zero address.');
  if (BigInt(quantity) <= 0n) throw new Error('quantity must be positive.');
  if (params.feeBps > 10_000n) throw new Error('Whitelist feeBps cannot exceed 10000.');
  if (params.restrictFeeRecipients && !inspection.allowedFeeRecipients.some((item) => item.toLowerCase() === credential.feeRecipient.toLowerCase())) {
    throw new Error('Whitelist fee recipient is not allowed by SeaDrop.');
  }
  const timestamp = targetTimestamp ?? inspection.chainTimestamp;
  if (!allowInactive && (timestamp < Number(params.startTime) || timestamp > Number(params.endTime))) {
    throw new Error('Whitelist mint stage is not active at the execution time.');
  }
  if (BigInt(quantity) > params.maxTotalMintableByWallet) throw new Error('Requested quantity exceeds the whitelist wallet limit.');
  const stats = await readWalletStats(publicClient, inspection.nftContract, account);
  if (stats.error) throw new Error(stats.error);
  if (stats.minterNumMinted + BigInt(quantity) > params.maxTotalMintableByWallet) {
    throw new Error(`Wallet whitelist allowance has ${params.maxTotalMintableByWallet - stats.minterNumMinted} remaining.`);
  }
  if (stats.currentTotalSupply + BigInt(quantity) > stats.maxSupply) {
    throw new Error('NFT collection supply is insufficient for this wallet.');
  }
  if (stats.currentTotalSupply + BigInt(quantity) > params.maxTokenSupplyForStage) {
    throw new Error('Whitelist stage supply is insufficient for this wallet.');
  }
  if (inspection.mode === 'allowlist') {
    const leaf = allowListLeaf(account.address, params);
    if (!verifyMerkleProof(leaf, credential.proof, inspection.root)) throw new Error('Invalid Merkle proof for this wallet and mint parameters.');
  } else {
    await verifySignedCredential({publicClient, inspection, credential, signerParamsCache});
  }
  return stats;
}

export async function evaluateSeaDropCredential({
  publicClient,
  inspection,
  account,
  credential,
  quantity = 1n,
  allowInactive = false,
  signerParamsCache = new Map(),
}) {
  return validateSeaDropCredential({
    publicClient,
    inspection,
    account,
    credential,
    quantity,
    allowInactive,
    signerParamsCache,
  });
}

export async function buildSeaDropCredentialPlans({
  publicClient,
  accounts,
  contractAddress,
  quantity,
  concurrency,
  mode,
  credentials,
  allowNotStarted = false,
  scheduledGasLimit = null,
  env = process.env,
}) {
  if (!['allowlist', 'signed'].includes(mode)) throw new Error(`Unsupported SeaDrop credential mode: ${mode}.`);
  const inspection = await inspectSeaDropCredentialRoute({publicClient, contractAddress, mode, env});
  const gasPrice = await publicClient.getGasPrice();
  const signerParamsCache = new Map();
  const outcomes = await mapLimited(accounts, concurrency === 0 ? accounts.length : concurrency, async (account) => {
    const credential = credentials.get(account.address.toLowerCase());
    if (!credential) return {type: 'failed', address: account.address, message: 'No whitelist credential was provided for this wallet.'};
    try {
      const params = credential.mintParams;
      const stats = await validateSeaDropCredential({
        publicClient,
        inspection,
        account,
        credential,
        quantity,
        targetTimestamp: allowNotStarted ? Number(params.startTime) : null,
        signerParamsCache,
      });
      const data = mode === 'allowlist'
        ? encodeMintAllowList({nftContract: contractAddress, feeRecipient: credential.feeRecipient, quantity, mintParams: params, proof: credential.proof})
        : encodeMintSigned({nftContract: contractAddress, feeRecipient: credential.feeRecipient, quantity, mintParams: params, salt: credential.salt, signature: credential.signature});
      const value = params.mintPrice * BigInt(quantity);
      const [balance, estimatedGas] = await Promise.all([
        publicClient.getBalance({address: account.address}),
        scheduledGasLimit === null
          ? publicClient.estimateGas({account, to: inspection.seaDrop, data, value})
          : Promise.resolve(BigInt(scheduledGasLimit)),
      ]);
      const gasLimit = scheduledGasLimit === null ? estimatedGas * gasBufferBps(env) / 10000n : BigInt(scheduledGasLimit);
      const estimatedFee = gasLimit * gasPrice;
      const plan = {
        account,
        transaction: {to: inspection.seaDrop, data, value, actionType: mode === 'allowlist' ? 'SeaDropAllowList' : 'SeaDropSigned', isSeaDropMintSigned: mode === 'signed'},
        balance,
        estimatedGas,
        gasLimit,
        gasPrice,
        estimatedFee,
        estimatedTotal: value + estimatedFee,
        directSeaDrop: {nftContract: getAddress(contractAddress), feeRecipient: credential.feeRecipient, quantity: BigInt(quantity), mode, credential},
      };
      if (balance < plan.estimatedTotal) return {type: 'skipped', address: account.address, reason: `Insufficient balance: ${formatEther(balance)} ETH available, about ${formatEther(plan.estimatedTotal)} ETH required.`};
      return {type: 'ready', plan, stats};
    } catch (error) {
      return {type: 'failed', address: account.address, message: error instanceof Error ? error.message : String(error)};
    }
  });
  const readyOutcomes = outcomes.filter((item) => item.type === 'ready');
  const readyPlans = readyOutcomes.map((item) => item.plan);
  const aggregateBlocker = readyOutcomes.length ? aggregateCredentialSupplyBlocker({
    currentTotalSupply: readyOutcomes[0].stats.currentTotalSupply,
    maxSupply: readyOutcomes[0].stats.maxSupply,
    stageLimits: readyPlans.map((plan) => plan.directSeaDrop.credential.mintParams.maxTokenSupplyForStage),
    quantity,
    walletCount: readyPlans.length,
  }) : null;
  return {
    inspection,
    readyPlans: aggregateBlocker ? [] : readyPlans,
    skippedWallets: outcomes.filter((item) => item.type === 'skipped'),
    failedWallets: [
      ...outcomes.filter((item) => item.type === 'failed'),
      ...(aggregateBlocker ? readyPlans.map((plan) => ({
        type: 'failed',
        address: plan.account.address,
        message: aggregateBlocker,
      })) : []),
    ],
  };
}

export async function revalidateSeaDropCredentialPlan({
  publicClient,
  plan,
  targetTimestamp = null,
  inspection: providedInspection = null,
  signerParamsCache = new Map(),
  env = process.env,
}) {
  const meta = plan.directSeaDrop;
  if (!['allowlist', 'signed'].includes(meta?.mode)) {
    return {changed: false, oldValue: plan.transaction.value, newValue: plan.transaction.value};
  }
  const inspection = providedInspection || await inspectSeaDropCredentialRoute({
    publicClient,
    contractAddress: meta.nftContract,
    mode: meta.mode,
    env,
  });
  const stats = await validateSeaDropCredential({
    publicClient,
    inspection,
    account: plan.account,
    credential: meta.credential,
    quantity: meta.quantity,
    targetTimestamp,
    signerParamsCache,
  });
  const oldValue = plan.transaction.value;
  const newValue = meta.credential.mintParams.mintPrice * meta.quantity;
  if (newValue !== oldValue) throw new Error('Whitelist mint price no longer matches the prepared transaction.');
  return {changed: false, oldValue, newValue, inspection, stats};
}

export async function revalidateSeaDropCredentialBatch({publicClient, plans, targetTimestamp, env = process.env}) {
  if (!plans.length) return {inspection: null, readyPlans: [], failedPlans: [], changed: false};
  const meta = plans[0].directSeaDrop;
  const inspection = await inspectSeaDropCredentialRoute({
    publicClient,
    contractAddress: meta.nftContract,
    mode: meta.mode,
    env,
  });
  const signerParamsCache = new Map();
  const config = loadAppConfig(env);
  const readyPlans = [];
  const failedPlans = [];
  const outcomes = await mapLimited(plans, config.seaDrop.statsConcurrency, async (plan) => {
    try {
      const validation = await revalidateSeaDropCredentialPlan({publicClient, plan, targetTimestamp, inspection, signerParamsCache, env});
      return {type: 'ready', plan, stats: validation.stats};
    } catch (error) {
      return {type: 'failed', plan, message: error instanceof Error ? error.message : String(error)};
    }
  });
  readyPlans.push(...outcomes.filter((item) => item.type === 'ready').map((item) => item.plan));
  failedPlans.push(...outcomes.filter((item) => item.type === 'failed'));
  const firstReady = outcomes.find((item) => item.type === 'ready');
  const aggregateBlocker = firstReady ? aggregateCredentialSupplyBlocker({
    currentTotalSupply: firstReady.stats.currentTotalSupply,
    maxSupply: firstReady.stats.maxSupply,
    stageLimits: readyPlans.map((plan) => plan.directSeaDrop.credential.mintParams.maxTokenSupplyForStage),
    quantity: meta.quantity,
    walletCount: readyPlans.length,
  }) : null;
  if (aggregateBlocker) throw new Error(aggregateBlocker);
  return {inspection, readyPlans, failedPlans, changed: false};
}

export function serializeSeaDropCredentialInspection(inspection) {
  return {
    mode: inspection.mode,
    nftContract: inspection.nftContract,
    seaDrop: inspection.seaDrop,
    name: inspection.name,
    creatorPayout: inspection.creatorPayout,
    feeRecipient: inspection.feeRecipient,
    allowedFeeRecipients: inspection.allowedFeeRecipients,
    allowListMerkleRoot: inspection.root,
    signers: inspection.signers,
    currentTotalSupply: inspection.globalStats?.currentTotalSupply?.toString() ?? null,
    maxSupply: inspection.globalStats?.maxSupply?.toString() ?? null,
    supplyLeft: inspection.supplyLeft?.toString() ?? null,
    chainTimestamp: inspection.chainTimestamp,
  };
}

export function serializeSeaDropInspection(inspection) {
  const {drop, globalStats} = inspection;
  return {
    nftContract: inspection.nftContract,
    seaDrop: inspection.seaDrop,
    name: inspection.name,
    creatorPayout: inspection.creatorPayout,
    feeRecipient: inspection.feeRecipient,
    allowedFeeRecipients: inspection.allowedFeeRecipients,
    phase: inspection.phase,
    configured: inspection.configured,
    chainTimestamp: inspection.chainTimestamp,
    mintPrice: drop.mintPrice.toString(),
    mintPriceEth: formatEther(drop.mintPrice),
    startTime: drop.startTime,
    endTime: drop.endTime,
    maxTotalMintableByWallet: drop.maxTotalMintableByWallet.toString(),
    feeBps: drop.feeBps,
    restrictFeeRecipients: drop.restrictFeeRecipients,
    currentTotalSupply: globalStats?.currentTotalSupply?.toString() ?? null,
    maxSupply: globalStats?.maxSupply?.toString() ?? null,
    supplyLeft: inspection.supplyLeft?.toString() ?? null,
    walletStats: inspection.walletStats.map((stats) => ({
      address: stats.address,
      minterNumMinted: stats.minterNumMinted?.toString() ?? null,
      perWalletLeft: stats.perWalletLeft?.toString() ?? null,
      error: stats.error,
    })),
  };
}

export function encodeMintPublic({nftContract, feeRecipient, quantity}) {
  return encodeFunctionData({
    abi: MINT_PUBLIC_ABI,
    functionName: 'mintPublic',
    args: [getAddress(nftContract), getAddress(feeRecipient), ZERO_ADDRESS, BigInt(quantity)],
  });
}

export function decodeMintPublic(data) {
  const decoded = decodeFunctionData({abi: MINT_PUBLIC_ABI, data});
  if (decoded.functionName !== 'mintPublic') throw new Error('Calldata is not SeaDrop mintPublic.');
  const [nftContract, feeRecipient, minterIfNotPayer, quantity] = decoded.args;
  return {
    nftContract: getAddress(nftContract),
    feeRecipient: getAddress(feeRecipient),
    minterIfNotPayer: getAddress(minterIfNotPayer),
    quantity: BigInt(quantity),
  };
}

function globalBlocker(inspection, quantity, {allowNotStarted = false} = {}) {
  if (!inspection.configured) return 'This NFT has no SeaDrop v1 public sale configuration.';
  if (inspection.phase === 'not_started' && !allowNotStarted) return `The public sale has not started. Start time: ${new Date(inspection.drop.startTime * 1000).toISOString()}`;
  if (inspection.phase === 'ended') return `The public sale ended at ${new Date(inspection.drop.endTime * 1000).toISOString()}.`;
  if (!inspection.feeRecipient) return 'SeaDrop restricts fee recipients, but no allowed fee recipient could be read.';
  if (quantity <= 0n) return 'quantity must be positive.';
  if (quantity > inspection.drop.maxTotalMintableByWallet) {
    return `Quantity exceeds the per-wallet maximum of ${inspection.drop.maxTotalMintableByWallet}.`;
  }
  if (inspection.supplyLeft !== null && quantity > inspection.supplyLeft) {
    return `Quantity exceeds the remaining supply of ${inspection.supplyLeft}.`;
  }
  return null;
}

export function aggregateSupplyBlocker(supplyLeft, quantity, walletCount) {
  if (supplyLeft === null || supplyLeft === undefined) return null;
  const demand = BigInt(quantity) * BigInt(walletCount);
  if (demand <= BigInt(supplyLeft)) return null;
  return `Selected wallets require ${demand} NFTs, but only ${supplyLeft} remain.`;
}

export function aggregateCredentialSupplyBlocker({
  currentTotalSupply,
  maxSupply,
  stageLimits,
  quantity,
  walletCount,
}) {
  const demand = BigInt(quantity) * BigInt(walletCount);
  const collectionLeft = BigInt(maxSupply) > BigInt(currentTotalSupply)
    ? BigInt(maxSupply) - BigInt(currentTotalSupply)
    : 0n;
  const collectionBlocker = aggregateSupplyBlocker(collectionLeft, quantity, walletCount);
  if (collectionBlocker) return collectionBlocker;
  if (!stageLimits.length) return null;
  const lowestStageLimit = stageLimits.reduce((lowest, value) => (
    BigInt(value) < lowest ? BigInt(value) : lowest
  ), BigInt(stageLimits[0]));
  if (BigInt(currentTotalSupply) + demand <= lowestStageLimit) return null;
  const stageLeft = lowestStageLimit > BigInt(currentTotalSupply)
    ? lowestStageLimit - BigInt(currentTotalSupply)
    : 0n;
  return `Selected wallets require ${demand} NFTs, but the whitelist stage has only ${stageLeft} remaining.`;
}

export async function buildDirectSeaDropPlans({
  publicClient,
  accounts,
  contractAddress,
  quantity,
  concurrency,
  allowNotStarted = false,
  scheduledGasLimit = null,
  env = process.env,
}) {
  const inspection = await inspectSeaDrop({publicClient, contractAddress, accounts, env});
  const blocker = globalBlocker(inspection, quantity, {allowNotStarted});
  if (blocker) {
    return {
      inspection,
      readyPlans: [],
      skippedWallets: [],
      failedWallets: accounts.map((account) => ({type: 'failed', address: account.address, message: blocker})),
    };
  }
  const statsByAddress = new Map(inspection.walletStats.map((stats) => [stats.address.toLowerCase(), stats]));
  const data = encodeMintPublic({
    nftContract: inspection.nftContract,
    feeRecipient: inspection.feeRecipient,
    quantity,
  });
  const value = inspection.drop.mintPrice * quantity;
  const gasPrice = await publicClient.getGasPrice();
  const outcomes = await mapLimited(accounts, concurrency === 0 ? accounts.length : concurrency, async (account) => {
    const stats = statsByAddress.get(account.address.toLowerCase());
    if (!stats || stats.error) {
      return {type: 'failed', address: account.address, message: stats?.error || 'Unable to read wallet mint stats.'};
    }
    if (quantity > stats.perWalletLeft) {
      return {
        type: 'skipped',
        address: account.address,
        reason: `Wallet allowance is ${stats.perWalletLeft}; requested ${quantity}.`,
      };
    }
    try {
      const [balance, estimatedGas] = await Promise.all([
        publicClient.getBalance({address: account.address}),
        scheduledGasLimit === null
          ? publicClient.estimateGas({account, to: inspection.seaDrop, data, value})
          : Promise.resolve(BigInt(scheduledGasLimit)),
      ]);
      const gasLimit = scheduledGasLimit === null
        ? estimatedGas * gasBufferBps(env) / 10000n
        : BigInt(scheduledGasLimit);
      const estimatedFee = gasLimit * gasPrice;
      const plan = {
        account,
        transaction: {
          to: inspection.seaDrop,
          data,
          value,
          actionType: 'SeaDropDirect',
          isSeaDropMintSigned: false,
        },
        errors: [],
        balance,
        estimatedGas,
        gasLimit,
        gasPrice,
        estimatedFee,
        estimatedTotal: value + estimatedFee,
        directSeaDrop: {
          nftContract: inspection.nftContract,
          feeRecipient: inspection.feeRecipient,
          quantity,
        },
      };
      if (balance < plan.estimatedTotal) {
        return {
          type: 'skipped',
          address: account.address,
          reason: `Insufficient balance: ${formatEther(balance)} ETH available, about ${formatEther(plan.estimatedTotal)} ETH required.`,
        };
      }
      return {type: 'ready', plan};
    } catch (error) {
      return {type: 'failed', address: account.address, message: error instanceof Error ? error.message : String(error)};
    }
  });
  const readyPlans = outcomes.filter((item) => item.type === 'ready').map((item) => item.plan);
  const aggregateBlocker = aggregateSupplyBlocker(inspection.supplyLeft, quantity, readyPlans.length);
  if (aggregateBlocker) {
    return {
      inspection,
      readyPlans: [],
      skippedWallets: outcomes.filter((item) => item.type === 'skipped'),
      failedWallets: [
        ...outcomes.filter((item) => item.type === 'failed'),
        ...readyPlans.map((plan) => ({type: 'failed', address: plan.account.address, message: aggregateBlocker})),
      ],
    };
  }
  return {
    inspection,
    readyPlans,
    skippedWallets: outcomes.filter((item) => item.type === 'skipped'),
    failedWallets: outcomes.filter((item) => item.type === 'failed'),
  };
}

export async function revalidateDirectSeaDropBatch({
  publicClient,
  plans,
  targetTimestamp,
  env = process.env,
}) {
  if (!plans.length) return {inspection: null, readyPlans: [], failedPlans: [], changed: false};
  const first = plans[0].directSeaDrop;
  if (!first) throw new Error('Scheduled Mint only supports SeaDrop public plans.');
  const inspection = await inspectSeaDrop({
    publicClient,
    contractAddress: first.nftContract,
    accounts: plans.map((plan) => plan.account),
    env,
  });
  const blocker = globalBlocker(inspection, first.quantity, {allowNotStarted: true});
  if (blocker) throw new Error(blocker);
  if (targetTimestamp < inspection.drop.startTime || targetTimestamp > inspection.drop.endTime) {
    throw new Error(
      `Scheduled time must be inside the current public sale window: ${new Date(inspection.drop.startTime * 1000).toISOString()} - ${new Date(inspection.drop.endTime * 1000).toISOString()}.`,
    );
  }
  if (!inspection.feeRecipient) throw new Error('No executable SeaDrop fee recipient is available.');

  const statsByAddress = new Map(inspection.walletStats.map((stats) => [stats.address.toLowerCase(), stats]));
  const readyPlans = [];
  const failedPlans = [];
  let changed = false;
  for (const plan of plans) {
    const meta = plan.directSeaDrop;
    if (!meta || meta.nftContract.toLowerCase() !== inspection.nftContract.toLowerCase()) {
      failedPlans.push({plan, message: 'Scheduled Mint plan no longer matches the NFT contract.'});
      continue;
    }
    if (inspection.feeRecipient.toLowerCase() !== meta.feeRecipient.toLowerCase()) {
      failedPlans.push({plan, message: 'The allowed SeaDrop fee recipient changed. Preview again.'});
      continue;
    }
    const stats = statsByAddress.get(plan.account.address.toLowerCase());
    if (!stats || stats.error) {
      failedPlans.push({plan, message: stats?.error || 'Unable to recheck wallet mint stats.'});
      continue;
    }
    if (meta.quantity > stats.perWalletLeft) {
      failedPlans.push({plan, message: `Wallet allowance changed to ${stats.perWalletLeft}; requested ${meta.quantity}.`});
      continue;
    }
    if (inspection.phase === 'live' && typeof publicClient.estimateGas === 'function') {
      try {
        const estimatedGas = await publicClient.estimateGas({
          account: plan.account,
          to: inspection.seaDrop,
          data: plan.transaction.data,
          value: plan.transaction.value,
        });
        const bufferedGas = estimatedGas * gasBufferBps(env) / 10000n;
        if (bufferedGas > plan.gasLimit) {
          plan.gasLimit = bufferedGas;
          plan.estimatedGas = estimatedGas;
          plan.estimatedFee = plan.gasLimit * plan.gasPrice;
          plan.estimatedTotal = plan.transaction.value + plan.estimatedFee;
          changed = true;
        }
      } catch (error) {
        failedPlans.push({
          plan,
          message: `Unable to estimate scheduled Mint gas at the final recheck: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
    }
    const oldValue = plan.transaction.value;
    const newValue = inspection.drop.mintPrice * meta.quantity;
    if (newValue > oldValue) {
      failedPlans.push({
        plan,
        message: `Mint price increased from ${formatEther(oldValue)} ETH to ${formatEther(newValue)} ETH. Preview again.`,
      });
      continue;
    }
    if (newValue !== oldValue) {
      plan.transaction.value = newValue;
      plan.estimatedTotal = newValue + plan.estimatedFee;
      changed = true;
    }
    readyPlans.push(plan);
  }

  const aggregateBlocker = aggregateSupplyBlocker(inspection.supplyLeft, first.quantity, readyPlans.length);
  if (aggregateBlocker) throw new Error(aggregateBlocker);
  return {inspection, readyPlans, failedPlans, changed};
}

export async function revalidateDirectSeaDropPlan({publicClient, plan}) {
  const meta = plan.directSeaDrop;
  if (!meta) return {changed: false, oldValue: plan.transaction.value, newValue: plan.transaction.value};
  const inspection = await inspectSeaDrop({
    publicClient,
    contractAddress: meta.nftContract,
    accounts: [plan.account],
  });
  const blocker = globalBlocker(inspection, meta.quantity);
  if (blocker) throw new Error(blocker);
  const stats = inspection.walletStats[0];
  if (!stats || stats.error) throw new Error(stats?.error || 'Unable to recheck wallet mint stats.');
  if (meta.quantity > stats.perWalletLeft) {
    throw new Error(`Wallet allowance changed to ${stats.perWalletLeft}; requested ${meta.quantity}.`);
  }
  if (inspection.feeRecipient.toLowerCase() !== meta.feeRecipient.toLowerCase()) {
    throw new Error('The allowed SeaDrop fee recipient changed. Preview again.');
  }
  const oldValue = plan.transaction.value;
  const newValue = inspection.drop.mintPrice * meta.quantity;
  if (newValue > oldValue) {
    throw new Error(`Mint price increased from ${formatEther(oldValue)} ETH to ${formatEther(newValue)} ETH. Preview again.`);
  }
  if (newValue !== oldValue) {
    plan.transaction.value = newValue;
    plan.estimatedTotal = newValue + plan.estimatedFee;
  }
  return {changed: newValue !== oldValue, oldValue, newValue, inspection};
}
