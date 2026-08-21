/** NFT TOOL routes with local workspace entries kept separate from original modules. */
export default [
  {
    path: '/walletManager',
    name: 'walletManager',
    icon: 'wallet',
    routes: [
      { path: '/walletManager/walletManager', name: 'walletManager', component: './Tool/Iframe' },
      { path: '/walletManager/ethDisperse', name: 'ethDisperse', component: './Tool/Iframe' },
      { path: '/walletManager/ethCollection', name: 'ethCollection', component: './Tool/Iframe' },
      { path: '/walletManager/moreToMore', name: 'moreToMore', component: './Tool/Iframe' },
      { path: '/walletManager/despositToExchange', name: 'despositToExchange', component: './Tool/Iframe' },
      { path: '/walletManager/disperse', redirect: '/walletManager/ethDisperse', hideInMenu: true },
      { path: '/walletManager/collect', redirect: '/walletManager/ethCollection', hideInMenu: true },
    ],
  },
  { path: '/mint', name: 'mint', icon: 'aim', component: './Tool/Iframe' },
  { path: '/documentaryList', name: 'documentaryList', icon: 'unorderedList', component: './Tool/Iframe' },
  {
    path: '/highHexMint',
    name: 'highHexMint',
    icon: 'thunderbolt',
    routes: [
      { path: '/highHexMint/signTask', name: 'signTask', component: './Tool/Iframe' },
      { path: '/highHexMint/highHexMint', name: 'highHexMint', component: './Tool/Iframe' },
      { path: '/highHexMint/opensea', name: 'opensea', component: './Tool/Iframe' },
      { path: '/highHexMint/contract', redirect: '/highHexMint/highHexMint', hideInMenu: true },
    ],
  },
  {
    path: '/batchSell',
    name: 'batchSell',
    icon: 'send',
    routes: [
      { path: '/batchSell/batchSell', name: 'batchSell', component: './Tool/Iframe' },
      { path: '/batchSell/collectionNFT', name: 'collectionNFT', component: './Tool/Iframe' },
      { path: '/batchSell/batchApprove', name: 'batchApprove', component: './Tool/Iframe' },
    ],
  },
  { path: '/walletAlert', name: 'walletAlert', icon: 'bell', component: './WorkspaceModule' },
  { path: '/scanWallet', name: 'scanWallet', icon: 'scan', hideInMenu: true, component: './WorkspaceModule' },
  { path: '/balanceSearch', name: 'balanceSearch', icon: 'search', hideInMenu: true, component: './WorkspaceModule' },
  { path: '/transactions', name: 'transactions', icon: 'history', component: './WorkspaceModule' },
  { path: '/welcome', redirect: '/walletManager/walletManager' },
  { path: '/', redirect: '/walletManager/walletManager' },
  { path: '*', layout: false, component: './404' },
];
