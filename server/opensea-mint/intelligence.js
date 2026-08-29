import {formatEther, getAddress} from 'viem';
import {loadAppConfig} from './config.js';
import {
  evaluateSeaDropCredential,
  inspectSeaDrop,
  inspectSeaDropCredentialRoute,
  parseSeaDropCredentials,
} from './seadrop.js';

const METADATA_ABI = [{
  type: 'function',
  name: 'name',
  stateMutability: 'view',
  inputs: [],
  outputs: [{name: 'value', type: 'string'}],
}, {
  type: 'function',
  name: 'symbol',
  stateMutability: 'view',
  inputs: [],
  outputs: [{name: 'value', type: 'string'}],
}, {
  type: 'function',
  name: 'totalSupply',
  stateMutability: 'view',
  inputs: [],
  outputs: [{name: 'value', type: 'uint256'}],
}];

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function asBigInt(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  try { return BigInt(value); } catch { return fallback; }
}

function classifyWindow(startTime, endTime, chainTimestamp) {
  if (chainTimestamp < Number(startTime)) return 'not_started';
  if (chainTimestamp > Number(endTime)) return 'ended';
  return 'live';
}

function stageId(mode, params) {
  return `${mode}:${params.dropStageIndex}:${params.startTime}:${params.endTime}:${params.mintPrice}:${params.maxTotalMintableByWallet}`;
}

function serialParams(params) {
  return {
    mintPrice: params.mintPrice.toString(),
    mintPriceEth: formatEther(params.mintPrice),
    maxTotalMintableByWallet: params.maxTotalMintableByWallet.toString(),
    startTime: Number(params.startTime),
    endTime: Number(params.endTime),
    startAt: new Date(Number(params.startTime) * 1000).toISOString(),
    endAt: new Date(Number(params.endTime) * 1000).toISOString(),
    dropStageIndex: params.dropStageIndex.toString(),
    maxTokenSupplyForStage: params.maxTokenSupplyForStage.toString(),
    feeBps: params.feeBps.toString(),
    restrictFeeRecipients: params.restrictFeeRecipients,
  };
}

function normalizeEntries(input) {
  if (!input) return [];
  let parsed = input;
  if (typeof input === 'string') {
    try { parsed = JSON.parse(input); } catch { throw new Error('Whitelist credentials must be valid JSON.'); }
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    return Object.entries(parsed).map(([address, value]) => ({address, ...value}));
  }
  throw new Error('Whitelist credentials must be a JSON array or object.');
}

export function parseCredentialBundle(input) {
  const entries = normalizeEntries(input);
  const allowlistEntries = entries.filter((entry) => entry && entry.proof !== undefined);
  const signedEntries = entries.filter((entry) => entry && entry.signature !== undefined);
  const unknownEntries = entries.filter((entry) => entry && entry.proof === undefined && entry.signature === undefined);
  if (unknownEntries.length) throw new Error('Each whitelist credential must include proof or signature.');
  return {
    allowlist: allowlistEntries.length ? parseSeaDropCredentials(allowlistEntries, 'allowlist') : new Map(),
    signed: signedEntries.length ? parseSeaDropCredentials(signedEntries, 'signed') : new Map(),
  };
}

async function readMetadata({publicClient, contractAddress}) {
  const [name, symbol, totalSupply] = await Promise.allSettled(METADATA_ABI.map((abi) => (
    publicClient.readContract({address: contractAddress, abi: [abi], functionName: abi.name})
  )));
  return {
    name: name.status === 'fulfilled' ? String(name.value) : null,
    symbol: symbol.status === 'fulfilled' ? String(symbol.value) : null,
    totalSupply: totalSupply.status === 'fulfilled' ? asBigInt(totalSupply.value) : null,
  };
}

function serializePublicStage(inspection) {
  const params = {
    mintPrice: inspection.drop.mintPrice,
    maxTotalMintableByWallet: inspection.drop.maxTotalMintableByWallet,
    startTime: BigInt(inspection.drop.startTime),
    endTime: BigInt(inspection.drop.endTime),
    dropStageIndex: 0n,
    maxTokenSupplyForStage: inspection.globalStats?.maxSupply ?? 0n,
    feeBps: BigInt(inspection.drop.feeBps),
    restrictFeeRecipients: inspection.drop.restrictFeeRecipients,
  };
  return {
    id: 'public',
    type: 'public',
    label: 'Public 公开阶段',
    protocol: 'SeaDrop v1',
    source: 'on-chain',
    status: inspection.phase,
    credentialState: 'not_required',
    feeRecipient: inspection.feeRecipient,
    walletCount: inspection.walletStats.length,
    ...serialParams(params),
  };
}

function serializeCredentialStage({mode, inspection, params, walletCount}) {
  return {
    id: stageId(mode, params),
    type: mode,
    label: mode === 'allowlist' ? 'Merkle 白名单阶段' : 'Signed 签名阶段',
    protocol: 'SeaDrop v1',
    source: 'wallet credential',
    status: classifyWindow(params.startTime, params.endTime, inspection.chainTimestamp),
    credentialState: 'provided',
    feeRecipient: inspection.feeRecipient,
    walletCount,
    ...serialParams(params),
  };
}

function stageMatchesCatalog(stage, catalogStage) {
  if (!stage?.startTime || !stage?.endTime) return false;
  // A uuid on both sides settles it outright. Matching on the four parameters
  // alone mismatched parallel stages that happened to share them — an OG and a
  // WL round opening at the same second for the same price are identical under
  // this comparison, and the first one found won regardless of which the
  // credential actually belonged to.
  if (stage.uuid && catalogStage.uuid) return stage.uuid === catalogStage.uuid;
  return BigInt(stage.mintPrice) === BigInt(catalogStage.mintPrice)
    && Number(stage.startTime) === Number(catalogStage.startTime)
    && Number(stage.endTime) === Number(catalogStage.endTime)
    && BigInt(stage.maxTotalMintableByWallet) === BigInt(catalogStage.maxPerWallet);
}

function serializeCatalogStage({catalogStage, catalog, nativeStages, modeResults}) {
  const matchingCredential = catalogStage.category === 'allowlist'
    ? nativeStages.find((stage) => ['allowlist', 'signed'].includes(stage.type) && stageMatchesCatalog(stage, catalogStage))
    : null;
  const type = catalogStage.category === 'public'
    ? 'public'
    : matchingCredential?.type
      || (modeResults.get('allowlist')?.route ? 'allowlist' : null)
      || (modeResults.get('signed')?.route ? 'signed' : null)
      || 'allowlist';
  const startTime = Number(catalogStage.startTime);
  const endTime = Number(catalogStage.endTime);
  const categoryLabel = catalogStage.category === 'public' ? 'Public' : 'Allowlist';
  return {
    id: `opensea:${catalogStage.uuid}`,
    uuid: catalogStage.uuid,
    type,
    category: catalogStage.category,
    categoryLabel,
    label: `${catalogStage.label} · ${categoryLabel}`,
    protocol: 'SeaDrop v1',
    source: 'opensea-drops-api',
    status: classifyWindow(BigInt(startTime), BigInt(endTime), Number(catalog.chainTimestamp)),
    credentialState: catalogStage.category === 'public'
      ? 'not_required'
      : matchingCredential ? 'provided' : 'required',
    qualificationState: catalogStage.category === 'public' ? 'not_required' : 'unchecked',
    walletCount: matchingCredential?.walletCount || 0,
    linkedCredentialStageId: matchingCredential?.id || null,
    mintPrice: String(catalogStage.mintPrice),
    mintPriceEth: formatEther(BigInt(catalogStage.mintPrice)),
    maxTotalMintableByWallet: String(catalogStage.maxPerWallet),
    startTime,
    endTime,
    startAt: new Date(startTime * 1000).toISOString(),
    endAt: new Date(endTime * 1000).toISOString(),
    dropStageIndex: matchingCredential?.dropStageIndex ?? null,
    maxTokenSupplyForStage: matchingCredential?.maxTokenSupplyForStage ?? null,
    feeBps: matchingCredential?.feeBps ?? null,
    restrictFeeRecipients: matchingCredential?.restrictFeeRecipients ?? null,
    isOpenSeaActive: catalog.activeStageUuid === catalogStage.uuid,
  };
}

function publicWalletResult(inspection, stats, quantity) {
  if (!inspection) return {eligible: false, status: 'unsupported', reason: 'SeaDrop public configuration unavailable.'};
  if (stats?.error) return {eligible: false, status: 'unknown', reason: stats.error};
  if (inspection.phase === 'unconfigured') return {eligible: false, status: 'unsupported', reason: 'No SeaDrop public stage is configured.'};
  if (inspection.phase !== 'live') {
    return {eligible: false, status: inspection.phase, reason: inspection.phase === 'not_started' ? 'Public stage has not started.' : 'Public stage has ended.'};
  }
  if (BigInt(quantity) > stats.perWalletLeft) {
    return {eligible: false, status: 'limit_reached', reason: `Wallet allowance is ${stats.perWalletLeft}; requested ${quantity}.`};
  }
  if (inspection.supplyLeft !== null && BigInt(quantity) > inspection.supplyLeft) {
    return {eligible: false, status: 'sold_out', reason: 'Collection supply is insufficient.'};
  }
  return {eligible: true, status: 'eligible', reason: null};
}

async function inspectCredentialMode({publicClient, contractAddress, accounts, mode, credentials, quantity, env}) {
  if (!credentials.size) {
    try {
      const route = await inspectSeaDropCredentialRoute({publicClient, contractAddress, mode, env});
      return {route, stages: [], walletResults: new Map(), error: null};
    } catch {
      return {route: null, stages: [], walletResults: new Map(), error: null};
    }
  }
  let route;
  try {
    route = await inspectSeaDropCredentialRoute({publicClient, contractAddress, mode, env});
  } catch (error) {
    return {route: null, stages: [], walletResults: new Map(), error: errorMessage(error)};
  }
  const groups = new Map();
  for (const credential of credentials.values()) {
    const key = stageId(mode, credential.mintParams);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(credential);
  }
  const stages = [];
  const walletResults = new Map();
  const signerParamsCache = new Map();
  for (const [key, group] of groups) {
    const params = group[0].mintParams;
    stages.push(serializeCredentialStage({mode, inspection: route, params, walletCount: group.length}));
    for (const credential of group) {
      const account = accounts.find((item) => item.address.toLowerCase() === credential.address.toLowerCase());
      if (!account) continue;
      let result;
      try {
        const stats = await evaluateSeaDropCredential({
          publicClient,
          inspection: route,
          account,
          credential,
          allowInactive: true,
          quantity: BigInt(quantity),
          signerParamsCache,
        });
        const status = classifyWindow(params.startTime, params.endTime, route.chainTimestamp);
        result = {
          stageId: key,
          eligible: status === 'live',
          status: status === 'live' ? 'eligible' : status,
          reason: status === 'live' ? null : status === 'not_started' ? 'Whitelist stage has not started.' : 'Whitelist stage has ended.',
          perWalletLeft: params.maxTotalMintableByWallet > stats.minterNumMinted
            ? (params.maxTotalMintableByWallet - stats.minterNumMinted).toString()
            : '0',
        };
      } catch (error) {
        result = {stageId: key, eligible: false, status: 'ineligible', reason: errorMessage(error)};
      }
      walletResults.set(account.address.toLowerCase(), result);
    }
  }
  return {route, stages, walletResults, error: null};
}

export async function inspectNftIntelligence({
  publicClient,
  contractAddress,
  accounts = [],
  quantity = 1n,
  credentials = null,
  openSeaCatalog = null,
  openSeaCatalogError = null,
  openSeaWalletRoutes = [],
  openSeaWalletEligibilities = [],
  env = process.env,
}) {
  const config = loadAppConfig(env);
  const nftContract = getAddress(contractAddress);
  const bytecode = await publicClient.getBytecode({address: nftContract});
  if (!bytecode || bytecode === '0x') throw new Error('The NFT address has no contract bytecode on the selected chain.');
  const metadata = await readMetadata({publicClient, contractAddress: nftContract});
  let seaDropInspection = null;
  let seaDropError = null;
  try {
    seaDropInspection = await inspectSeaDrop({publicClient, contractAddress: nftContract, accounts, env});
  } catch (error) {
    seaDropError = errorMessage(error);
  }
  const bundle = credentials instanceof Object && credentials.allowlist instanceof Map
    ? credentials
    : parseCredentialBundle(credentials);
  for (const route of openSeaWalletRoutes) {
    if (route.status === 'ready' && route.credential && bundle[route.mode]) {
      bundle[route.mode].set(route.address.toLowerCase(), route.credential);
    }
  }
  const nativeStages = [];
  const modeResults = new Map();
  if (seaDropInspection) nativeStages.push(serializePublicStage(seaDropInspection));
  const inspectedModes = await Promise.all(['allowlist', 'signed'].map(async (mode) => ({
    mode,
    result: await inspectCredentialMode({
      publicClient,
      contractAddress: nftContract,
      accounts,
      mode,
      credentials: bundle[mode],
      quantity,
      env,
    }),
  })));
  for (const {mode, result} of inspectedModes) {
    modeResults.set(mode, result);
    if (result.stages.length) nativeStages.push(...result.stages);
  }
  const catalog = openSeaCatalog ? {...openSeaCatalog, chainTimestamp: seaDropInspection?.chainTimestamp || Math.floor(Date.now() / 1000)} : null;
  const stages = catalog?.stages?.length
    ? catalog.stages.map((stage) => serializeCatalogStage({catalogStage: stage, catalog, nativeStages, modeResults}))
    : nativeStages;
  if (catalog?.stages?.length) {
    const linked = new Set(stages.map((stage) => stage.linkedCredentialStageId).filter(Boolean));
    stages.push(...nativeStages.filter((stage) => stage.type !== 'public' && !linked.has(stage.id)));
  }
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const statsByAddress = new Map((seaDropInspection?.walletStats || []).map((item) => [item.address.toLowerCase(), item]));
  const openSeaRouteByAddress = new Map(openSeaWalletRoutes.map((route) => [route.address.toLowerCase(), route]));
  const openSeaEligibilityByAddress = new Map(openSeaWalletEligibilities.map((item) => [item.address.toLowerCase(), item]));
  const allowlistEligibilityResults = openSeaWalletEligibilities.filter((item) => item.status === 'ready').length;
  for (const stage of stages) {
    if (stage.category !== 'allowlist' || !openSeaCatalog) continue;
    const firstEligibilityFailure = openSeaWalletEligibilities.find((item) => item.status !== 'ready' && item.reason);
    stage.qualificationReason = firstEligibilityFailure?.reason || null;
    stage.qualificationState = accounts.length === 0
      ? 'unchecked'
      : allowlistEligibilityResults === accounts.length ? 'checked'
        : allowlistEligibilityResults > 0 ? 'partial' : 'error';
  }
  const wallets = accounts.map((account) => {
    const address = account.address.toLowerCase();
    const candidates = [];
    if (catalog?.stages?.length) {
      for (const stage of stages) {
        if (stage.source !== 'opensea-drops-api') continue;
        if (stage.category === 'public') {
          const result = publicWalletResult(seaDropInspection, statsByAddress.get(address), quantity);
          candidates.push({
            stageId: stage.id,
            ...result,
            qualified: !['unknown', 'unsupported', 'limit_reached', 'sold_out'].includes(result.status),
            eligible: stage.status === 'live' && result.eligible,
            status: stage.status === 'live' ? result.status : stage.status,
            reason: stage.status === 'live'
              ? result.reason
              : stage.status === 'not_started' ? 'Public stage has not started.' : 'Public stage has ended.',
          });
          continue;
        }
        const linked = stage.linkedCredentialStageId
          ? modeResults.get(stage.type)?.walletResults.get(address)
          : null;
        if (linked && linked.stageId === stage.linkedCredentialStageId) {
          candidates.push({...linked, stageId: stage.id, qualified: true});
          continue;
        }
        const openSeaEligibility = openSeaEligibilityByAddress.get(address);
        const stageEligibility = openSeaEligibility?.stages?.find((item) => item.stageUuid === stage.uuid);
        if (stageEligibility) {
          const qualified = stageEligibility.isEligible;
          const openSeaRoute = openSeaRouteByAddress.get(address);
          const routeReady = openSeaRoute?.status === 'ready' && openSeaRoute.stageUuid === stage.uuid;
          candidates.push({
            stageId: stage.id,
            eligible: qualified && stage.status === 'live' && routeReady,
            qualified,
            status: !qualified ? 'ineligible'
              : stage.status === 'not_started' ? 'not_started'
                : stage.status === 'ended' ? 'ended'
                  : routeReady ? 'eligible' : 'unknown',
            reason: !qualified ? 'OpenSea confirmed this wallet is not eligible for this stage.'
              : stage.status === 'not_started' ? 'OpenSea confirmed eligibility; mint credentials will be fetched when the stage opens.'
                : stage.status === 'ended' ? 'OpenSea confirmed eligibility, but this stage has ended.'
                  : routeReady ? null : 'Eligible, but an executable OpenSea Mint plan is not available yet.',
          });
          continue;
        }
        if (openSeaEligibility?.status === 'ready') {
          candidates.push({
            stageId: stage.id,
            eligible: false,
            qualified: false,
            status: 'ineligible',
            reason: 'OpenSea confirmed this wallet is not eligible for this stage.',
          });
          continue;
        }
        const openSeaRoute = openSeaRouteByAddress.get(address);
        if (['auth_failed', 'entitlement_denied', 'unknown'].includes(openSeaEligibility?.status)) {
          candidates.push({
            stageId: stage.id,
            eligible: false,
            qualified: false,
            status: 'credential_required',
            reason: openSeaEligibility.reason || 'OpenSea could not confirm this wallet for this stage.',
          });
          continue;
        }
        if (stage.isOpenSeaActive && openSeaRoute && openSeaRoute.status !== 'ready') {
          candidates.push({
            stageId: stage.id,
            eligible: false,
            qualified: false,
            status: openSeaRoute.status === 'ineligible' ? 'ineligible' : 'unknown',
            reason: openSeaRoute.reason || 'OpenSea could not confirm this wallet for the active stage.',
          });
          continue;
        }
        candidates.push({
          stageId: stage.id,
          eligible: false,
          qualified: false,
          status: 'credential_required',
          reason: 'OpenSea wallet eligibility has not been confirmed for this stage.',
        });
      }
    } else {
      if (seaDropInspection) candidates.push({stageId: 'public', ...publicWalletResult(seaDropInspection, statsByAddress.get(address), quantity)});
      for (const mode of ['allowlist', 'signed']) {
        const result = modeResults.get(mode)?.walletResults.get(address);
        if (result) candidates.push(result);
        else if (modeResults.get(mode)?.route) candidates.push({stageId: null, eligible: false, qualified: false, status: 'credential_required', reason: `SeaDrop ${mode} capability exists, but no sales-stage metadata or wallet credential was found.`});
      }
    }
    const eligible = candidates.filter((item) => item.eligible).sort((left, right) => {
      const leftPrice = asBigInt(stageById.get(left.stageId)?.mintPrice, 2n ** 256n - 1n);
      const rightPrice = asBigInt(stageById.get(right.stageId)?.mintPrice, 2n ** 256n - 1n);
      return leftPrice < rightPrice ? -1 : leftPrice > rightPrice ? 1 : 0;
    });
    const qualified = candidates.filter((item) => item.qualified);
    const upcoming = candidates.filter((item) => item.status === 'not_started').sort((left, right) => (
      Number(stageById.get(left.stageId)?.startTime || Number.MAX_SAFE_INTEGER)
      - Number(stageById.get(right.stageId)?.startTime || Number.MAX_SAFE_INTEGER)
    ));
    const recommended = eligible[0] || upcoming[0] || null;
    return {
      address: account.address,
      status: eligible.length ? 'eligible'
        : upcoming.length ? 'upcoming'
          : candidates.some((item) => item.status === 'credential_required') ? 'unknown' : 'ineligible',
      eligibleStageIds: eligible.map((item) => item.stageId),
      qualifiedStageIds: qualified.map((item) => item.stageId),
      recommendedStageId: recommended?.stageId || null,
      stages: candidates,
    };
  });
  for (const stage of stages) {
    stage.walletCount = wallets.filter((wallet) => (
      wallet.stages.some((candidate) => candidate.stageId === stage.id && candidate.qualified)
    )).length;
  }
  const currentSupply = seaDropInspection?.globalStats?.currentTotalSupply
    ?? metadata.totalSupply
    ?? asBigInt(catalog?.totalSupply);
  const maxSupply = seaDropInspection?.globalStats?.maxSupply ?? asBigInt(catalog?.maxSupply);
  return {
    chainId: publicClient.chain?.id || await publicClient.getChainId(),
    nftContract,
    name: catalog?.name || metadata.name || seaDropInspection?.name || null,
    symbol: metadata.symbol,
    protocol: seaDropInspection ? 'SeaDrop v1' : 'unknown',
    seaDrop: seaDropInspection?.seaDrop || config.seaDrop.address,
    creatorPayout: seaDropInspection?.creatorPayout || null,
    openSea: catalog ? {
      slug: catalog.slug,
      url: catalog.openSeaUrl,
      dropType: catalog.dropType,
      source: catalog.source,
      accessSource: catalog.accessSource,
      accessExpiresAt: catalog.accessExpiresAt,
    } : null,
    openSeaError: openSeaCatalogError,
    credentialCapabilities: {
      allowlist: Boolean(modeResults.get('allowlist')?.route),
      signed: Boolean(modeResults.get('signed')?.route),
    },
    chainTimestamp: seaDropInspection?.chainTimestamp || null,
    currentSupply: currentSupply?.toString() ?? null,
    maxSupply: maxSupply?.toString() ?? null,
    supplyLeft: currentSupply !== null && maxSupply !== null
      ? (maxSupply > currentSupply ? maxSupply - currentSupply : 0n).toString()
      : null,
    seaDropError,
    stages,
    wallets,
  };
}
