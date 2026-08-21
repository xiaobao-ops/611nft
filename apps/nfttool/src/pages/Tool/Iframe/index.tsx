import { iframeDomain } from '@/utils/index';
import { PageContainer } from '@ant-design/pro-components';
import { useModel, useParams } from '@umijs/max';
import { Alert, Spin } from 'antd';
import React, { useEffect, useState } from 'react';
import { useRouteProps } from 'umi';
import styles from './index.less';

const randomStr = 'thekkkey=12';

const Iframe: React.FC = () => {
  const { name } = useRouteProps();
  const { chainId, address } = useParams<{ chainId?: string; address?: string }>();
  const moduleName = String(name || '');
  let url = `${iframeDomain}/${moduleName}?${randomStr}`;
  if (chainId && address) {
    url = `${iframeDomain}/${moduleName}/${chainId}/${address}?${randomStr}`;
  }

  const { initialState } = useModel('@@initialState');
  const [loading, setLoading] = useState(true);
  const [key, setKey] = useState(1);

  useEffect(() => {
    setLoading(true);
    setKey((value) => value + 1);
    const timer = window.setTimeout(() => setLoading(false), 2000);
    return () => window.clearTimeout(timer);
  }, [initialState?.settings?.navTheme]);

  const isWalletManager = url.includes('/walletManager');
  return (
    <PageContainer title={false} breadcrumbRender={false}>
      {isWalletManager ? (
        <Alert
          message="注意：添加钱包后，务必及时导出备份并妥善保管！钱包删除之前请先导出备份，删除后无法恢复，请勿轻易点击删除！"
          type="warning"
          showIcon
          closable
        />
      ) : null}
      <div className={styles['app-container']}>
        <Spin spinning={loading}>
          <iframe
            key={key}
            title={`${moduleName} module`}
            src={url}
            onLoad={() => setLoading(false)}
          />
        </Spin>
      </div>
    </PageContainer>
  );
};

export default Iframe;
