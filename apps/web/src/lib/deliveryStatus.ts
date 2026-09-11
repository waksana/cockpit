import { DeliveryStatus } from '@cockpit/protocol';

export async function loadDeliveryStatus(signal: AbortSignal): Promise<DeliveryStatus> {
  const response = await fetch('/system/versions', { signal, cache: 'no-store' });
  if (!response.ok) throw new Error('无法读取权威版本/更新状态，请稍后刷新');
  return DeliveryStatus.parse(await response.json());
}
export const deliveryStateLabels: Record<string, string> = {
  queued: '已受理', building: '构建中', built: '产物已就绪', 'waiting-idle': '等待安全重启',
  activating: '正在切换', verifying: '已选择版本，等待启动及健康确认', succeeded: '交付成功',
  failed: '交付失败', unknown: '结果未知，需要核对', cancelled: '未生效，已取消',
};
export function deliveryAttention(status: DeliveryStatus | null): boolean {
  return status?.projects.some(project => Boolean(project.pending || project.prepared)
    || ['failed', 'unknown'].includes(project.latest?.state ?? '')) ?? false;
}
export function waitingLabel(reason: string | null): string | null {
  if (!reason) return null;
  return ({
    'activation-disabled': '运行启用已暂停；部署准备不等于启动',
    'weixin-unknown-paused': '微信未知发送尚待独立恢复；不会启动或重发',
    'native-busy': '原生任务仍忙，等待安全排空',
    'safe-idle-not-yet-confirmed': '尚未确认旧进程已安全退出',
    'earlier-deployment-reserves-environment': '前一个发布仍占用本环境的交付顺序',
    'explicit-deployment-not-requested': '仅构建，尚未明确请求部署',
  } as Record<string, string>)[reason] ?? reason;
}
