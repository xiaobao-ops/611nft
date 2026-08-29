export const APP_ROUTES = [
  {
    id: "wallet-manager",
    path: "/tool/walletManager/walletManager",
    label: "钱包管理",
    kind: "runtime",
    moduleName: "walletManager",
  },
  {
    id: "token-disperse",
    path: "/tool/walletManager/ethDisperse",
    label: "分发代币",
    kind: "runtime",
    moduleName: "ethDisperse",
  },
  {
    id: "token-collect",
    path: "/tool/walletManager/ethCollection",
    label: "归集代币",
    kind: "runtime",
    moduleName: "ethCollection",
  },
  {
    id: "many-to-many",
    path: "/tool/walletManager/moreToMore",
    label: "多对多转账",
    kind: "runtime",
    moduleName: "moreToMore",
  },
  {
    id: "exchange-deposit",
    path: "/tool/walletManager/despositToExchange",
    label: "交易所充值",
    kind: "runtime",
    moduleName: "despositToExchange",
  },
  {
    id: "mint-monitor",
    path: "/tool/mint",
    label: "NFT 盯盘",
    kind: "runtime",
    moduleName: "mint",
  },
  {
    id: "follow-mint",
    path: "/tool/documentaryList",
    label: "跟单/自动铸造",
    kind: "runtime",
    moduleName: "documentaryList",
  },
  {
    id: "signature-lab",
    path: "/tool/highHexMint/signTask",
    label: "项目破签",
    kind: "runtime",
    moduleName: "signTask",
  },
  {
    id: "advanced-mint",
    path: "/tool/highHexMint/highHexMint",
    label: "高级铸造",
    kind: "runtime",
    moduleName: "highHexMint",
  },
  {
    id: "opensea",
    path: "/tool/highHexMint/opensea",
    label: "OpenSea",
    kind: "runtime",
    moduleName: "opensea",
  },
  {
    id: "batch-sell",
    path: "/tool/batchSell/batchSell",
    label: "批量挂单",
    kind: "runtime",
    moduleName: "batchSell",
  },
  {
    id: "nft-collect",
    path: "/tool/batchSell/collectionNFT",
    label: "NFT 归集",
    kind: "runtime",
    moduleName: "collectionNFT",
  },
  {
    id: "batch-approve",
    path: "/tool/batchSell/batchApprove",
    label: "批量授权",
    kind: "runtime",
    moduleName: "batchApprove",
  },
  {
    id: "wallet-alert",
    path: "/tool/walletAlert",
    label: "报警监控",
    kind: "alarm",
  },
  {
    id: "transactions",
    path: "/tool/transactions",
    label: "交易记录",
    kind: "transactions",
  },
]

export const MENU_SECTIONS = [
  {
    id: "wallets",
    label: "钱包管理",
    routeIds: ["wallet-manager", "token-disperse", "token-collect", "many-to-many", "exchange-deposit"],
  },
  { id: "mint-monitor", routeIds: ["mint-monitor"] },
  { id: "follow-mint", routeIds: ["follow-mint"] },
  {
    id: "advanced",
    label: "高级铸造",
    routeIds: ["signature-lab", "advanced-mint", "opensea"],
  },
  {
    id: "nft-management",
    label: "批量挂单",
    routeIds: ["batch-sell", "nft-collect", "batch-approve"],
  },
  { id: "wallet-alert", routeIds: ["wallet-alert"] },
  { id: "transactions", routeIds: ["transactions"] },
]

const routesById = new Map(APP_ROUTES.map((route) => [route.id, route]))
const routesByPath = new Map(APP_ROUTES.map((route) => [route.path, route]))

export function menuRoutes(section) {
  return section.routeIds.map((routeId) => routesById.get(routeId)).filter(Boolean)
}

export function normalizePathname(pathname = "/") {
  const raw = String(pathname || "/").split(/[?#]/, 1)[0] || "/"
  const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`
  const compact = withLeadingSlash.replace(/\/{2,}/g, "/")
  return compact.length > 1 ? compact.replace(/\/+$/, "") : "/"
}

const DEFAULT_PATH = APP_ROUTES[0].path
const routeAliases = new Map()

for (const route of APP_ROUTES) {
  routeAliases.set(route.path, route.path)
  routeAliases.set(route.path.replace(/^\/tool/, ""), route.path)
}

for (const alias of ["/", "/tool", "/welcome", "/tool/welcome", "/walletManager", "/tool/walletManager"]) {
  routeAliases.set(alias, DEFAULT_PATH)
}

routeAliases.set("/walletManager/disperse", "/tool/walletManager/ethDisperse")
routeAliases.set("/tool/walletManager/disperse", "/tool/walletManager/ethDisperse")
routeAliases.set("/walletManager/collect", "/tool/walletManager/ethCollection")
routeAliases.set("/tool/walletManager/collect", "/tool/walletManager/ethCollection")
routeAliases.set("/highHexMint", "/tool/highHexMint/highHexMint")
routeAliases.set("/tool/highHexMint", "/tool/highHexMint/highHexMint")
routeAliases.set("/highHexMint/contract", "/tool/highHexMint/highHexMint")
routeAliases.set("/tool/highHexMint/contract", "/tool/highHexMint/highHexMint")
routeAliases.set("/batchSell", "/tool/batchSell/batchSell")
routeAliases.set("/tool/batchSell", "/tool/batchSell/batchSell")
routeAliases.set("/opensea", "/tool/highHexMint/opensea")
routeAliases.set("/tool/opensea", "/tool/highHexMint/opensea")

export function resolveRoute(pathname) {
  const requestedPath = normalizePathname(pathname)
  const canonicalPath = routeAliases.get(requestedPath)
  if (!canonicalPath) return { requestedPath, canonicalPath: "", route: null, redirected: false }
  return {
    requestedPath,
    canonicalPath,
    route: routesByPath.get(canonicalPath) || null,
    redirected: requestedPath !== canonicalPath,
  }
}
