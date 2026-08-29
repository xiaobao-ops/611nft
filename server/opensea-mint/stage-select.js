// Choosing which OpenSea drop stage to arm.
//
// This lived inline in server/index.js and took only the catalog, which meant
// the choice was made without ever seeing a wallet address. With an OG round and
// a WL round overlapping — same contract, often the same price and window — every
// selected wallet was armed against whichever stage sorted first, so a wallet
// holding only a WL spot was pointed at the OG round and failed there. It moved
// here so the selection can be tested directly against those overlapping shapes
// rather than only through the preview route.

function selectionError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

// Which stage uuids at least one of the selected wallets can mint, according to
// OpenSea's per-wallet eligibility lookup.
//
// `answered` is what separates "OpenSea told us these wallets qualify for
// nothing" from "we never got an answer". Both produce an empty uuid set, but
// they call for opposite handling: the first is a real result worth refusing on,
// the second must leave the catalog-only choice alone. Only a wallet whose
// lookup reached OpenSea and came back carries status 'ready' — every failure
// path in wallet-auth.js reports auth_failed, entitlement_denied or unknown.
export function eligibleStageUuids(eligibilities = []) {
  const uuids = new Set();
  let answered = false;
  for (const wallet of eligibilities) {
    if (wallet?.status === 'ready') answered = true;
    for (const stage of wallet?.stages || []) {
      if (stage?.isEligible && stage.stageUuid) uuids.add(stage.stageUuid);
    }
  }
  return {uuids, answered};
}

// Scheduled auto mode arms a future OpenSea Allowlist stage: an explicitly
// requested UUID wins, then the stage covering the requested time, then the
// earliest stage still open.
//
// Eligibility stays advisory. The lookup needs a SIWE session per address and is
// allowed to fail — the inspect path treats it the same way — so an empty result
// means "we do not know", not "nothing qualifies", and the catalog-only choice
// runs unchanged. Only a lookup that succeeded and named some stages narrows the
// candidates; if it named stages but none of them survive, that is a real answer
// and worth refusing rather than silently arming a stage the wallets cannot use.
export function pickOpenSeaAllowlistStage(catalog, {
  stageUuid = '',
  scheduleAt = null,
  eligibilities = [],
  nowSeconds = Math.floor(Date.now() / 1000),
} = {}) {
  const stages = catalog?.stages || [];
  const requestedUuid = String(stageUuid || '').trim();
  if (requestedUuid) {
    const stage = stages.find((item) => item.uuid === requestedUuid);
    if (!stage) throw selectionError('指定的 OpenSea 阶段不存在');
    const {uuids, answered} = eligibleStageUuids(eligibilities);
    if (answered && !uuids.has(requestedUuid)) {
      throw selectionError('所选钱包在指定的 OpenSea 阶段没有资格');
    }
    return stage;
  }
  const allowlistStages = stages.filter((item) => item.category === 'allowlist');
  const {uuids: eligibleUuids, answered} = eligibleStageUuids(eligibilities);
  const candidates = answered
    ? allowlistStages.filter((item) => eligibleUuids.has(item.uuid))
    : allowlistStages;
  if (answered && !candidates.length) {
    throw selectionError('所选钱包在任何 OpenSea Allowlist 阶段都没有资格，请先在情报里确认阶段与钱包');
  }
  const scheduleTimestamp = scheduleAt ? Math.floor(Date.parse(scheduleAt) / 1000) : null;
  const stage = Number.isFinite(scheduleTimestamp)
    ? candidates.find((item) => scheduleTimestamp >= item.startTime && scheduleTimestamp <= item.endTime)
    : candidates
      .filter((item) => item.endTime >= nowSeconds)
      .sort((left, right) => left.startTime - right.startTime)[0];
  if (!stage) throw selectionError('没有匹配的未来 OpenSea Allowlist 阶段，请先在情报里选择阶段');
  return stage;
}

export function selectOpenSeaStagesForWallets(catalog, {
  accounts = [],
  stageUuid = '',
  scheduleAt = null,
  eligibilities = [],
  nowSeconds = Math.floor(Date.now() / 1000),
} = {}) {
  const eligibilityByAddress = new Map(eligibilities
    .filter((item) => item?.address)
    .map((item) => [String(item.address).toLowerCase(), item]));
  const selected = [];
  const rejected = [];

  for (const account of accounts) {
    const address = String(account?.address || '');
    const eligibility = eligibilityByAddress.get(address.toLowerCase());
    try {
      const stage = pickOpenSeaAllowlistStage(catalog, {
        stageUuid,
        scheduleAt,
        eligibilities: eligibility ? [eligibility] : [],
        nowSeconds,
      });
      selected.push({
        account,
        address,
        stage,
        eligibility: eligibility?.status === 'ready' ? 'confirmed' : 'unknown',
      });
    } catch (error) {
      rejected.push({
        account,
        address,
        reason: error instanceof Error ? error.message : String(error),
        explicitlyIneligible: eligibility?.status === 'ready',
      });
    }
  }
  return {selected, rejected};
}

export function openSeaStageIdentity({chainId, contractAddress, stage}) {
  return {
    chainId: Number(chainId),
    contractAddress: String(contractAddress || '').toLowerCase(),
    uuid: String(stage?.uuid || ''),
    kind: String(stage?.kind || stage?.stageType || ''),
    startTime: Number(stage?.startTime),
    endTime: Number(stage?.endTime),
    mintPrice: String(stage?.mintPrice ?? ''),
    currencyAddress: String(stage?.currencyAddress || '').toLowerCase(),
    maxPerWallet: String(stage?.maxPerWallet ?? ''),
    stageSupply: String(stage?.stageSupply ?? ''),
    feeBps: String(stage?.feeBps ?? ''),
    feeRecipient: String(stage?.feeRecipient || '').toLowerCase(),
    restrictFeeRecipients: Boolean(stage?.restrictFeeRecipients),
  };
}

function identityKey(identity) {
  return JSON.stringify([
    identity.chainId,
    identity.contractAddress,
    identity.uuid,
    identity.kind,
    identity.startTime,
    identity.endTime,
    identity.mintPrice,
    identity.currencyAddress,
    identity.maxPerWallet,
    identity.stageSupply,
    identity.feeBps,
    identity.feeRecipient,
    identity.restrictFeeRecipients,
  ]);
}

export function groupOpenSeaStageSelections({chainId, contractAddress, selections = []}) {
  const groups = new Map();
  for (const selection of selections) {
    const identity = openSeaStageIdentity({chainId, contractAddress, stage: selection.stage});
    const key = identityKey(identity);
    const group = groups.get(key) || {identity, stage: selection.stage, selections: []};
    group.selections.push(selection);
    groups.set(key, group);
  }
  return [...groups.values()];
}
