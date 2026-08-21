import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { ProTable } from '@ant-design/pro-components';
import { Checkbox } from 'antd';
import { CheckboxChangeEvent } from 'antd/es/checkbox';
import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useLocalStorage } from 'usehooks-ts';

const defaultDataSource = {
  data: [],
  total: 0,
  success: true,
  pageSize: 20,
  current: 1,
} as any;

const AccountManager: React.FC<any> = (props, ref) => {
  const actionRef = useRef<ActionType>();
  // 选中钱包
  const [selectedRows, setSelectedRows] = useState<API.RuleListItem[]>([]);
  // 分组
  const [groups, setGroups] = useState({} as any);
  const [dataSource, setDataSource] = useState({
    ...defaultDataSource,
  });
  useEffect(() => {
    getList();
  }, []);

  useImperativeHandle(ref, () => ({
    selectedRows
  }));

  const [_walletList] = useLocalStorage('walletList', '');
  const getList = () => {
    let _dataSource = {
      ...defaultDataSource,
    };
    try {
      // let data = JSON.parse(decodeURIComponent(window.atob(_walletList)))
      // Placeholder row only. Never put a real private key or proxy credential here:
      // this file is committed, so anything in it is published.
      let data: any[] = [];

      data = data.map((v: any) => {
        v.key = v.address
        return v
      })
      _dataSource.data = data;
    } catch (e) {}

    const groups = _dataSource.data.reduce((acc: any, item: any) => {
      acc[item.group] = acc[item.group] || [];
      acc[item.group].push(item);
      return acc;
    }, {});
    setGroups(groups);

    setDataSource(_dataSource);
    return _dataSource;
  };

  const columns: ProColumns<API.RuleListItem>[] = [
    {
      width: 100,
      title: '备注',
      dataIndex: 'name',
    },
    {
      width: 100,
      title: '分组',
      dataIndex: 'group',
    },
    {
      title: '地址',
      dataIndex: 'address',
    },
    {
      width: 180,
      title: `金额(${dataSource.data
        .reduce((acc: any, item: any) => acc + parseFloat(item.balance), 0)
        .toFixed(4)})`,
      dataIndex: 'balance',
      sorter: {
        compare: (a, b) => a.balance - b.balance,
        multiple: 1,
      },
      renderText: (val: string) => {
        return `${Number(val).toFixed(4)}`;
      },
    },
  ];

  const onCheckAllChange = (e: CheckboxChangeEvent, group: string) => {
    const plainOptions = groups[group];
    if (e.target.checked) {
      // 过滤在当前分组中的，并加上当前分组所有选项
      setSelectedRows([...selectedRows.filter((v: any) => v.group !== group), ...plainOptions]);
    } else {
      // 过滤掉当前分组的选中项
      const plainAddress = plainOptions.map((opt: any) => opt.address);
      setSelectedRows(selectedRows.filter((v: any) => !plainAddress.includes(v.address)));
    }
  };

  return (
    <div>
      <ProTable<API.RuleListItem, API.PageParams>
        actionRef={actionRef}
        size="small"
        rowKey="address"
        virtual
        scroll={{ y: 300 }}
        columns={columns}
        tableAlertRender={false}
        searchFormRender={() => null}
        showSorterTooltip={false}
        dataSource={dataSource?.data}
        pagination={false}
        headerTitle={
          <div>
            <span>{`账号(${selectedRows?.length}/${dataSource?.data?.length})`}</span>
            <span style={{ marginLeft: 10 }}>
              {Object.keys(groups).map((group: any) => {
                const plainOptions = groups[group];
                const checkedList = selectedRows.filter((row: any) => row.group === group);
                const checkAll = plainOptions.length === checkedList.length;
                const indeterminate =
                  checkedList.length > 0 && checkedList.length < plainOptions.length;
                return (
                  <Checkbox
                    key={group.address}
                    style={{ marginLeft: 8 }}
                    indeterminate={indeterminate}
                    onChange={(e) => onCheckAllChange(e, group)}
                    checked={checkAll}
                  >
                    {`${group}(${checkedList.length}/${plainOptions.length})`}
                  </Checkbox>
                );
              })}
            </span>
          </div>
        }
        rowSelection={{
          columnWidth: 100,
          selectedRowKeys: selectedRows?.map((v: any) => v.address),
          onChange: (_, selectedRows) => {
            setSelectedRows(selectedRows);
          },
        }}
      />
    </div>
  );
};

export default forwardRef(AccountManager as any);
