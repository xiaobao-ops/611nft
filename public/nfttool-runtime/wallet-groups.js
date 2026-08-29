export const SELECTED_WALLETS_KEY = 'nfttool:selected-wallets';
export const UNGROUPED_LABEL = '未分组';

export function normalizeWalletGroup(value) {
  let output = '';
  for (const character of String(value ?? '')) {
    const code = character.codePointAt(0);
    output += code < 32 || code === 127 ? ' ' : character;
  }
  return output.trim().slice(0, 80);
}

export function normalizeWalletIds(values = []) {
  const ids = [];
  const seen = new Set();
  for (const value of values || []) {
    const id = String(value ?? '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function groupWallets(wallets = [], { excludedIds = [] } = {}) {
  const excluded = new Set(normalizeWalletIds(excludedIds));
  const seenWalletIds = new Set();
  const grouped = new Map();

  for (const wallet of wallets || []) {
    const id = String(wallet?.id ?? '');
    if (!id || excluded.has(id) || seenWalletIds.has(id)) continue;
    seenWalletIds.add(id);
    const key = normalizeWalletGroup(wallet?.group);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(id);
  }

  const named = [...grouped.entries()]
    .filter(([key]) => key)
    .sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))
    .map(([key, walletIds]) => ({ key, label: key, walletIds }));
  const ungrouped = grouped.get('');
  if (ungrouped?.length) named.push({ key: '', label: UNGROUPED_LABEL, walletIds: ungrouped });
  return named;
}

export function walletGroupSelection(selectedIds = [], groupIds = []) {
  const selected = new Set(normalizeWalletIds(selectedIds));
  const walletIds = normalizeWalletIds(groupIds);
  const selectedCount = walletIds.filter((id) => selected.has(id)).length;
  return {
    selectedCount,
    total: walletIds.length,
    complete: walletIds.length > 0 && selectedCount === walletIds.length,
    partial: selectedCount > 0 && selectedCount < walletIds.length,
  };
}

export function toggleWalletGroup(selectedIds = [], groupIds = []) {
  const current = normalizeWalletIds(selectedIds);
  const group = normalizeWalletIds(groupIds);
  const selection = walletGroupSelection(current, group);
  if (selection.complete) {
    const removed = new Set(group);
    return current.filter((id) => !removed.has(id));
  }
  const selected = new Set(current);
  for (const id of group) {
    if (!selected.has(id)) current.push(id);
    selected.add(id);
  }
  return current;
}

export function readStoredWalletIds(storage) {
  try {
    const target = storage || globalThis.localStorage;
    const parsed = JSON.parse(target?.getItem(SELECTED_WALLETS_KEY) || '[]');
    return Array.isArray(parsed) ? normalizeWalletIds(parsed) : [];
  } catch {
    return [];
  }
}

export function reconcileWalletIds(selectedIds = [], wallets = []) {
  const valid = new Set(normalizeWalletIds((wallets || []).map((wallet) => wallet?.id)));
  return normalizeWalletIds(selectedIds).filter((id) => valid.has(id));
}

export function writeStoredWalletIds(selectedIds = [], storage) {
  const ids = normalizeWalletIds(selectedIds);
  try {
    const target = storage || globalThis.localStorage;
    target?.setItem(SELECTED_WALLETS_KEY, JSON.stringify(ids));
  } catch {
    // Selection remains usable in memory when storage is unavailable.
  }
  return ids;
}
