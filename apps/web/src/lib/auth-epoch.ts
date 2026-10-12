/**
 * 认证代际（authEpoch）：
 * - 每次认证转换（登录成功、退出、会话过期降级、bfcache 恢复复核）递增。
 * - 请求发出时捕获 epoch，响应返回时 epoch 不匹配即丢弃（api.ts 中抛出 StaleAuthError）。
 * - 管理查询 key 携带 epoch，旧代际缓存不会重新进入渲染。
 * - 本模块只保存一个递增计数，不保存任何凭证。
 */

let epoch = 0;

export function getAuthEpoch(): number {
  return epoch;
}

/** 认证状态转换（登录成功、退出、401 降级）：递增 epoch，旧代际的在途响应据此作废。 */
export function noteAuthTransition(): void {
  epoch += 1;
}

/** bfcache 恢复等场景：登录态未变但必须丢弃在途管理响应。 */
export function invalidateAuthEpoch(): void {
  epoch += 1;
}
