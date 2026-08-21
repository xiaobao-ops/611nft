import { PageContainer } from '@ant-design/pro-components';
import { useLocation, useModel } from '@umijs/max';
import React from 'react';
import WorkspaceApp from '../../workspace/App.jsx';
import '../../workspace/styles.css';

const modulesByPath: Record<string, string> = {
  '/walletAlert': 'alerts',
  '/scanWallet': 'balances',
  '/transactions': 'tx',
  '/balanceSearch': 'balances',
};

const WorkspaceModule: React.FC = () => {
  const location = useLocation();
  const { initialState } = useModel('@@initialState');
  const moduleName = modulesByPath[location.pathname] || 'contract';
  const workspaceTheme = initialState?.settings?.navTheme === 'light' ? 'light' : 'dark';

  return (
    <PageContainer title={false} breadcrumbRender={false}>
      <WorkspaceApp moduleName={moduleName} theme={workspaceTheme} />
    </PageContainer>
  );
};

export default WorkspaceModule;
