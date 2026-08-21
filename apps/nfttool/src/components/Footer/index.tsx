import { TwitterOutlined } from '@ant-design/icons';
import { DefaultFooter } from '@ant-design/pro-components';
import { useIntl } from '@umijs/max';
import React from 'react';

const Footer: React.FC = () => {
  const intl = useIntl();
  const defaultMessage = intl.formatMessage({
    id: 'app.copyright.produced',
    defaultMessage: '建设更好用的脚本工具社区',
  });

  const currentYear = new Date().getFullYear();

  return (
    <DefaultFooter
      style={{
        background: 'none',
        height: 0,
      }}
      copyright={`${2021} ${defaultMessage}`}
      links={[
        {
          key: 'twitter',
          title: <span><TwitterOutlined style={{verticalAlign: 'middle'}}/> nfttool_club</span>,
          href: 'https://twitter.com/nfttool_club',
          blankTarget: true,
        },
        {
          key: 'OpenSea',
          title: <span><img style={{width: 14, height: 14, verticalAlign: 'middle'}} src="/tool/assets/opensea.svg" /> OpenSea</span>,
          href: 'https://opensea.io/collection/nfttool-club',
          blankTarget: true,
        },
        {
          key: 'EtherScan',
          title: <span><img style={{width: 14, height: 14, verticalAlign: 'middle'}} src="/tool/assets/etherscan.svg" /> EtherScan</span>,
          href: 'https://etherscan.io/address/0xa95998edd0150ea22d5ba977ecd23db2518e34fd',
          blankTarget: true,
        },
      ]}
    />
  );
};

export default Footer;
