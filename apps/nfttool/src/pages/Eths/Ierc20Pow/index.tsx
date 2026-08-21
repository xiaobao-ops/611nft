import AccountManager from '@/components/AccountManager';
import LogInfo from '@/components/LogInfo';
import { PageContainer, ProForm, ProFormDigit, ProFormText } from '@ant-design/pro-components';
import { Card, FormInstance } from 'antd';
import React from 'react';
import { runMine } from './ierc20/mine';

const App: React.FC = () => {
  const formRef = React.useRef<FormInstance>(null);
  const accountManagerRef = React.useRef<FormInstance>(null);

  const contentMap = {
    sols: '{"p":"src-20","op":"mint","tick":"sols","amt":"1000"}',
    lamp: '{"p":"src-20","op":"mint","tick":"lamp","amt":"1000"}',
    other: '',
  };

  const initialValues = {
    tick: 'ierc-m4',
    amt: '1000',
    difficulty: '0x0000',
    workc: '5',
    mintCount: '1',
  };

  const onFinish = async (values: any): Promise<void> => {
    // 获取子组件实例值
    const { selectedRows }: any = accountManagerRef.current;
    const result = selectedRows.map((account: any) => {
      return runMine(account, values);
    })
  };

  return (
    <PageContainer
      breadcrumbRender={false}
      content={
        <div>
          <AccountManager ref={accountManagerRef} />
          <Card style={{ marginTop: 8 }}>
            <ProForm
              formRef={formRef}
              name="dynamic_form_item"
              onFinish={onFinish}
              initialValues={initialValues}
              submitter={{
                // 配置按钮文本
                searchConfig: {
                  submitText: 'Mint',
                },
                // 配置按钮的属性
                resetButtonProps: {
                  style: {
                    // 隐藏重置按钮
                    display: 'none',
                  },
                },
              }}
            >
              <ProForm.Group>
                <ProFormText width={'md'} label="Tick(例如：ierc-m4)" name="tick" required />
                <ProFormText width={'md'} label="Amt(例如：1000)" name="amt" required />
              </ProForm.Group>

              <ProForm.Group>
                <ProFormText
                  width={'md'}
                  label="Difficulty(例如：0x0000)"
                  name="difficulty"
                  colProps={{ xl: 12 }}
                  required
                />
                <ProFormDigit
                  width={'md'}
                  label="WorkerCount(例如：5)"
                  name="workc"
                  colProps={{ xl: 12 }}
                  required
                />
              </ProForm.Group>

              <ProFormText width={'md'} name="mintCount" label="单号mint次数" required />
            </ProForm>
          </Card>
          <Card style={{ marginTop: 8 }}>
            <LogInfo />
          </Card>
        </div>
      }
    ></PageContainer>
  );
};

export default App;
