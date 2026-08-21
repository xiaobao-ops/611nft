import {
  AimOutlined,
  MoonOutlined,
  SunOutlined,
  ThunderboltOutlined,
  UnorderedListOutlined,
  WalletOutlined,
} from '@ant-design/icons';
import { Settings as LayoutSettings } from '@ant-design/pro-components';
import { RunTimeLayoutConfig, setLocale } from '@umijs/max';
import { Button, Tooltip } from 'antd';
import React from 'react';
import defaultSettings from '../config/defaultSettings';
import { errorConfig } from './requestErrorConfig';

export async function getInitialState(): Promise<{
  settings?: Partial<LayoutSettings>;
}> {
  document.documentElement.lang = 'zh-CN';
  setLocale('zh-CN', false);
  const storedTheme = localStorage.getItem('theme');
  const navTheme = storedTheme === 'light' ? 'light' : 'realDark';
  return {
    settings: {
      ...defaultSettings,
      navTheme,
      ntcHighHexMintProject: localStorage.getItem('ntcHighHexMintProject'),
    } as Partial<LayoutSettings>,
  };
}

const localMenuIcons: Record<string, React.ReactNode> = {
  '/walletManager': <WalletOutlined aria-label="钱包管理" />,
  '/mint': <AimOutlined aria-label="NFT 盯盘" />,
  '/documentaryList': <UnorderedListOutlined aria-label="跟单和自动铸造" />,
  '/highHexMint': <ThunderboltOutlined aria-label="高级铸造" />,
};

function notifyWorkspaceTheme(theme: 'light' | 'dark') {
  document.querySelectorAll('iframe').forEach((frame) => {
    frame.contentWindow?.postMessage({ type: '611nft:theme', theme }, window.location.origin);
  });
}

export const layout: RunTimeLayoutConfig = ({ initialState, setInitialState }) => {
  const light = initialState?.settings?.navTheme === 'light';
  const toggleTheme = () => {
    const theme = light ? 'dark' : 'light';
    localStorage.setItem('theme', theme);
    setInitialState((previous) => ({
      ...previous,
      settings: {
        ...previous?.settings,
        navTheme: theme === 'light' ? 'light' : 'realDark',
      },
    }));
    notifyWorkspaceTheme(theme);
  };

  return {
    ...initialState?.settings,
    title: 'NFT TOOL',
    logo: <img src="/tool/icons/icon-192x192.png" alt="NFT TOOL 标志" />,
    avatarProps: false,
    menuDataRender: (menuData) =>
      menuData.map((item) => ({
        ...item,
        icon: localMenuIcons[item.path || ''] || item.icon,
      })),
    actionsRender: () => [
      <Tooltip title={light ? '切换暗色' : '切换亮色'} key="theme">
        <Button
          aria-label={light ? '切换暗色主题' : '切换亮色主题'}
          icon={
            light ? (
              <MoonOutlined aria-label="月亮" />
            ) : (
              <SunOutlined aria-label="太阳" />
            )
          }
          onClick={toggleTheme}
          type="text"
        />
      </Tooltip>,
    ],
    childrenRender: (children) => children,
  };
};

export const request = {
  ...errorConfig,
};
