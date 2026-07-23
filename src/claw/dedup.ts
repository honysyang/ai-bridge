// ======== LRU 消息去重 ========
//
// 微信 Webhook 可能重复推送；轮询兜底也可能拉回已处理消息。
// 用 msg_id 做 LRU 去重，避免重复入队。

interface Entry {
  msgId: string;
  expiresAt: number;
}

export class MessageDedup {
  private entries: Map<string, Entry> = new Map();
  private readonly maxSize: number;

  constructor(maxSize: number = 5000) {
    this.maxSize = maxSize;
  }

  /**
   * 检查 msgId 是否已存在（true=已存在=应跳过），并记录
   * @param msgId 微信消息 ID
   * @param ttlMs 去重窗口（默认使用构造时的设置）
   */
  has(msgId: string, ttlMs: number = 300000): boolean {
    this.gc(ttlMs);
    if (this.entries.has(msgId)) {
      return true;
    }
    this.add(msgId, ttlMs);
    return false;
  }

  private add(msgId: string, ttlMs: number): void {
    this.entries.set(msgId, {
      msgId,
      expiresAt: Date.now() + ttlMs
    });
    // 超过上限则淘汰最旧
    if (this.entries.size > this.maxSize) {
      const firstKey = this.entries.keys().next().value;
      if (firstKey) this.entries.delete(firstKey);
    }
  }

  private gc(ttlMs: number): void {
    const now = Date.now();
    for (const [k, v] of this.entries) {
      if (v.expiresAt < now) {
        this.entries.delete(k);
      }
    }
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
