// dedup.js —— LRU 消息去重
// 微信可能在 webhook 重复推送，轮询兜底也会拉回已处理消息；用 msgId 去重
export class MessageDedup {
  constructor(maxSize = 5000) { this.maxSize = maxSize; this.entries = new Map(); }

  /** true = 已存在（应跳过）并记录 */
  has(msgId, ttlMs = 5 * 60 * 1000) {
    this._gc(ttlMs);
    if (this.entries.has(msgId)) return true;
    this.entries.set(msgId, { msgId, expiresAt: Date.now() + ttlMs });
    if (this.entries.size > this.maxSize) {
      const firstKey = this.entries.keys().next().value;
      if (firstKey) this.entries.delete(firstKey);
    }
    return false;
  }

  _gc(ttlMs) {
    const now = Date.now();
    for (const [k, v] of this.entries) {
      if (v.expiresAt < now) this.entries.delete(k);
    }
  }

  size() { return this.entries.size; }
  clear() { this.entries.clear(); }
}
