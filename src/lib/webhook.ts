// ======== Webhook Event Sink（v5.5.6 产品化）========
//
// 将关键业务事件推送到外部 URL，便于与外部系统集成。
// 事件类型：
//   - task.completed
//   - task.failed
//   - task.created
//   - claw.message
//
// 配置来源（优先级）：
//   1. AIBRIDGE_WEBHOOK_URL 环境变量
//   2. systemSettings.bridge.webhook_url（暂无 UI，可后续扩展）
//
// 投递保证：最多 3 次重试，指数退避。

import { systemSettings } from './settings.js';
import { childLogger } from './logger.js';

const log = childLogger({ module: 'webhook' });

export type WebhookEventType = 'task.created' | 'task.completed' | 'task.failed' | 'claw.message';

export interface WebhookPayload {
  event: WebhookEventType;
  timestamp: number;
  data: any;
}

function getWebhookUrl(): string | undefined {
  return process.env.AIBRIDGE_WEBHOOK_URL || (systemSettings.get() as any).bridge?.webhook_url;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function deliver(url: string, payload: WebhookPayload): Promise<void> {
  const body = JSON.stringify(payload);
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-ai-bridge-Event': payload.event },
        body
      });
      if (res.ok) {
        log.debug(`webhook 投递成功: ${payload.event}`);
        return;
      }
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e as Error;
    }
    if (attempt < 2) await sleep(1000 * Math.pow(2, attempt));
  }
  log.warn(`webhook 投递失败: ${payload.event}`, { error: lastErr?.message, url });
}

export function emitWebhook(event: WebhookEventType, data: any): void {
  const url = getWebhookUrl();
  if (!url) return;
  const payload: WebhookPayload = { event, timestamp: Date.now(), data };
  // 异步投递，不阻塞主流程
  deliver(url, payload).catch(() => {});
}
