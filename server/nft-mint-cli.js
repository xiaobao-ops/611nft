import { createInterface } from "node:readline/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { isAddress } from "viem"

const DEFAULT_API_BASE = process.env.WALLET_BOARD_API_BASE || "http://127.0.0.1:8791"

export function parseCliArgs(argv) {
  const result = {
    contractAddress: "",
    chainId: Number(process.env.CHAIN_ID || 1),
    quantity: process.env.MINT_QUANTITY || "1",
    tokenId: process.env.MINT_TOKEN_ID || "0",
    concurrency: process.env.WALLET_CONCURRENCY || "5",
    maxMintCostEth: process.env.MAX_MINT_COST_ETH || "",
    walletIds: [],
    send: false,
    yes: false,
    help: false,
    apiBase: DEFAULT_API_BASE,
  }

  const valueFor = (name, index) => {
    const value = argv[index + 1]
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
    return value
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--chain") result.chainId = Number(valueFor(arg, index++))
    else if (arg === "--quantity") result.quantity = valueFor(arg, index++)
    else if (arg === "--token-id") result.tokenId = valueFor(arg, index++)
    else if (arg === "--concurrency") result.concurrency = valueFor(arg, index++)
    else if (arg === "--max-cost") result.maxMintCostEth = valueFor(arg, index++)
    else if (arg === "--wallet") result.walletIds.push(valueFor(arg, index++))
    else if (arg === "--wallets") result.walletIds.push(...valueFor(arg, index++).split(",").map((value) => value.trim()).filter(Boolean))
    else if (arg === "--api") result.apiBase = valueFor(arg, index++).replace(/\/$/, "")
    else if (arg === "--send") result.send = true
    else if (arg === "--yes") result.yes = true
    else if (arg === "--help" || arg === "-h") result.help = true
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`)
    else if (!result.contractAddress) result.contractAddress = arg
    else throw new Error(`Unexpected argument: ${arg}`)
  }
  result.walletIds = [...new Set(result.walletIds)]
  return result
}

export function cliUsage() {
  return `Usage:
  npm run mint -- <nft-contract> --wallet <profile> [options]

Preview only (default):
  npm run mint -- 0x... --wallet default --wallets bt-001,bt-002

Preview, then confirm before broadcasting:
  npm run mint -- 0x... --wallets bt-001,bt-002 --send

Options:
  --chain ID          EVM chain id, default 1
  --quantity N        Quantity per wallet, default 1
  --token-id ID       Token id, default 0
  --concurrency N     Concurrent wallet plans, 0 means all, max 32
  --max-cost ETH      Hard mint-value cap per wallet
  --wallet ID         Add one local wallet profile (repeatable)
  --wallets A,B       Add comma-separated local wallet profiles
  --send              Broadcast after preview and explicit confirmation
  --yes               Confirm a --send run non-interactively
  --api URL           Local Dashboard API, default ${DEFAULT_API_BASE}

The Dashboard server must be running. Private keys remain in the server-side root .env and are never sent to this CLI.`
}

async function requestJson(apiBase, path, options = {}) {
  let response
  try {
    response = await fetch(`${apiBase}${path}`, {
      ...options,
      headers: { "content-type": "application/json", ...(options.headers || {}) },
      signal: AbortSignal.timeout(120000),
    })
  } catch (error) {
    throw new Error(`Cannot reach the local Dashboard API at ${apiBase}: ${error.message}`)
  }
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `Dashboard API returned HTTP ${response.status}`)
  return payload
}

function printPreview(job, output = console) {
  output.log(`Contract: ${job.contractAddress}`)
  output.log(`Chain: ${job.chainName} (${job.chainId})`)
  output.log(`Wallets: ${job.summary.total}, ready ${job.summary.ready}, skipped ${job.summary.skipped}, failed ${job.summary.failed}`)
  for (const wallet of job.wallets) {
    output.log(`\n[${wallet.status.toUpperCase()}] ${wallet.walletId} ${wallet.address}`)
    if (wallet.transaction) {
      output.log(`  To: ${wallet.transaction.to}`)
      output.log(`  Mint value: ${wallet.transaction.valueEth} ${job.nativeSymbol}`)
      output.log(`  Estimated gas: ${wallet.estimatedGas || "unavailable"}`)
      output.log(`  Estimated total: ${wallet.estimatedTotalEth || "unavailable"} ${job.nativeSymbol}`)
    }
    if (wallet.reason) output.log(`  Reason: ${wallet.reason}`)
  }
}

async function confirmSend(count, input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Interactive confirmation requires a terminal. Use --send --yes only for an intentional non-interactive broadcast.")
  }
  const readline = createInterface({ input, output })
  try {
    const answer = (await readline.question(`Broadcast ${count} ready NFT Mint transaction(s)? Type MINT to continue: `)).trim()
    return answer === "MINT"
  } finally {
    readline.close()
  }
}

async function waitForJob(apiBase, jobId, output = console) {
  let lastSummary = ""
  for (;;) {
    const { job } = await requestJson(apiBase, `/api/nft-mint/jobs/${encodeURIComponent(jobId)}`)
    const summary = `${job.summary.pending} pending, ${job.summary.sent} sent, ${job.summary.confirmed} confirmed, ${job.summary.failed} failed`
    if (summary !== lastSummary) output.log(summary)
    lastSummary = summary
    if (["completed", "partial", "failed"].includes(job.status)) return job
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}

export async function runCli(argv = process.argv.slice(2), { output = console, confirm = confirmSend } = {}) {
  const args = parseCliArgs(argv)
  if (args.help) {
    output.log(cliUsage())
    return { status: "help" }
  }
  if (!isAddress(args.contractAddress)) throw new Error("A valid NFT contract address is required")
  if (!Number.isSafeInteger(args.chainId) || args.chainId <= 0) throw new Error("--chain must be a positive integer")
  if (!args.walletIds.length) throw new Error("Select at least one local wallet with --wallet or --wallets")

  const { job } = await requestJson(args.apiBase, "/api/nft-mint/preview", {
    method: "POST",
    body: JSON.stringify({
      chainId: args.chainId,
      contractAddress: args.contractAddress,
      quantity: args.quantity,
      tokenId: args.tokenId,
      concurrency: args.concurrency,
      maxMintCostEth: args.maxMintCostEth,
      walletIds: args.walletIds,
    }),
  })
  printPreview(job, output)

  if (!args.send) {
    output.log(`\nPreview only. ${job.summary.ready} wallet(s) are ready. Add --send to enter the broadcast confirmation flow.`)
    return job
  }
  if (!job.summary.ready) throw new Error("No wallet passed preflight. Nothing can be broadcast.")
  if (!args.yes && !await confirm(job.summary.ready)) {
    output.log("Broadcast cancelled.")
    return { ...job, status: "cancelled" }
  }

  const sent = await requestJson(args.apiBase, "/api/nft-mint/send", {
    method: "POST",
    body: JSON.stringify({ jobId: job.id, confirmationToken: job.confirmationToken }),
  })
  output.log(`Broadcast accepted for job ${sent.job.id}.`)
  const finalJob = await waitForJob(args.apiBase, sent.job.id, output)
  output.log(`Mint batch ${finalJob.status}: ${finalJob.summary.confirmed} confirmed, ${finalJob.summary.failed} failed.`)
  if (finalJob.status !== "completed") throw new Error(`Mint batch finished with status ${finalJob.status}`)
  return finalJob
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
