/**
 * KBLinkStore — 知识条目关联的持久化层
 *
 * 与 kb-store 同架构：append-only JSONL 事件流 + 内存 Map
 *   data/kb_links.jsonl 每行是 KBLinkOp：
 *     { op: 'create', link: KBLink }
 *     { op: 'delete', id: string, ts: number }
 *
 * 设计要点：
 *   - 不允许 source_id === target_id（自环）
 *   - 不允许重复关联（同 source+target+type 仅保留一个）
 *   - 删除条目时由 server.ts 触发级联删除
 */

import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from './lib/paths.js';
import { EventEmitter } from 'events';
import { KBLink, KBLinkType, KBListLinksResponse } from './kb-link-types.js';

const LINKS_FILE = path.join(DATA_DIR, 'kb_links.jsonl');

// ======== Op Types ========

export type KBLinkOp = { op: 'create'; link: KBLink } | { op: 'delete'; id: string; ts: number };

// ======== Store Class ========

export class KBLinkStore extends EventEmitter {
  private links: Map<string, KBLink> = new Map();
  private idCounter: number = 0;
  private writeQueue: Promise<void> = Promise.resolve();
  private writeErrors: number = 0;

  constructor() {
    super();
    this.ensureDataDir();
  }

  // ======== Lifecycle ========

  private ensureDataDir(): void {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  loadAll(): { links: number; seeded: boolean; corrupted: number } {
    if (!fs.existsSync(LINKS_FILE)) {
      this.seedSampleData();
      return { links: this.links.size, seeded: true, corrupted: 0 };
    }

    const lines = fs
      .readFileSync(LINKS_FILE, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    let corrupted = 0;
    for (const line of lines) {
      try {
        const op: KBLinkOp = JSON.parse(line);
        this.applyOp(op);
      } catch {
        corrupted++;
      }
    }
    return { links: this.links.size, seeded: false, corrupted };
  }

  private applyOp(op: KBLinkOp): void {
    switch (op.op) {
      case 'create':
        this.links.set(op.link.id, op.link);
        break;
      case 'delete':
        this.links.delete(op.id);
        break;
    }
  }

  // ======== Queries ========

  list(): KBListLinksResponse {
    const links = Array.from(this.links.values()).sort((a, b) => a.created_at - b.created_at);
    return { links, total: links.length };
  }

  get(id: string): KBLink | undefined {
    return this.links.get(id);
  }

  /** 获取与某条目相关的所有关联（出入双向） */
  getForItem(itemId: string): KBLink[] {
    return Array.from(this.links.values())
      .filter((l) => l.source_id === itemId || l.target_id === itemId)
      .sort((a, b) => a.created_at - b.created_at);
  }

  // ======== Mutations ========

  create(sourceId: string, targetId: string, type: KBLinkType = 'related', label?: string): KBLink | { error: string } {
    if (sourceId === targetId) {
      return { error: '不能创建自环关联（source 和 target 不能相同）' };
    }
    // 查重
    for (const l of this.links.values()) {
      if (l.source_id === sourceId && l.target_id === targetId && l.type === type) {
        return { error: '该关联已存在' };
      }
    }
    this.idCounter++;
    const now = Date.now();
    const link: KBLink = {
      id: `kb-link-${now}-${this.idCounter}`,
      source_id: sourceId,
      target_id: targetId,
      type,
      label: label?.trim().slice(0, 32) || undefined,
      created_at: now
    };
    this.appendOp({ op: 'create', link });
    this.links.set(link.id, link);
    this.emit('link_created', link);
    return link;
  }

  delete(id: string): boolean {
    if (!this.links.has(id)) return false;
    const ts = Date.now();
    this.appendOp({ op: 'delete', id, ts });
    this.links.delete(id);
    this.emit('link_deleted', { id });
    return true;
  }

  /** 级联删除：删除条目时调用，清除所有与该条目相关的关联 */
  cascadeDeleteForItem(itemId: string): number {
    const affected: string[] = [];
    for (const l of this.links.values()) {
      if (l.source_id === itemId || l.target_id === itemId) {
        affected.push(l.id);
      }
    }
    for (const id of affected) this.delete(id);
    return affected.length;
  }

  // ======== Sample Data (首次启动 / 手动追加) ========

  private seedSampleData(): void {
    // 关联只在 kb.jsonl 有数据时才有意义
    // 首次启动 kb-store 会先 seedSampleData 再 seedSampleDataLinks 时机不对
    // 因此本函数留空，实际关联由 server.ts 在 kbStore.loadAll() 完成后根据现有条目创建
  }

  /**
   * 公开 seed：首次启动时由 loadAll() 自动调用（这里不做事），
   * 也可被 API /api/kb/links/seed-demo 显式调用追加 demo 关联。
   *
   * 策略：按 title 匹配条目，再创建跨分类关联。
   * 查重：source+target+type 三元组已存在则跳过。
   */
  seedDemo(kbItems: Array<{ id: string; title: string; category_id: string }>): {
    links_added: number;
    links_skipped: number;
    errors: string[];
  } {
    let added = 0;
    let skipped = 0;
    const errors: string[] = [];
    const byTitle = new Map<string, string>();
    for (const it of kbItems) byTitle.set(it.title, it.id);

    type Link = {
      from: string;
      to: string;
      type: 'related' | 'depends_on' | 'references' | 'contains';
      label?: string;
    };
    const LINKS: Link[] = [
      // ===== Prompt ↔ 业务 =====
      { from: '查茅台价格', to: '茅台 600519', type: 'references', label: '查询目标' },
      { from: '查茅台价格', to: 'iLink 微信机器人', type: 'related', label: '可在微信中发送' },
      { from: '查北京天气', to: 'JSONL 事件流', type: 'related', label: '示例数据存储' },
      { from: '销售月报模板', to: '客户分级标准', type: 'depends_on', label: '依赖客户分级' },
      { from: '销售月报模板', to: '毛利率计算', type: 'references', label: '引用指标公式' },
      { from: '代码重构', to: 'TypeScript 严格模式', type: 'depends_on', label: '依赖 tsconfig' },
      { from: '代码重构', to: 'JSONL 持久化模式', type: 'references', label: '持久化范式' },
      { from: '周报生成器', to: '周报生成', type: 'references', label: '工作流模板' },
      { from: '告警分析模板', to: '告警应急响应', type: 'references', label: '工作流模板' },
      // ===== FAQ ↔ 工程 =====
      { from: 'ai-bridge 如何启动？', to: 'TypeScript 严格模式', type: 'related', label: '开发环境' },
      { from: 'ai-bridge 如何启动？', to: 'API 错误响应规范', type: 'depends_on', label: 'API 规范' },
      { from: '数据存储在哪里？', to: 'JSONL 事件流', type: 'references', label: '存储格式' },
      { from: '数据存储在哪里？', to: 'JSONL 持久化模式', type: 'related', label: '范式' },
      { from: '如何重置演示数据？', to: 'Cytoscape.js 知识图谱', type: 'related', label: '可视化展示' },
      // ===== 业务 ↔ 工程 =====
      { from: 'JSONL 事件流', to: 'JSONL 持久化模式', type: 'contains', label: '格式 ↔ 范式' },
      { from: 'Cytoscape.js 知识图谱', to: 'WebSocket 重连退避', type: 'related', label: '前端技术栈' },
      { from: 'iLink 微信机器人', to: 'WebSocket 重连退避', type: 'depends_on', label: '长连接机制' },
      // ===== 销售 ↔ 财务 =====
      { from: '客户分级标准', to: '日报核对流程', type: 'related', label: '业务对接' },
      { from: '客户跟进节奏', to: '客户回访 SOP', type: 'references', label: '对应工作流' },
      { from: '客诉处理 SOP', to: '现金流预警阈值', type: 'related', label: '售后影响现金流' },
      { from: '话术：价格异议', to: '毛利率计算', type: 'related', label: '不能直接降价' }
    ];

    for (const l of LINKS) {
      const sourceId = byTitle.get(l.from);
      const targetId = byTitle.get(l.to);
      if (!sourceId || !targetId) {
        errors.push(`关联跳过: 找不到条目 "${l.from}" → "${l.to}"`);
        skipped++;
        continue;
      }
      const result = this.create(sourceId, targetId, l.type, l.label);
      if ('error' in result) {
        skipped++;
      } else {
        added++;
      }
    }

    return { links_added: added, links_skipped: skipped, errors };
  }

  // ======== Internals ========

  private appendOp(op: KBLinkOp): void {
    const line = JSON.stringify(op) + '\n';
    this.writeQueue = this.writeQueue
      .then(() => this.doWrite(line))
      .catch((err) => {
        this.writeErrors++;
        console.error('[KBLinkStore] write failed:', err);
      });
  }

  private async doWrite(line: string): Promise<void> {
    await fs.promises.appendFile(LINKS_FILE, line, 'utf-8');
  }
}

export const kbLinkStore = new KBLinkStore();
