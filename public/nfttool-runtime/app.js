import { bootRuntime } from './core.js';

const pageLoaders = {
  walletManager: () => import('./wallet-manager.js').then(({ renderWalletManager }) => renderWalletManager),
  ethDisperse: () => import('./transfer-pages.js').then(({ renderDisperse }) => renderDisperse),
  ethCollection: () => import('./transfer-pages.js').then(({ renderCollection }) => renderCollection),
  moreToMore: () => import('./transfer-pages.js').then(({ renderManyToMany }) => renderManyToMany),
  despositToExchange: () => import('./transfer-pages.js').then(({ renderExchangeDeposit }) => renderExchangeDeposit),
  mint: () => import('./mint-monitor.js').then(({ renderMintMonitor }) => renderMintMonitor),
  documentaryList: () => import('./follow-mint.js').then(({ renderFollowMint }) => renderFollowMint),
  signTask: () => import('./advanced-mint.js').then(({ renderSignatureTask }) => renderSignatureTask),
  highHexMint: () => import('./advanced-mint.js').then(({ renderAdvancedMint }) => renderAdvancedMint),
  opensea: () => import('./opensea-mint.js').then(({ renderOpenSeaMint }) => renderOpenSeaMint),
  batchSell: () => import('./nft-management.js').then(({ renderBatchSell }) => renderBatchSell),
  collectionNFT: () => import('./nft-management.js').then(({ renderNftCollection }) => renderNftCollection),
  batchApprove: () => import('./nft-management.js').then(({ renderBatchApprove }) => renderBatchApprove),
};

const routeName = window.location.pathname.split('/').filter(Boolean).at(-1) || 'walletManager';
const missingRenderer = () => ({
  html: `<div class="fatal-state"><strong>模块未接入</strong><span>未找到 NFT TOOL 运行时模块：${routeName.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</span></div>`,
});

const renderPage = pageLoaders[routeName] ? await pageLoaders[routeName]() : missingRenderer;
bootRuntime({ routeName, renderPage });
