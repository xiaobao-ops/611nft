import { addRule, removeRule, rule, updateRule } from '@/services/ant-design-pro/api';
import { PlusOutlined } from '@ant-design/icons';
import type { ActionType, ProColumns, ProDescriptionsItemProps } from '@ant-design/pro-components';
import {
  FooterToolbar,
  ModalForm,
  PageContainer,
  ProDescriptions,
  ProFormDigit,
  ProFormText,
  ProFormTextArea,
  ProTable,
} from '@ant-design/pro-components';
import { FormattedMessage, useIntl } from '@umijs/max';
import { Button, Drawer, Form, Input, message } from 'antd';
import React, { useRef, useState } from 'react';
import type { FormValueType } from './components/UpdateForm';
import UpdateForm from './components/UpdateForm';

/**
 * @en-US Add node
 * @zh-CN 添加节点
 * @param fields
 */
const handleAdd = async (fields: API.RuleListItem, isAdd: boolean) => {
  let text = '添加'
  if (!isAdd) text = '编辑'
  console.log(fields)
  const hide = message.loading('正在'+text);
  const msg = await addRule({ ...fields, prefix: '1' });
  if (msg?.code === 0 && msg?.result?.length) {
    hide();
    message.success(text+'成功');
    return true;
  } else {
    hide();
    message.error(text+'失败');
    return false;
  }
};


/**
 *  Delete node
 * @zh-CN 删除节点
 *
 * @param selectedRows
 */
const handleRemove = async (selectedRows: API.RuleListItem[]) => {
  const hide = message.loading('正在删除');
  if (!selectedRows) return true;
  try {
    await removeRule({
      key: selectedRows.map((row) => row.key),
    });
    hide();
    message.success('Deleted successfully and will refresh soon');
    return true;
  } catch (error) {
    hide();
    message.error('Delete failed, please try again');
    return false;
  }
};


const getDaysDiff = (timestamp: number) => {
  const oneDay = 24 * 60 * 60 * 1000; // 每天的毫秒数
  const currentDate = Date.now() as number; // 当前日期

  // 计算相差的毫秒数
  const diff = timestamp - currentDate;

  const result = Math.floor(diff / oneDay)
  // 转换为天数
  return result > 0 ? result : 0;
}

const TableList: React.FC = () => {

  const [form] = Form.useForm();
  /**
   * @en-US Pop-up window of new window
   * @zh-CN 新建窗口的弹窗
   *  */
  const [createModalOpen, handleModalOpen] = useState<boolean>(false);
  const [isAdd, setIsAdd] = useState<boolean>(true);
  /**
   * @en-US The pop-up window of the distribution update window
   * @zh-CN 分布更新窗口的弹窗
   * */
  const [updateModalOpen, handleUpdateModalOpen] = useState<boolean>(false);

  const [submitting, setSubmitting] = useState<boolean>(false);
  const [showDetail, setShowDetail] = useState<boolean>(false);

  const actionRef = useRef<ActionType>();
  const [currentRow, setCurrentRow] = useState<API.RuleListItem>();
  const [selectedRowsState, setSelectedRows] = useState<API.RuleListItem[]>([]);

  /**
   * @en-US International configuration
   * @zh-CN 国际化配置
   * */
  const intl = useIntl();


  const columns: ProColumns<API.RuleListItem>[] = [
    {
      title: <FormattedMessage id="pages.searchTable.index" defaultMessage="Description" />,
      dataIndex: 'index',
      align: 'center',
      width: 60,
      search: false,
      render: (dom, entity, index) => {
        return index + 1
      },
    },
    {
      title: (
        <FormattedMessage
          id="pages.searchTable.updateForm.address.nameLabel"
          defaultMessage="地址"
        />
      ),
      align: 'center',
      dataIndex: 'account',
      width: 420,
      copyable: true,
    },
    {
      title: <FormattedMessage id="pages.searchTable.accountStatus" />,
      align: 'center',
      dataIndex: 'status',
      hideInForm: true,
      valueEnum: {
        0: {
          text: (
            <FormattedMessage
              id="pages.searchTable.accountStatus.default"
            />
          ),
          status: 'Default',
        },
        1: {
          text: (
            <FormattedMessage id="pages.searchTable.accountStatus.progress" />
          ),
          status: 'Processing',
        }
      },
    },
    {
      title: '天数',
      align: 'center',
      search: false,
      width: 200,
      sorter: true,
      dataIndex: 'expireDate',
      render: (dom, entity: any, index) => {
        return getDaysDiff(entity?.expireDate)
      },
    },
    {
      title: (
        <FormattedMessage
          id="pages.searchTable.updateAt"
        />
      ),
      align: 'center',
      search: false,
      width: 200,
      dataIndex: 'updateAt',
      valueType: 'dateTime',
    },
    {
      title: <FormattedMessage id="pages.searchTable.remark" />,
      align: 'center',
      search: false,
      dataIndex: 'remark',
    },
    {
      title: <FormattedMessage id="pages.searchTable.titleOption" defaultMessage="Operating" />,
      dataIndex: 'option',
      align: 'center',
      valueType: 'option',
      render: (_, record) => [
        <a
          key="config"
          onClick={() => {
            setIsAdd(false)
            form.setFieldsValue({ address: record?.account, day: '' });
            handleModalOpen(true);
          }}
        >
          <FormattedMessage id="pages.searchTable.operate" />
        </a>
      ],
    },
  ];

  return (
    <PageContainer
      title={false}
      // breadcrumbRender={false}
      style={{margin: 10}}
    >
      <ProTable<API.RuleListItem, API.PageParams>
        headerTitle={intl.formatMessage({
          id: 'pages.searchTable.title',
          defaultMessage: 'Enquiry form',
        })}
        actionRef={actionRef}
        rowKey="key"
        search={{
          labelWidth: 120,
        }}
        toolBarRender={() => [
          <Button
            type="primary"
            key="primary"
            onClick={() => {
              handleModalOpen(true);
            }}
          >
            <PlusOutlined /> <FormattedMessage id="pages.searchTable.new" defaultMessage="New" />
          </Button>,
        ]}
        request={rule}
        columns={columns}
      />
      {selectedRowsState?.length > 0 && (
        <FooterToolbar
          extra={
            <div>
              <FormattedMessage id="pages.searchTable.chosen" defaultMessage="Chosen" />{' '}
              <a style={{ fontWeight: 600 }}>{selectedRowsState.length}</a>{' '}
              <FormattedMessage id="pages.searchTable.item" defaultMessage="项" />
              &nbsp;&nbsp;
              <span>
                <FormattedMessage
                  id="pages.searchTable.totalServiceCalls"
                  defaultMessage="Total number of service calls"
                />{' '}
                {selectedRowsState.reduce((pre, item) => pre + item.callNo!, 0)}{' '}
                <FormattedMessage id="pages.searchTable.tenThousand" defaultMessage="万" />
              </span>
            </div>
          }
        >
          <Button
            onClick={async () => {
              await handleRemove(selectedRowsState);
              setSelectedRows([]);
              actionRef.current?.reloadAndRest?.();
            }}
          >
            <FormattedMessage
              id="pages.searchTable.batchDeletion"
              defaultMessage="Batch deletion"
            />
          </Button>
          <Button type="primary">
            <FormattedMessage
              id="pages.searchTable.batchApproval"
              defaultMessage="Batch approval"
            />
          </Button>
        </FooterToolbar>
      )}
      <ModalForm
        form={form}
        title={intl.formatMessage({
          id: 'pages.searchTable.createForm.newAccount',
        })}
        width="600px"
        open={createModalOpen}
        onOpenChange={handleModalOpen}
        submitter={{
          // 根据提交状态禁用或启用按钮
          submitButtonProps: { disabled: submitting },
        }}
        onFinish={async (value : any) => {
          setIsAdd(true)
          setSubmitting(true)
          const success = await handleAdd(value as API.RuleListItem, isAdd);
          if (success) {
            if (actionRef.current) {
              actionRef.current.reload();
            }
            handleModalOpen(false);
          }
          setIsAdd(false)
          setSubmitting(false)
        }}
      >
        <ProFormText
          label="账号地址"
          rules={[
            {
              required: true,
              message: (
                <FormattedMessage
                  id="pages.searchTable.address"
                />
              ),
            },
          ]}
          name="address"
        />
        <ProFormDigit label="天数" name="day" max={9999} min={-9999} fieldProps={{ precision: 0 }} />
        <ProFormText
          label="备注"
          name="remark"
        />
      </ModalForm>
    </PageContainer>
  );
};

export default TableList;
