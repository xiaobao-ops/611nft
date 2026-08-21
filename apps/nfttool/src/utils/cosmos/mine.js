
async function performTransaction(walletInfo) {
  const { contentData, numberOfTimes, fee, amount } = walletInfo;
  console.log('运行中')
  for (let i = 0; i < numberOfTimes; i++) {
    try {
      const result = await walletInfo.client.sendTokens(
        walletInfo.address,
        walletInfo.address,
        amount,
        fee,
        contentData
      );
      self.postMessage({
        type: 'success',
        data: `${walletInfo.address}, 第 ${i + 1} 次操作成功: ${
          'https://www.mintscan.io/cosmos/tx/' + result.transactionHash
        }`
      })
      console.log(
        `${walletInfo.address}, 第 ${i + 1} 次操作成功: ${
          'https://www.mintscan.io/cosmos/tx/' + result.transactionHash
        }`,
      );
    } catch (error) {
      self.postMessage({
        type: 'error',
        data: `第 ${i + 1} 次操作失败: ${error.message}`
      })
      console.error(`第 ${i + 1} 次操作失败: `, error);
    }
  }
}

self.onmessage = (walletData) => {
  console.log('onmessage--', walletData)
  console.log('运行中')

  Promise.all(walletData.map((walletInfo) => performTransaction(walletInfo)))
    .then(() => {
      console.log('任务开始');
    })
    .catch((error) => {
      console.error('操作中有错误发生: ', error);
    });
}
