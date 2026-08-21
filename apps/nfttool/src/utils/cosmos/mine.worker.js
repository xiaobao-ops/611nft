import { DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import { GasPrice, SigningStargateClient, coins } from '@cosmjs/stargate';
import { base64FromBytes } from 'cosmjs-types/helpers';

async function performTransaction(walletInfo) {
  const { content, numberOfTimes } = walletInfo;
  const fee = {
    amount: coins(380, 'uatom'),
    gas: '80000',
  };
  console.log('运行中')
  for (let i = 0; i < numberOfTimes; i++) {
    try {
      const amount = coins(1, 'uatom');

      const result = await walletInfo.client.sendTokens(
        walletInfo.address,
        walletInfo.address,
        amount,
        fee,
        base64FromBytes(Buffer.from(content, 'utf8')),
      );
      self.postMessage({
        type: 'success',
        data: () => {
          return (
            <span>
              {
                `${walletInfo.address}, 第 ${i + 1} 次操作成功: ${
                  'https://www.mintscan.io/cosmos/tx/' + result.transactionHash
                }`
              }
            </span>
          )
        }
      })
      console.log(
        `${walletInfo.address}, 第 ${i + 1} 次操作成功: ${
          'https://www.mintscan.io/cosmos/tx/' + result.transactionHash
        }`,
      );
    } catch (error) {
      self.postMessage({
        type: 'error',
        data: () => {
          return (
            <span>
              {`第 ${i + 1} 次操作失败: ${error.message}`}
            </span>
          )
        }
      })
      console.error(`第 ${i + 1} 次操作失败: `, error);
    }
  }
}

self.onmessage = (options) => {
  console.log('onmessage--', options)
  const { pkList, rpc, times, type, content } = options;

  const walletData = pkList.map(async (privateKey) => {
    const wallet = await DirectSecp256k1Wallet.fromKey(Buffer.from(privateKey, 'hex'), 'cosmos');
    const [account] = await wallet.getAccounts();
    const walletAddress = account.address;

    const gasPrice = GasPrice.fromString('0.025uatom');
    const client = await SigningStargateClient.connectWithSigner(rpc, wallet, {
      gasPrice: gasPrice,
    });
    const balance = await client.getBalance(walletAddress, 'uatom');
    self.postMessage({
      type: 'error',
      data: () => {
        return (
          <span>
            {`地址: ${walletAddress} 余额: ${parseFloat(balance.amount) / 1000000}`}
          </span>
        )
      }
    })
    console.log(`地址: ${walletAddress} 余额: ${parseFloat(balance.amount) / 1000000}`);

    return {
      client,
      address: account,
      privateKey,
      content,
      times,
    };
  });
  console.log('运行中')

  Promise.all(walletData.map((walletInfo) => performTransaction(walletInfo)))
    .then(() => {
      console.log('任务开始');
    })
    .catch((error) => {
      console.error('操作中有错误发生: ', error);
    });
}
