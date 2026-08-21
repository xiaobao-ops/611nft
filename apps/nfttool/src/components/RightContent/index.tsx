import logs from '@/utils/logs';
import { FileSearchOutlined } from '@ant-design/icons';
import { SelectLang as UmiSelectLang, useLocation, useModel } from '@umijs/max';
import { Popover, Select, Switch, Image } from 'antd';
import { useEffect, useState } from 'react';
import './index.less'

export type SiderTheme = 'light' | 'dark';

const ntcHighHexMintProject = [
  {
    value: '',
    label: '默认(无)',
  },
  {
    value: '0XTama',
    label: '0XTama',
  },
];

export const SelectLang = () => {
  return (
    <UmiSelectLang
      style={{
        padding: 4,
      }}
    />
  );
};

export const SelectProject = () => {
  const { initialState, loading, error, refresh, setInitialState } = useModel('@@initialState');

  const [showComponent, setShowComponent] = useState(false);

  const location = useLocation();
  useEffect(() => {
    // 在这里根据地址变化执行特定逻辑
    // console.log('当前页面地址:', location.pathname);
    if (location.pathname.includes('/highHexMint/highHexMint')) {
      setShowComponent(true);
    } else {
      setShowComponent(false);
    }
  }, [location]);

  if (!showComponent) {
    return null;
  }
  return (
    <span
      style={{
        display: 'flex',
        padding: '0 10px 0',
        width: '200px',
      }}
    >
      <span style={{ color: 'red' }}>
        <span>项目破签：</span>
        <span>
          <Select
            style={{ width: '100px' }}
            showSearch
            value={(initialState?.settings as any)?.ntcHighHexMintProject}
            optionFilterProp="children"
            onChange={(v) => {
              localStorage.setItem('ntcHighHexMintProject', v);
              setInitialState((preInitialState: any) => ({
                ...preInitialState,
                settings: {
                  ...preInitialState.settings,
                  ntcHighHexMintProject: v,
                },
              }));
            }}
            filterOption={(input, option) =>
              (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
            }
            options={ntcHighHexMintProject}
          />
        </span>
      </span>
    </span>
  );
};

export const webLinksArr = [
  {
    // txt: '微信',
    type: 'wechat',
  },
  {
    // txt: '推特',
    type: 'twitter',
    url: 'https://twitter.com/nfttool_club',
  },
  {
    // txt: '电报',
    type: 'telegram',
    url: 'https://t.me/NFTTOOL_CLUB',
  },
  // {
  //   txt: 'DC',
  //   type: 'discord',
  //   url: 'https://discord.com/invite/sHAn7en5xx',
  // },
  {
    txt: '文档',
    type: 'docs',
    url: 'https://nfttool.gitbook.io/nfttool/overview/guan-fang-lian-jie'
  },
  {
    txt: '日志',
    type: 'logs',
  },
]

export const TextIcon = (webLink: any) => {
  const { txt, type, url } = webLink

  const showTxt = () => {
    return (
      <span
        style={{
          display: 'flex',
          padding: '0 10px 0',
        }}
        onClick={() => {
          if (type === 'wechat') return
          if (type === 'logs') {
            return new logs().exportLogs();
          }
          window.open(url)
        }}
      >
        <span>
        {`${txt || ''}`} <img src={`/tool/assets/svg/${type}.svg`} style={{}} width={22} height={22}/>
        </span>
      </span>
    )
  }
  if (type === 'wechat') {
    return (
      <Popover
        content={
          <Image
            style={{ right: 20, bottom: 20, marginLeft: 20 }}
            src="/tool/imgs/admin2.png"
          />
        }
        title={
          <span className='pop-title'>
            <span className='title'>扫码添加管理员微信</span>
            <span className='sub-title'>入群获取web3前沿资讯</span>
          </span>
        }
      >
        {showTxt()}
      </Popover>
    )
  }
  return showTxt()
}


export const Question = () => {
  return (
    <span
      style={{
        display: 'flex',
        padding: '0 10px 0',
      }}
      onClick={() => {
        window.open('https://nfttool.gitbook.io/nfttool/overview/guan-fang-lian-jie');
      }}
    >
      <span>
        文档  <FileSearchOutlined />
      </span>
    </span>
  );
};

export const ThemeSwitcher = () => {
  const { initialState, loading, error, refresh, setInitialState } = useModel('@@initialState');

  return (
    <Switch
      checkedChildren="🌞"
      unCheckedChildren="🌜"
      checked={initialState?.settings?.navTheme === 'light'}
      onChange={(v) => {
        localStorage.setItem('theme', v ? 'light' : 'night');
        setInitialState((preInitialState: any) => ({
          ...preInitialState,
          settings: {
            ...preInitialState.settings,
            navTheme: v ? 'light' : 'realDark',
          },
        }));
      }}
    />
  );
};
