import { SITE_NAME } from '@/utils/index';
import { useModel } from '@umijs/max';
import { ConnectKitProvider } from 'connectkit';
import { CoinbaseWalletConnector } from 'wagmi/connectors/coinbaseWallet';
import { InjectedConnector } from 'wagmi/connectors/injected';
import { MetaMaskConnector } from 'wagmi/connectors/metaMask';
import { configureChains, createConfig, WagmiConfig } from 'wagmi';
import { publicProvider } from 'wagmi/providers/public';
import { arbitrum, base, mainnet, optimism, polygon, goerli, linea } from 'wagmi/chains';

const chains = [mainnet, arbitrum, base, goerli, linea, optimism, polygon];
const { chains: configuredChains, publicClient } = configureChains(chains, [publicProvider()]);
const config = createConfig({
  autoConnect: true,
  connectors: [
    new MetaMaskConnector({ chains: configuredChains }),
    new CoinbaseWalletConnector({
      chains: configuredChains,
      options: { appName: SITE_NAME, headlessMode: true },
    }),
    new InjectedConnector({ chains: configuredChains }),
  ],
  publicClient,
});
export function Web3Provider(props: any) {
  const { initialState } = useModel('@@initialState');
  const { settings } = initialState || {};
  const colorMode = settings?.navTheme === 'realDark' ? 'dark' : 'light';

  return (
    <WagmiConfig config={config}>
      <ConnectKitProvider mode={colorMode}>{props.children}</ConnectKitProvider>
    </WagmiConfig>
  );
}
