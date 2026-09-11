export type BrowserOperationLock = <T>(claim: () => T) => Promise<T>;

export async function browserOperationLock<T>(name: string, claim: () => T): Promise<T> {
  if (!globalThis.navigator?.locks) throw new Error('浏览器不支持安全的跨标签页操作锁；未发送，请使用支持 Web Locks 的安全页面。');
  return navigator.locks.request(name, { mode: 'exclusive' }, claim);
}
