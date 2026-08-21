import { Button, Checkbox, Tabs } from 'antd';
import React from 'react';
const CheckboxGroup = Checkbox.Group;

const tabTitles = [
  {
    type: '',
    title: '日志',
  },
  {
    type: 'pending',
    title: '待处理',
  },
  {
    type: 'success',
    title: '成功',
  },
  {
    type: 'error',
    title: '失败',
  },
];

const LogInfo: React.FC<any> = ({ title = '', logs = [], onClear }) => {
  return (
    <div>
      <span>{title}</span>
      <Tabs
        defaultActiveKey="1"
        type="card"
        size={'small'}
        items={tabTitles.map((current, i) => {
          let showLogs = logs;
          if (current.type) showLogs = logs.filter((v: any) => v.type === current.type);
          return {
            label: `${current.title}(${showLogs.length})`,
            key: current.type,
            children: showLogs.map((log: any, index: any) => (
              <div key={current.type + index} className="flex items-center">
                {log}
              </div>
            )),
          };
        })}
        tabBarExtraContent={
          <Button danger onClick={onClear}>
            清除
          </Button>
        }
      />
    </div>
  );
};

export default LogInfo;
