import { bootRuntime } from './core.js';
import {
  renderAdvancedMint,
  renderLaunchpadMint,
  renderSignatureTask,
} from './advanced-mint.js';
import { renderFollowMint } from './follow-mint.js';
import { renderMintMonitor } from './mint-monitor.js';
import {
  renderBatchApprove,
  renderBatchSell,
  renderNftCollection,
} from './nft-management.js';
import { renderWalletManager } from './wallet-manager.js';
import {
  renderCollection,
  renderDisperse,
  renderExchangeDeposit,
  renderManyToMany,
} from './transfer-pages.js';

const pageRenderers = {
  walletManager: renderWalletManager,
  ethDisperse: renderDisperse,
  ethCollection: renderCollection,
  moreToMore: renderManyToMany,
  despositToExchange: renderExchangeDeposit,
  mint: renderMintMonitor,
  documentaryList: renderFollowMint,
  signTask: renderSignatureTask,
  highHexMint: renderAdvancedMint,
  opensea: renderLaunchpadMint,
  magiceden: renderLaunchpadMint,
  fairMint: (context) => renderAdvancedMint(context, { title: 'Fair Mint' }),
  manifold: (context) => renderAdvancedMint(context, { title: 'Manifold' }),
  indelible: (context) => renderAdvancedMint(context, { title: 'Indelible' }),
  bueno: (context) => renderAdvancedMint(context, { title: 'Bueno' }),
  sound: (context) => renderAdvancedMint(context, { title: 'Sound' }),
  gmstudio: (context) => renderAdvancedMint(context, { title: 'GM Studio' }),
  ensRegister: (context) => renderAdvancedMint(context, { title: 'ENS Register' }),
  skyarkchronicles: (context) => renderAdvancedMint(context, { title: 'SkyArk Chronicles' }),
  skyarkchroniclesCollection: (context) => renderAdvancedMint(context, { title: 'SkyArk NFT Collection' }),
  skyarkchroniclesDisperse: (context) => renderAdvancedMint(context, { title: 'SkyArk NFT Disperse' }),
  batchSell: renderBatchSell,
  collectionNFT: renderNftCollection,
  batchApprove: renderBatchApprove,
};

const routeName = window.location.pathname.split('/').filter(Boolean).at(-1) || 'walletManager';
const renderPage = pageRenderers[routeName] || (() => ({
  html: `<div class="fatal-state"><strong>模块未接入</strong><span>未找到 NFT TOOL 运行时模块：${routeName.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</span></div>`,
}));

bootRuntime({ routeName, renderPage });
