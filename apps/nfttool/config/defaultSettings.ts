import { ProLayoutProps } from '@ant-design/pro-components';

/**
 * @name
 */
const Settings: ProLayoutProps & {
  pwa?: boolean;
  logo?: string;
  ntcHighHexMintProject?: string | null;
} = {
  navTheme: 'realDark',
  colorPrimary: '#3b82f6',
  layout: 'mix',
  contentWidth: 'Fluid',
  fixedHeader: true,
  fixSiderbar: true,
  colorWeak: false,
  title: 'NFT TOOL',
  pwa: true,
  logo: '/tool/icons/icon-192x192.png',
  iconfontUrl: '',
  token: {
    // 参见ts声明，demo 见文档，通过token 修改样式
    //https://procomponents.ant.design/components/layout#%E9%80%9A%E8%BF%87-token-%E4%BF%AE%E6%94%B9%E6%A0%B7%E5%BC%8F
  },
  splitMenus: false,
  siderMenuType: 'sub',
  ntcHighHexMintProject: ''
};

export default Settings;
