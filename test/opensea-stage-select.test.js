import assert from 'node:assert/strict';
import test from 'node:test';
import {classifyStageKind} from '../server/opensea-mint/drops.js';
import {
  eligibleStageUuids,
  groupOpenSeaStageSelections,
  pickOpenSeaAllowlistStage,
  selectOpenSeaStagesForWallets,
} from '../server/opensea-mint/stage-select.js';

// The shapes below mirror an OpenSea drop that runs an OG round and a WL round
// against the same contract. Both are category "allowlist", both open at the
// same second, and both charge the same price — the case where selecting by
// catalog order silently arms the wrong one.
const OG_UUID = 'aaaaaaaa-0000-4000-8000-000000000001';
const WL_UUID = 'bbbbbbbb-0000-4000-8000-000000000002';
const PUBLIC_UUID = 'cccccccc-0000-4000-8000-000000000003';

const OPEN_AT = 2_000_000_000;
const CLOSE_AT = 2_000_003_600;

function stage(uuid, kind, overrides = {}) {
  return {
    uuid,
    label: kind,
    stageType: kind,
    kind,
    category: kind === 'public' ? 'public' : 'allowlist',
    mintPrice: '1000',
    currencyAddress: '0x0000000000000000000000000000000000000000',
    startTime: OPEN_AT,
    endTime: CLOSE_AT,
    maxPerWallet: '1',
    stageSupply: '3333',
    feeBps: '250',
    feeRecipient: '0x4000000000000000000000000000000000000004',
    restrictFeeRecipients: true,
    ...overrides,
  };
}

// OG is listed first, so any "take the first one" selection returns OG.
const CATALOG = {
  stages: [
    stage(OG_UUID, 'og'),
    stage(WL_UUID, 'wl'),
    stage(PUBLIC_UUID, 'public'),
  ],
};

function eligibility(address, uuids) {
  return {
    address,
    status: 'ready',
    stages: [
      {stageUuid: OG_UUID, isEligible: uuids.includes(OG_UUID)},
      {stageUuid: WL_UUID, isEligible: uuids.includes(WL_UUID)},
    ],
  };
}

const BEFORE_OPEN = OPEN_AT - 600;

test('stage_type keeps the distinction OpenSea draws, not just public vs allowlist', () => {
  assert.equal(classifyStageKind('public_sale'), 'public');
  assert.equal(classifyStageKind('og'), 'og');
  assert.equal(classifyStageKind('allowlist'), 'wl');
  assert.equal(classifyStageKind('waitlist'), 'waitlist');
  assert.equal(classifyStageKind('guaranteed'), 'guaranteed');
  assert.equal(classifyStageKind('presale'), 'presale');
  assert.equal(classifyStageKind('fcfs'), 'fcfs');
});

test('stage_type matching is case-insensitive and tolerates decorated names', () => {
  assert.equal(classifyStageKind('OG'), 'og');
  assert.equal(classifyStageKind('og_stage'), 'og');
  assert.equal(classifyStageKind('early_public_sale'), 'public');
});

// An unknown stage type must not be mistaken for an open mint: guessing "public"
// on a gated stage burns the attempt, while guessing gated only costs a retry.
test('an unrecognised stage type falls back to a gated kind', () => {
  assert.equal(classifyStageKind('something_new'), 'wl');
  assert.equal(classifyStageKind(''), 'wl');
  assert.equal(classifyStageKind(undefined), 'wl');
});

test('a wallet eligible only for WL is armed against WL, not the OG stage listed first', () => {
  const picked = pickOpenSeaAllowlistStage(CATALOG, {
    eligibilities: [eligibility('0xwallet', [WL_UUID])],
    nowSeconds: BEFORE_OPEN,
  });
  assert.equal(picked.uuid, WL_UUID);
  assert.equal(picked.kind, 'wl');
});

test('a wallet eligible only for OG still gets OG', () => {
  const picked = pickOpenSeaAllowlistStage(CATALOG, {
    eligibilities: [eligibility('0xwallet', [OG_UUID])],
    nowSeconds: BEFORE_OPEN,
  });
  assert.equal(picked.uuid, OG_UUID);
});

// Losing the eligibility lookup must not change which mints are possible, only
// how precisely they are targeted.
test('no eligibility data leaves the catalog-only choice untouched', () => {
  const picked = pickOpenSeaAllowlistStage(CATALOG, {eligibilities: [], nowSeconds: BEFORE_OPEN});
  assert.equal(picked.uuid, OG_UUID, 'falls back to the earliest open allowlist stage');
});

test('an eligibility lookup that failed for every wallet is treated as unknown, not as ineligible', () => {
  const failed = [{address: '0xwallet', status: 'unauthorized', reason: 'expired', stages: []}];
  const picked = pickOpenSeaAllowlistStage(CATALOG, {eligibilities: failed, nowSeconds: BEFORE_OPEN});
  assert.equal(picked.uuid, OG_UUID);
});

// A lookup that succeeded and returned nothing eligible is a real answer.
test('wallets eligible for no stage are refused rather than armed against one', () => {
  const none = [eligibility('0xwallet', [])];
  assert.throws(
    () => pickOpenSeaAllowlistStage(CATALOG, {eligibilities: none, nowSeconds: BEFORE_OPEN}),
    (error) => error.status === 400 && /没有资格/.test(error.message),
  );
});

test('an explicitly requested stage cannot override a negative OpenSea answer', () => {
  assert.throws(() => pickOpenSeaAllowlistStage(CATALOG, {
    stageUuid: OG_UUID,
    eligibilities: [eligibility('0xwallet', [WL_UUID])],
    nowSeconds: BEFORE_OPEN,
  }), /没有资格/);
});

test('an explicitly requested stage remains usable when eligibility lookup failed', () => {
  const picked = pickOpenSeaAllowlistStage(CATALOG, {
    stageUuid: OG_UUID,
    eligibilities: [{address: '0xwallet', status: 'auth_failed', stages: []}],
    nowSeconds: BEFORE_OPEN,
  });
  assert.equal(picked.uuid, OG_UUID);
});

test('an unknown requested stage is rejected', () => {
  assert.throws(
    () => pickOpenSeaAllowlistStage(CATALOG, {stageUuid: 'no-such-stage'}),
    (error) => error.status === 400,
  );
});

// Union across wallets: a batch holding both an OG and a WL wallet must keep
// both stages in play rather than dropping either.
test('eligibility is unioned across the selected wallets', () => {
  const {uuids, answered} = eligibleStageUuids([
    eligibility('0xone', [OG_UUID]),
    eligibility('0xtwo', [WL_UUID]),
  ]);
  assert.equal(answered, true);
  assert.deepEqual([...uuids].sort(), [OG_UUID, WL_UUID].sort());
});

// The two empty-set cases have to stay distinguishable, since they call for
// opposite handling in pickOpenSeaAllowlistStage.
test('a failed lookup and a negative answer are told apart', () => {
  const failed = eligibleStageUuids([{address: '0xone', status: 'auth_failed', stages: []}]);
  assert.equal(failed.answered, false, 'no answer reached us');
  assert.equal(failed.uuids.size, 0);

  const negative = eligibleStageUuids([eligibility('0xone', [])]);
  assert.equal(negative.answered, true, 'OpenSea answered: nothing qualifies');
  assert.equal(negative.uuids.size, 0);
});

// A mixed batch still counts as answered, and the wallet that did resolve decides.
test('one wallet answering is enough to narrow the choice', () => {
  const picked = pickOpenSeaAllowlistStage(CATALOG, {
    eligibilities: [
      {address: '0xone', status: 'auth_failed', stages: []},
      eligibility('0xtwo', [WL_UUID]),
    ],
    nowSeconds: BEFORE_OPEN,
  });
  assert.equal(picked.uuid, WL_UUID);
});

test('mixed OG and WL wallets are selected independently instead of unioned into one stage', () => {
  const accounts = [{address: '0xone'}, {address: '0xtwo'}];
  const result = selectOpenSeaStagesForWallets(CATALOG, {
    accounts,
    eligibilities: [eligibility('0xone', [OG_UUID]), eligibility('0xtwo', [WL_UUID])],
    nowSeconds: BEFORE_OPEN,
  });
  assert.deepEqual(result.selected.map((item) => [item.address, item.stage.uuid]), [
    ['0xone', OG_UUID],
    ['0xtwo', WL_UUID],
  ]);
  assert.equal(result.rejected.length, 0);
});

test('a confirmed-ineligible wallet is rejected while failed lookup wallets retain fallback', () => {
  const result = selectOpenSeaStagesForWallets(CATALOG, {
    accounts: [{address: '0xnegative'}, {address: '0xunknown'}],
    stageUuid: OG_UUID,
    eligibilities: [
      eligibility('0xnegative', []),
      {address: '0xunknown', status: 'auth_failed', stages: []},
    ],
    nowSeconds: BEFORE_OPEN,
  });
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].address, '0xunknown');
  assert.equal(result.selected[0].stage.uuid, OG_UUID);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].reason, /没有资格/);
});

test('complete stage identity controls grouping, including fee and supply fields', () => {
  const base = stage(OG_UUID, 'og');
  const changedFee = {...base, feeBps: '300'};
  const changedSupply = {...base, stageSupply: '4000'};
  const groups = groupOpenSeaStageSelections({
    chainId: 1,
    contractAddress: '0x1000000000000000000000000000000000000001',
    selections: [
      {address: '0xone', account: {address: '0xone'}, stage: base},
      {address: '0xtwo', account: {address: '0xtwo'}, stage: {...base}},
      {address: '0xthree', account: {address: '0xthree'}, stage: changedFee},
      {address: '0xfour', account: {address: '0xfour'}, stage: changedSupply},
    ],
  });
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map((group) => group.selections.length).sort(), [1, 1, 2]);
  assert.equal(groups[0].identity.chainId, 1);
  assert.equal(groups[0].identity.contractAddress, '0x1000000000000000000000000000000000000001');
});

test('a scheduled time selects the stage whose window covers it', () => {
  const later = stage('dddddddd-0000-4000-8000-000000000004', 'wl', {
    startTime: CLOSE_AT + 100,
    endTime: CLOSE_AT + 3600,
  });
  const catalog = {stages: [...CATALOG.stages, later]};
  const picked = pickOpenSeaAllowlistStage(catalog, {
    scheduleAt: new Date((CLOSE_AT + 200) * 1000).toISOString(),
    nowSeconds: BEFORE_OPEN,
  });
  assert.equal(picked.uuid, later.uuid);
});

test('a scheduled time outside every window is refused', () => {
  assert.throws(
    () => pickOpenSeaAllowlistStage(CATALOG, {
      scheduleAt: new Date((CLOSE_AT + 100_000) * 1000).toISOString(),
      nowSeconds: BEFORE_OPEN,
    }),
    (error) => error.status === 400,
  );
});

// The public stage shares the contract but is never what scheduled auto mode arms.
test('public stages are never selected as the allowlist stage', () => {
  const publicOnly = {stages: [stage(PUBLIC_UUID, 'public')]};
  assert.throws(
    () => pickOpenSeaAllowlistStage(publicOnly, {nowSeconds: BEFORE_OPEN}),
    (error) => error.status === 400,
  );
});

test('a stage that has already closed is not armed', () => {
  const picked = pickOpenSeaAllowlistStage({
    stages: [
      stage('eeeeeeee-0000-4000-8000-000000000005', 'og', {startTime: 1000, endTime: 2000}),
      stage(WL_UUID, 'wl'),
    ],
  }, {nowSeconds: BEFORE_OPEN});
  assert.equal(picked.uuid, WL_UUID);
});
