import { BookFilled, DownloadOutlined, TwitterOutlined, UploadOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { useModel } from '@umijs/max';
import { Button, Card, Image, Upload, UploadProps, message, theme } from 'antd';
import React from 'react';

// import OpenSeaSvg from 'assets/opensea.svg'
/**
 * 每个单独的卡片，为了复用样式抽成了组件
 * @param param0
 * @returns
 */
const InfoCard: React.FC<{
  title: string;
  index: number;
  desc: any;
  href: string;
  type: string;
}> = ({ title, href, index, desc, type }) => {
  const { useToken } = theme;

  const { token } = useToken();

  const exportConfig = () => {
    let r = ['userInfo', 'length', 'clear', 'getItem', 'key', 'removeItem', 'setItem'],
      t = {} as any;
    for (const e in localStorage) r.includes(e) || (t[e] = localStorage.getItem(e));
    var a = document.createElement('a');
    a.setAttribute(
      'href',
      'data:text/plain;charset=utf-8,' + window.btoa(encodeURI(JSON.stringify(t))),
    ),
      a.setAttribute('download', 'config.txt'),
      (a.style.display = 'none'),
      document.body.appendChild(a),
      a.click(),
      document.body.removeChild(a);
  };

  const props: UploadProps = {
    name: 'file',
    showUploadList: false,
    beforeUpload: (fileObj) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const { result } = event.target as any;
        try {
          let r = JSON.parse(decodeURI(window.atob(result)));
          for (const t in r) localStorage.setItem(t, r[t]);
          message.success(`${fileObj.name} 导入成功！`);
        } catch (a) {
          message.error(`${fileObj.name} 读取错误，请确认配置文件是否正确！`);
        }
      };
      reader.readAsText(fileObj);
      return false;
    },
  };

  return (
    <div
      style={{
        position: 'relative',
        backgroundColor: token.colorBgContainer,
        boxShadow: token.boxShadow,
        borderRadius: '8px',
        fontSize: '14px',
        color: token.colorTextSecondary,
        lineHeight: '22px',
        padding: '16px 19px',
        width: '300px',
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: '4px',
          alignItems: 'center',
        }}
      >
        <div
          style={{
            width: 48,
            height: 48,
            lineHeight: '22px',
            backgroundSize: '100%',
            textAlign: 'center',
            padding: '8px 16px 16px 12px',
            color: '#FFF',
            fontWeight: 'bold',
            backgroundImage:
              "url('https://gw.alipayobjects.com/zos/bmw-prod/daaf8d50-8e6d-4251-905d-676a24ddfa12.svg')",
          }}
        >
          {index}
        </div>
        <div
          style={{
            fontSize: '16px',
            color: token.colorText,
            paddingBottom: 8,
          }}
        >
          {title}
        </div>
      </div>
      <div style={{ display: 'flex' }}>
        <div
          style={{
            fontSize: '14px',
            color: token.colorTextSecondary,
            textAlign: 'justify',
            lineHeight: '22px',
            marginBottom: 40,
          }}
        >
          {desc}
        </div>
        {type === 'wechat' ? (
          <div>
            <Image
              style={{ right: 20, bottom: 20, marginLeft: 10 }}
              width={70}
              src="/tool/imgs/admin2.png"
            />
          </div>
        ) : null}
      </div>
      <span style={{ position: 'absolute', left: 20, bottom: 20 }}>
        {type === 'twitter' ? (
          <a href={href} target="_blank" rel="noreferrer">
            <TwitterOutlined style={{ verticalAlign: 'middle' }} /> nfttool_club {'>'}
          </a>
        ) : null}

        {type === 'EtherScan' ? (
          <a href={href} target="_blank" rel="noreferrer">
            <img
              style={{ width: 14, height: 14, verticalAlign: 'middle' }}
              src="/tool/assets/etherscan.svg"
            />{' '}
            EtherScan {'>'}
          </a>
        ) : null}

        {type === 'Doc' ? (
          <a href={href} target="_blank" rel="noreferrer">
            <BookFilled style={{ verticalAlign: 'middle' }} /> 使用文档 {'>'}
          </a>
        ) : null}

        {type === 'config' ? (
          <div>
            <Upload {...props}>
              <Button icon={<UploadOutlined />} type="primary" style={{ marginRight: 5 }}>
                <span style={{ color: 'white' }}>导入配置</span>
              </Button>
            </Upload>

            <Button icon={<DownloadOutlined />} onClick={exportConfig} type="primary">
              导出配置
            </Button>
          </div>
        ) : null}
      </span>
    </div>
  );
};

const Welcome: React.FC = () => {
  const { token } = theme.useToken();
  const { initialState } = useModel('@@initialState');
  return (
    <PageContainer title={false} breadcrumbRender={false} style={{ margin: 16 }}>
      <Card
        style={{
          borderRadius: 8,
        }}
        bodyStyle={{
          backgroundImage:
            initialState?.settings?.navTheme === 'realDark'
              ? 'background-image: linear-gradient(75deg, #1A1B1F 0%, #191C1F 100%)'
              : 'background-image: linear-gradient(75deg, #FBFDFF 0%, #F5F7FF 100%)',
        }}
      >
        <div
          style={{
            backgroundPosition: '100% -30%',
            backgroundRepeat: 'no-repeat',
            backgroundSize: '274px auto',
            backgroundImage:
              "url('https://gw.alipayobjects.com/mdn/rms_a9745b/afts/img/A*BuFmQqsB2iAAAAAAAAAAAAAAARQnAQ')",
          }}
        >
          <div
            style={{
              fontSize: '20px',
              color: token.colorTextHeading,
            }}
          >
            欢迎来到 NFT TOOL CLUB
          </div>
          <p
            style={{
              fontSize: '14px',
              color: token.colorTextSecondary,
              lineHeight: '22px',
              marginTop: 15,
              width: '65%',
            }}
          >
            NFT TOOL CLUB，致力于建设更好用的web3脚本工具社区。
          </p>
          <p
            style={{
              fontSize: '14px',
              color: token.colorTextSecondary,
              lineHeight: '22px',
              marginTop: 10,
              width: '65%',
            }}
          >
            工具主要提供批量打狗、盯盘、抢公售、跟单、挂单、blur刷分、空投撸毛等功能，助您放大web3收益。
          </p>
          <p
            style={{
              fontSize: '14px',
              color: token.colorError,
              lineHeight: '22px',
              fontWeight: 'bold',
              marginTop: 10,
              marginBottom: 20,
              width: '65%',
            }}
          >
            资金安全提醒：请在确保安全的环境下运行，私钥均在本地存储，清空本地缓存数据将丢失，请及时导出网站配置，妥善保管！不要随意存储或者泄露给他人！
            <br />
            使用安全提醒：本工具为辅助工具，请充分了解使用方法后谨慎使用。
          </p>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 16,
            }}
          >
            <InfoCard
              index={1}
              href="https://twitter.com/nfttool_club"
              title="关于我们"
              desc="团队成员来于互联网大厂，All In Web3，提供稳定的技术支持。"
              type="twitter"
            />
            <InfoCard
              index={2}
              title="了解 NFT TOOL 功能"
              href="https://nfttool.gitbook.io/nfttool/overview/guan-fang-lian-jie"
              desc="主要功能：NFT&撸毛，更多详细功能点此查看使用文档。"
              type="Doc"
            />
            <InfoCard
              index={3}
              title="网站配置"
              href="https://etherscan.io/address/0xa95998edd0150ea22d5ba977ecd23db2518e34fd"
              desc="导入/导出网站配置数据，以便在其他电脑使用，请妥善保管，不要泄露！"
              type="config"
            />
            <InfoCard
              index={4}
              title="加入 NFT TOOL CLUB"
              href="https://etherscan.io/address/0xa95998edd0150ea22d5ba977ecd23db2518e34fd"
              desc="扫码添加管理员微信，入群获取web3最新前沿资讯。"
              type="wechat"
            />
          </div>
        </div>
      </Card>

    </PageContainer>
  );
};

export default Welcome;
