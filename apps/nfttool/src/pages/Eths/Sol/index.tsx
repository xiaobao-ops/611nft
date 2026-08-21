import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { ProFormText } from '@ant-design/pro-components';
import { Connection } from '@solana/web3.js';
import { Button, Form, FormInstance, Input, Radio } from 'antd';
import React from 'react';
import { getKeyPair } from '@/utils/solMint'

const App: React.FC = () => {
  const formRef = React.useRef<FormInstance>(null);

  const contentMap = {
    'sols': '{"p":"src-20","op":"mint","tick":"sols","amt":"1000"}',
    'lamp': '{"p":"src-20","op":"mint","tick":"lamp","amt":"1000"}',
    'other': ''
  }

  const initialValues = {
    rpc: 'https://swr.xnftdata.com/rpc-proxy/',
    type: 'sols',
    content: contentMap['sols']
  };

  const onFinish = (values: any) => {
    const { rpc } = values
    const QUICKNODE_RPC = rpc.replace('https://', '')
    let SOLANA_CONNECTION = new Connection(`https://${QUICKNODE_RPC}`, {
      wsEndpoint: `wss://${QUICKNODE_RPC}`,
    });
    const secretList = values.accountList.map((pk: string) => {
      return getKeyPair(pk)
    }).filter((v: any) => v)

  };

  const onFill = (type: 'sols' | 'lamp' | 'other') => {
    console.log('type--', type, formRef.current?.getFieldsValue());
    formRef.current?.setFieldsValue({content: contentMap?.[type]})
  };


  return (
    <div style={{ margin: 24 }}>
      <Form
        ref={formRef}
        name="dynamic_form_item"
        layout="vertical"
        onFinish={onFinish}
        initialValues={initialValues}
      >
        <Form.List
          name="accountList"
          rules={[
            {
              validator: async (_, accountList) => {
                if (!accountList?.length) return Promise.reject(new Error('请添加私钥'));
              },
            },
          ]}
        >
          {(fields, { add, remove }, { errors }) => (
            <>
              {fields.map((field, index) => (
                <Form.Item
                  label={`私钥${index + 1}`}
                  required={false}
                  key={field.key}
                  tooltip="格式如：4WWY6DQECiMsT9JS91irosUfFaTCxwizNBEMqwxpbkooi422zPaoRHU8V1nuCoMGxzFs9cqrYGGbPfRsGdVhe7rd"
                >
                  <Form.Item
                    {...field}
                    validateTrigger={['onChange', 'onBlur']}
                    noStyle
                    rules={[
                      {
                        validator: async (_, account) => {
                          if (!account?.length) return Promise.reject(new Error('请输入私钥'));
                          if (account?.length !== 88) return Promise.reject(new Error('私钥长度不对'));
                          if (formRef.current?.getFieldValue('accountList').filter((v: string) => v === account).length >= 2) return Promise.reject(new Error('私钥重复'));
                        },
                      },
                    ]}
                  >
                    <Input style={{ width: '60%', marginRight: 8 }} />
                  </Form.Item>
                  {fields.length > 1 ? (
                    <MinusCircleOutlined
                      className="dynamic-delete-button"
                      onClick={() => remove(field.name)}
                    />
                  ) : null}
                </Form.Item>
              ))}
              <Form.Item>
                <Button
                  type="dashed"
                  onClick={() => add()}
                  style={{ width: '60%' }}
                  icon={<PlusOutlined />}
                >
                  添加SOL账号
                </Button>
                <Form.ErrorList errors={errors} />
              </Form.Item>
            </>
          )}
        </Form.List>
        <div style={{ width: '60%' }}>
          <ProFormText name="rpc" label="rpc节点(默认节点可能限频，建议更换为自己的节点)" />
          <ProFormText name="count" label="单号mint次数" />
          <Form.Item label="mint内容" name="type">
            <Radio.Group onChange={(e) => onFill(e.target.value)}>
              <Radio.Button value="sols">sols</Radio.Button>
              <Radio.Button value="lamp">lamp</Radio.Button>
              <Radio.Button value="other">自定义</Radio.Button>
            </Radio.Group>
          </Form.Item>
          <Form.Item name="content">
            <Input.TextArea rows={3} />
          </Form.Item>
        </div>
        <Form.Item>
          <Button type="primary" htmlType="submit">
            运行
          </Button>
        </Form.Item>
      </Form>
    </div>
  );
};

export default App;
