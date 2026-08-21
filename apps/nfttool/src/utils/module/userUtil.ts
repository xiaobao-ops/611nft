class UserUtil {
  originUserInfo = {
    _id: '',
    account: '',
    token: '',
    expireDate: 0,
    efficientTime: '',
    expireTipTime: '',
    tokenId: 0,
    // rpcKey: '',
    // isAdmin: false,
  };
  userInfo_local = JSON.parse(localStorage.getItem('userInfo') || '{}')
  userInfo = Object.assign({}, this.originUserInfo, this.userInfo_local) as any;

  hasTime() {
    return this.userInfo.expireDate - Date.now() > 0;
  }

  isAdming() {
    return this.userInfo.isAdmin;
  }

  initUser(userInfo: any) {
    const userInfo_save = Object.assign({}, this.originUserInfo, userInfo);
    this.computeEfficientTime(userInfo_save)
    this.userInfo = userInfo_save as any
    localStorage.setItem('userInfo', JSON.stringify(userInfo_save));
    localStorage.setItem('erc20-newKline', 'false');
    localStorage.setItem('erc20ShowQuickSwapBtn', 'false');
    const localErc20List = localStorage.getItem('erc20-collectList')
    if (!localErc20List || localErc20List == '[]') {
      localStorage.setItem('erc20-collectList', JSON.stringify([{"name":"WETH","symbol":"WETH","address":"0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2","pairAddress":"0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640","priceUsd":"-","h1PriceChange":0,"labels":["v3"],"h24PriceChange":0}]));
    }

    // console.log('userInfo_local', this.originUserInfo, userInfo_local, userInfo, userInfo_save)
    return this.userInfo;
  }

  computeEfficientTime(userInfo: any) {
    if (userInfo == null || !userInfo.token || !userInfo.expireDate) {
      userInfo.efficientTime = '0小时';
      return;
    }
    const range = userInfo.expireDate - Date.now();
    if (range <= 0) {
      userInfo.efficientTime = '0小时';
      return;
    }
    const hours = range / 60 / 60 / 1000;
    const day = Math.floor(hours / 24);
    const hour = Math.ceil(hours % 24);
    userInfo.efficientTime = (day > 0 ? day + '天' : '') + (hour + '小时');
    if (hours < 48 && hours > 0) {
      let t = localStorage.getItem('expireTip') || (0 as any);
      (Date.now() - 1 * t) / 1000 / 60 / 60 >= 48 && (userInfo.expireTipTime = Math.ceil(hours));
    } else {
      userInfo.expireTipTime = '';
    }
    return;
  }
}

export const userUtil = new UserUtil();
