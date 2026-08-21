/**
 * @see https://umijs.org/zh-CN/plugins/plugin-access
 * */
export default function access() {
  return {
    // 平台功能不依赖账号、会员或签名登录；钱包连接只在链上操作时按需发生。
    canAdmin: true,
  };
}
