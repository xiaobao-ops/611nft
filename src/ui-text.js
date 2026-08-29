const STATUS_TEXT = {
  ready: "就绪",
  failed: "失败",
  skipped: "已跳过",
  running: "运行中",
  previewed: "已预览",
  completed: "已完成",
  partial: "部分完成",
  confirmation_pending: "待确认",
  scheduled: "已定时",
  stopping: "停止中",
  stopped: "已停止",
  sending: "发送中",
  pending: "待处理",
  confirmed: "已确认",
  replaced: "已替换",
  success: "成功",
  done: "完成",
  error: "错误",
  idle: "空闲",
  minted: "已铸造",
  "already-minted": "已铸造",
  "needs-inspection": "需要检查",
  "dry-run-ready": "演练就绪",
  loading: "加载中",
  armed: "自动广播中",
}

const DECISION_TEXT = {
  matched: "匹配成功",
  event_unconfirmed: "事件尚未确认",
  outside_time_window: "不在设定时间内",
  event_value_unavailable: "事件金额未知",
  paid_mint: "付费铸造已被排除",
  event_value_above_limit: "事件金额超过上限",
  gas_limit_unavailable: "Gas 上限未知",
  gas_limit_above_limit: "Gas 上限超过限制",
  parameter_count_unavailable: "调用参数数量未知",
  parameter_count_mismatch: "调用参数数量不匹配",
  mint_quantity_below_limit: "铸造数量低于下限",
  mint_quantity_above_limit: "铸造数量超过上限",
  max_supply_below_limit: "最大供应量低于下限",
  erc1155_excluded: "已排除 ERC1155",
  duplicate_event: "重复事件",
  cooldown_active: "规则仍在冷却期",
  rule_already_running: "规则正在运行",
  preparing: "准备中",
}

const TRANSACTION_TYPE_TEXT = {
  one_to_many: "一对多分发",
  many_to_one: "多对一归集",
  many_to_many: "多对多转账",
  approval: "授权",
  contract_call: "合约调用",
  nft_mint: "NFT 铸造",
  advanced_mint: "高级铸造",
  advanced_mint_cancel: "取消高级铸造交易",
  advanced_mint_accelerate: "加速高级铸造交易",
}

export function uiStatus(value) {
  const key = String(value || "").trim().toLowerCase()
  return STATUS_TEXT[key] || (key ? "处理中" : "—")
}

export function uiDecisionReason(value) {
  const text = String(value || "").trim()
  if (!text) return "—"
  if (DECISION_TEXT[text]) return DECISION_TEXT[text]
  if (text.startsWith("blocked_keyword:")) return `命中屏蔽关键词：${text.slice(16)}`
  if (text.startsWith("platform_excluded:")) return `已排除平台：${text.slice(18)}`
  return uiError(text)
}

export function uiLogLevel(value) {
  return { info: "信息", success: "成功", warning: "警告", error: "错误" }[value] || "记录"
}

export function uiWalletSource(value) {
  return { "root-env": "本地密钥", default: "默认钱包", agent: "外部钱包" }[value] || "本地钱包"
}

export function uiTransactionType(value) {
  return TRANSACTION_TYPE_TEXT[value] || "链上交易"
}

export function uiSignatureMode(value) {
  return { public: "公开阶段", signed: "签名阶段", allowlist: "白名单阶段", unknown: "未知阶段" }[value] || "未知阶段"
}

export function uiError(value) {
  const text = String(value || "").trim()
  if (!text) return ""
  const translated = text
    .replace(/execution reverted|transaction reverted on-chain/ig, "合约执行已在链上回退")
    .replace(/insufficient (?:funds|balance)/ig, "钱包余额不足")
    .replace(/nonce too low/ig, "交易序号过低")
    .replace(/request failed/ig, "请求失败")
    .replace(/fetch failed/ig, "网络请求失败")
    .replace(/timed out|timeout/ig, "请求超时")
    .replace(/not found/ig, "未找到")
    .replace(/has expired/ig, "已过期")
  if (/[\u3400-\u9fff]/.test(translated)) {
    const unknownWords = translated
      .replace(/\b(?:RPC|HTTP|HTTPS|Gas|Gwei|wei|calldata|selector|nonce|EIP|JSON|NFT|OpenSea|SeaDrop|ABI|Hex|ERC20|ERC721|ERC1155|eth_call|SIGINT)\b/gi, "")
      .match(/\b[A-Za-z]{2,}\b/)
    if (!unknownWords) return translated
    const prefix = translated.split(/[：:]/)[0].trim()
    return /[\u3400-\u9fff]/.test(prefix) && prefix.length >= 4 ? `${prefix}。` : "操作失败，请检查输入参数与链上状态。"
  }
  if (/request failed/i.test(text)) return "请求失败，请检查本地服务状态。"
  if (/timeout|timed out/i.test(text)) return "请求超时，请稍后重试。"
  if (/insufficient (?:funds|balance)/i.test(text)) return "钱包余额不足。"
  if (/execution reverted|reverted on-chain/i.test(text)) return "合约执行已在链上回退。"
  if (/nonce too low/i.test(text)) return "交易序号过低，请刷新后重试。"
  if (/network|fetch failed|none response/i.test(text)) return "网络请求失败，请检查 RPC 与本地服务。"
  if (/not found|has expired/i.test(text)) return "目标记录不存在或已过期。"
  return "操作失败，请检查输入参数与链上状态。"
}
