/**
 * Umi development proxies. Production uses the local Express service directly.
 */
const localService = process.env.WALLET_BOARD_DEV_API_URL || 'http://127.0.0.1:8791';

export default {
  dev: {
    '/api/': {
      target: localService,
      changeOrigin: true,
    },
    '/nfttool-runtime/': {
      target: localService,
      changeOrigin: true,
    },
  },
  test: {
    '/api/': {
      target: 'https://proapi.azurewebsites.net',
      changeOrigin: true,
      pathRewrite: { '^': '' },
    },
  },
  pre: {
    '/api/': {
      target: 'your pre url',
      changeOrigin: true,
      pathRewrite: { '^': '' },
    },
  },
  pro: {
    '/api/': {
      target: localService,
      changeOrigin: true,
    },
    '/nfttool-runtime/': {
      target: localService,
      changeOrigin: true,
    },
  },
};
