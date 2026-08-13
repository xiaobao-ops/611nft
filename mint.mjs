import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { formatEther, isAddress } from 'viem';
import {
  loadAccounts,
  mapConcurrent,
  parseConcurrency,
  parsePositiveInteger,
  previewMint,
  resolveChainConfig,
  sendMintBatch,
  serializePlan,
} from './lib/mint-core.mjs';

function parseArgs(argv) {
  const positional = [];
  const result = {
    quantity: process.env.MINT_QUANTITY?.trim() || '1',
    tokenId: process.env.MINT_TOKEN_ID?.trim() || '0',
    send: false,
    confirm: false,
    noWait: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--quantity') {
      result.quantity = argv[++index];
    } else if (arg === '--token-id') {
      result.tokenId = argv[++index];
    } else if (arg === '--send') {
      result.send = true;
    } else if (arg === '--yes') {
      result.confirm = true;
    } else if (arg === '--no-wait') {
      result.noWait = true;
    } else if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  result.contractAddress = positional[0];
  return result;
}

function printUsage() {
  console.log(`Usage:
  node mint.mjs <nft-contract-address> [--quantity N] [--token-id ID]

Preview only (default):
  node mint.mjs 0x...

Send after explicit confirmation:
  node mint.mjs 0x... --send

Send without an interactive prompt:
  node mint.mjs 0x... --send --yes

Options:
  --quantity N   Mint quantity; defaults to MINT_QUANTITY or 1
  --token-id ID  Token id; defaults to MINT_TOKEN_ID or 0
  --send         Preview, then ask before signing and broadcasting
  --yes          Skip the interactive confirmation used by --send
  --no-wait      Do not wait for the receipt after broadcasting

Private keys:
  .env                                One bare 64-character private key per line
                                      (no PRIVATE_KEY_N= and no 0x prefix)
`);
}

async function confirmBroadcast(question = '确认发送以上交易？输入 y 继续，其他任意内容取消: ') {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive confirmation requires a terminal. Use --send --yes only for intentional non-interactive execution.');
  }

  const readline = createInterface({input: process.stdin, output: process.stdout});
  try {
    const answer = (await readline.question(question))
      .trim()
      .toLowerCase();
    return answer === 'y' || answer === 'yes' || answer === 'send';
  } finally {
    readline.close();
  }
}

function printTransactionPlan(plan, index, total) {
  const serialized = serializePlan(plan);
  console.log(`\n[${index}/${total}] Wallet: ${serialized.address}`);
  console.log(`Action: ${serialized.transaction.actionType}${serialized.transaction.isSeaDropMintSigned ? ' / SeaDrop mintSigned' : ''}`);
  console.log(`To: ${serialized.transaction.to}`);
  console.log(`Value: ${serialized.valueEth} ETH`);
  console.log(`Balance: ${serialized.balanceEth} ETH`);
  console.log(`Estimated gas: ${serialized.gasLimit}`);
  console.log(`Estimated fee: ${serialized.estimatedFeeEth} ETH`);
  console.log(`Estimated total: ${serialized.estimatedTotalEth} ETH`);
  console.log(`Calldata: ${serialized.transaction.data}`);
  if (serialized.errors.length) console.log(`GraphQL warnings: ${serialized.errors.map((error) => error.__typename).join(', ')}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (!args.contractAddress || !isAddress(args.contractAddress)) {
    printUsage();
    throw new Error('A valid NFT contract address is required.');
  }

  const quantity = parsePositiveInteger(args.quantity, 'quantity');
  if (!/^(0|[1-9]\d*)$/.test(String(args.tokenId))) throw new Error('token-id must be a non-negative integer string.');
  const configuredConcurrency = parseConcurrency(process.env.WALLET_CONCURRENCY?.trim() || '0', 'WALLET_CONCURRENCY');
  const accounts = loadAccounts();
  const chainConfig = resolveChainConfig();

  console.log(`Contract: ${args.contractAddress}`);
  console.log(`Chain: ${chainConfig.chainIdentifier} (${chainConfig.chainId})`);
  console.log(`Quantity: ${quantity.toString()}  Token ID: ${args.tokenId}`);

  const effectiveConcurrency = configuredConcurrency === 0
    ? accounts.length
    : Math.min(configuredConcurrency, accounts.length);
  console.log(`Wallets: ${accounts.length}`);
  console.log(`Concurrency: ${configuredConcurrency === 0 ? 'all' : effectiveConcurrency}`);

  const preview = await previewMint({
    contractAddress: args.contractAddress,
    quantity,
    tokenId: String(args.tokenId),
    concurrency: configuredConcurrency,
    onPlan: (plan, index, total) => printTransactionPlan(plan, index + 1, total),
  });

  for (const skipped of preview.skippedWallets) {
    console.warn(`SKIP ${skipped.address}: ${skipped.reason}`);
  }
  for (const failed of preview.failedWallets) {
    console.error(`${failed.address}: ${failed.message}`);
  }

  if (preview.failedWallets.length) {
    console.error(`\n${preview.failedWallets.length} wallet(s) failed preflight; no transaction was sent.`);
    throw new Error('Mint preflight failed. Fix the listed wallet(s) and retry.');
  }
  if (!args.send) {
    console.log(`\nDry run only. Planned ${preview.readyPlans.length} wallet(s). Add --send to confirm and broadcast.`);
    return;
  }
  if (preview.skippedWallets.length) {
    console.log(`\nSkipped ${preview.skippedWallets.length} wallet(s) for insufficient balance.`);
  }
  if (!preview.readyPlans.length) {
    console.log('No wallet has enough balance; nothing was sent.');
    return;
  }
  if (!args.confirm && !await confirmBroadcast(`确认并发发送 ${preview.readyPlans.length} 个钱包的交易？输入 y 继续，其他任意内容取消: `)) {
    console.log('Transactions cancelled.');
    return;
  }

  const {sent, failed} = await sendMintBatch({
    readyPlans: preview.readyPlans,
    publicClient: preview.publicClient,
    chain: preview.chain,
    rpcUrl: preview.rpcUrl,
    concurrency: configuredConcurrency,
    noWait: args.noWait,
    onResult: (result) => {
      if (result.hash) {
        console.log(`Transaction sent for ${result.address}: ${result.hash}`);
        if (result.status && result.status !== 'sent') console.log(`Receipt status: ${result.status}`);
        if (result.blockNumber) console.log(`Block: ${result.blockNumber}`);
      }
    },
  });

  for (const result of failed) {
    console.error(`Send failed for ${result.address}: ${result.error}`);
  }
  console.log(`\nBroadcast completed: ${sent.length}/${preview.readyPlans.length} wallet(s).`);
  if (failed.length) {
    throw new Error(`${failed.length} wallet(s) failed during concurrent broadcast.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
