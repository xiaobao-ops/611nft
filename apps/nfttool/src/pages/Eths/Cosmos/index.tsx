import LogInfo from '@/components/LogInfo';
import { handleLog } from '@/utils/helper';
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { ProFormDigit, ProFormText } from '@ant-design/pro-components';
import { Button, Card, Form, FormInstance, Input, Radio } from 'antd';
import React, { useCallback, useRef, useState } from 'react';
import { DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import { GasPrice, SigningStargateClient, coins } from '@cosmjs/stargate';
import { base64FromBytes } from 'cosmjs-types/helpers';

// 私钥长度
const pkLength = 64;
const defaultContentType = 'cosmos'; // 'cosmos' | 'other'

const contentMap = {
  [defaultContentType]: {
    txt: defaultContentType,
    value: 'data:,{"op":"mint","amt":10000,"tick":"coss","p":"crc-20"}',
  },
  other: {
    txt: '其他',
    value: '',
  },
} as any;
// 默认值
const initialValues = {
  rpc: 'https://cosmos-rpc.publicnode.com',
  type: defaultContentType,
  content: contentMap[defaultContentType].value,
};

interface IWorkerData {
  log?: string;
  mineRate?: number;
}

const App: React.FC = () => {
  const workers = useRef<Worker[]>([]);
  const formRef = useRef<FormInstance>(null);
  const [mineRateList, setMineRateList] = useState<number[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [successCount, setSuccessCount] = useState<number>(0);
  const [running, setRunning] = useState<boolean>(false);

  const pushLog = useCallback((log: string, state?: string) => {
    setLogs((logs) => [handleLog(log, state), ...logs]);
  }, []);

  const generateWorkers = (values: any) => {
    const newWorkers = [];
    const cpuCount = 1
    for (let i = 0; i < cpuCount; i++) {
      const worker = new Worker(new URL('@/utils/cosmos/mine.js', import.meta.url), { type: 'module'})
      newWorkers.push(worker);


      const { rpc, pkList, content, times } = values;
      const walletData = pkList.map(async (privateKey: any) => {
        const wallet = await DirectSecp256k1Wallet.fromKey(Buffer.from(privateKey, 'hex'), 'cosmos');
        const [account] = await wallet.getAccounts();
        const walletAddress = account.address;

        const gasPrice = GasPrice.fromString('0.025uatom');
        const client = await SigningStargateClient.connectWithSigner(rpc, wallet, {
          gasPrice: gasPrice,
        });
        const balance = await client.getBalance(walletAddress, 'uatom');
        pushLog(`地址: ${walletAddress} 余额: ${parseFloat(balance.amount) / 1000000}`)
        console.log(`地址: ${walletAddress} 余额: ${parseFloat(balance.amount) / 1000000}`);

        const fee = {
          amount: coins(380, 'uatom'),
          gas: '80000',
        };
        const amount = coins(1, 'uatom');
        return {
          client,
          address: account,
          privateKey,
          content,
          times,
          fee,
          amount,
          contentData: base64FromBytes(Buffer.from(content, 'utf8'))
        };
      });
      worker.postMessage(walletData);

      worker.onerror = (e) => {
        pushLog(`Worker ${i} error: ${e.message}`, "error");
      };
      worker.onmessage = (e) => {
        const data = e.data as IWorkerData;
        if (data.log) {
          pushLog(data.log);
          setSuccessCount((count) => count + 1);
        }
        if (data.mineRate) {
          const rate = data.mineRate;
          setMineRateList((list) => {
            const newList = [...list];
            newList[i] = rate;
            return newList;
          });
        }
      };
    }
    workers.current = newWorkers;
  }

  const end = useCallback(() => {
    workers.current?.forEach((worker) => {
      worker.terminate();
    });
    workers.current = [];
  }, []);

  const onFinish = (values: any) => {
    if (!running) {
      setRunning(true);
      pushLog("🚀🚀🚀 任务开始...");

      generateWorkers(values);
    } else {
      setRunning(false);
      pushLog("🚀🚀🚀 任务结束");
      end();
    }
  };

  const onFill = (type: 'cosmos' | 'other') => {
    formRef.current?.setFieldsValue({ content: contentMap?.[type]?.value });
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
          name="pkList"
          rules={[
            {
              validator: async (_, pkList) => {
                if (!pkList?.length) return Promise.reject(new Error('请添加私钥'));
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
                >
                  <Form.Item
                    {...field}
                    validateTrigger={['onChange', 'onBlur']}
                    noStyle
                    rules={[
                      {
                        validator: async (_, pk) => {
                          if (!pk?.length) return Promise.reject(new Error('请输入私钥'));
                          if (pk?.length !== pkLength)
                            return Promise.reject(new Error('私钥长度不对'));
                          if (
                            formRef.current?.getFieldValue('pkList').filter((v: string) => v === pk)
                              .length >= 2
                          )
                            return Promise.reject(new Error('私钥重复'));
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
                  添加账号
                </Button>
                <Form.ErrorList errors={errors} />
              </Form.Item>
            </>
          )}
        </Form.List>
        <div style={{ width: '60%' }}>
          <ProFormText
            name="rpc"
            label="rpc节点"
            tooltip="默认节点可能限频，建议更换为自己的节点"
          />
          <ProFormDigit label="单号mint次数" name="times" min={1} fieldProps={{ precision: 0 }} />
          <Form.Item label="mint内容" name="type">
            <Radio.Group onChange={(e) => onFill(e.target.value)}>
              {Object.keys(contentMap).map((key) => {
                return (
                  <Radio.Button key={key} value={key}>
                    {contentMap[key].txt}
                  </Radio.Button>
                );
              })}
            </Radio.Group>
          </Form.Item>
          <Form.Item name="content">
            <Input.TextArea rows={3} />
          </Form.Item>
        </div>
        <Form.Item>
          {running ? (
            <Button danger htmlType="submit">
              Stop
            </Button>
          ) : (
            <Button type="primary" htmlType="submit">
              Mint
            </Button>
          )}
        </Form.Item>
        <Card style={{ marginTop: 8 }}>
          <LogInfo />
        </Card>
      </Form>
    </div>
  );
};

export default App;
