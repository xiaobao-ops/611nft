import { PageContainer } from '@ant-design/pro-components';
import { useIntl, useRequest } from '@umijs/max';
import { Button, Card, DatePicker, Form, Input } from 'antd';
import React from 'react';

const { RangePicker } = DatePicker;
const { TextArea } = Input;

const FormDisabledDemo: React.FC = () => {
  const submit = () => {
    const { data, error, loading } = useRequest(() => {
      return services.getUserList('/api/test');
    });
    console.log('submit-');
  };
  return (
    <>
      <Form
        labelCol={{ span: 4 }}
        wrapperCol={{ span: 14 }}
        layout="horizontal"
        style={{ maxWidth: 800 }}
      >
        <Form.Item label="使用说明">
          <span>替换下面的地址，每行一个</span>
        </Form.Item>
        <Form.Item label="账号" rules={[{ required: true }]} >
          <TextArea style={{width: 800}} rows={10} required value={'0x2a99E4b3389CCA0BcA694C7A0A23dC9BB2e16a25\n0x2a99E4b3389CCA0BcA694C7A0A23dC9BB2e16a26'}/>
        </Form.Item>
        <Form.Item label="操作">
          <Button type="primary" htmlType="submit" onClick={() => submit()}>
            提交
          </Button>
        </Form.Item>
      </Form>
    </>
  );
};

const Task: React.FC = () => {
  const intl = useIntl();
  return (
    <PageContainer
      style={{ margin: 16 }}
      title={false}
      breadcrumbRender={false}
      content={'这里持续更新一些热点项目！'}
    >
      <Card
        title={<div>
          [6月18日] fuckSec
          <Button type="link" onClick={_ => window.open('https://www.fuksec.io/')}>项目链接</Button>
        </div>}
        bordered={false}
        style={{ width: '100%' }}
      >
        <FormDisabledDemo />
      </Card>
    </PageContainer>
  );
};

export default Task;
