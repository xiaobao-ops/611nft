import { execFile } from 'node:child_process';

function executeOpenClaw({ command, target, message, timeoutMs }) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [
        'message',
        'send',
        '--channel',
        'discord',
        '--target',
        target,
        '--message',
        message,
        '--json',
      ],
      {
        timeout: timeoutMs,
        maxBuffer: 256 * 1024,
        windowsHide: true,
      },
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });
}

function shortAddress(address) {
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

export function createOpenClawDiscordNotifier({
  target,
  timeoutMs = 10_000,
  command = 'openclaw',
  log = () => {},
  execute = executeOpenClaw,
}) {
  let queue = Promise.resolve();

  const enqueue = (kind, message) => {
    if (!target) return;

    queue = queue.then(async () => {
      try {
        await execute({ command, target, message, timeoutMs });
        log(`discord notification sent: ${kind}`);
      } catch (error) {
        const reason = error?.killed || error?.code === 'ETIMEDOUT'
          ? `timeout after ${timeoutMs}ms`
          : (error?.message || 'unknown OpenClaw error');
        log(`discord notification failed: ${kind}: ${reason}`);
      }
    });
  };

  return Object.freeze({
    enabled: Boolean(target),
    notifyMintOpen({ pendingCount }) {
      enqueue(
        'mint-open',
        [
          '**ASCII Cats Mint 已开启**',
          `待执行钱包：${pendingCount}`,
          `检测时间：${new Date().toISOString()}`,
        ].join('\n'),
      );
    },
    notifyMintSuccess({ index, address, txHash, confirmedCount, totalCount, recovered }) {
      enqueue(
        'mint-success',
        [
          '**ASCII Cats Mint 成功**',
          `钱包：#${index + 1} ${shortAddress(address)}`,
          `交易：${txHash}`,
          `确认进度：${confirmedCount}/${totalCount}`,
          recovered ? '状态：重启后恢复确认' : '状态：链上确认成功',
        ].join('\n'),
      );
    },
    async flush() {
      await queue;
    },
  });
}
