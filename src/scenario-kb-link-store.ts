/**
 * ScenarioKBLinkStore — 场景与知识条目的关联层
 *
 * 用于表达「某条目属于某场景」。
 * 与 KB / Scenario 同架构：append-only JSONL 事件流 + 内存 Map
 *   data/scenario_kb_links.jsonl 每行是 ScenarioKBLinkOp：
 *     { op: 'create', link: ScenarioKBLink }
 *     { op: 'delete', id: string, ts: number }
 *
 * 设计要点：
 *   - 同一 scenario_id + item_id 仅保留一个 link（去重）
 *   - 删除场景/条目时级联删除相关 link
 *   - KBItem.scenario_id 是主归属；本 store 未来可扩展为多场景共享
 */

import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from './lib/paths.js';
import { EventEmitter } from 'events';

export interface ScenarioKBLink {
  id: string;
  scenario_id: string;
  item_id: string;
  created_at: number;
}

export type ScenarioKBLinkOp = { op: 'create'; link: ScenarioKBLink } | { op: 'delete'; id: string; ts: number };

const LINKS_FILE = path.join(DATA_DIR, 'scenario_kb_links.jsonl');

export class ScenarioKBLinkStore extends EventEmitter {
  private links: Map<string, ScenarioKBLink> = new Map();
  private idCounter: number = 0;
  private writeQueue: Promise<void> = Promise.resolve();
  private writeErrors: number = 0;

  constructor() {
    super();
    this.ensureDataDir();
  }

  private ensureDataDir(): void {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  loadAll(): { links: number; corrupted: number } {
    if (!fs.existsSync(LINKS_FILE)) {
      return { links: 0, corrupted: 0 };
    }

    const lines = fs
      .readFileSync(LINKS_FILE, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    let corrupted = 0;
    for (const line of lines) {
      try {
        const op: ScenarioKBLinkOp = JSON.parse(line);
        this.applyOp(op);
      } catch {
        corrupted++;
      }
    }
    return { links: this.links.size, corrupted };
  }

  private applyOp(op: ScenarioKBLinkOp): void {
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

  list(): ScenarioKBLink[] {
    return Array.from(this.links.values()).sort((a, b) => a.created_at - b.created_at);
  }

  getForScenario(scenarioId: string): ScenarioKBLink[] {
    return Array.from(this.links.values())
      .filter((l) => l.scenario_id === scenarioId)
      .sort((a, b) => a.created_at - b.created_at);
  }

  getForItem(itemId: string): ScenarioKBLink[] {
    return Array.from(this.links.values())
      .filter((l) => l.item_id === itemId)
      .sort((a, b) => a.created_at - b.created_at);
  }

  // ======== Mutations ========

  /**
   * 为指定场景和条目建立关联（若已存在则直接返回现有 link）
   */
  ensure(scenarioId: string, itemId: string): ScenarioKBLink {
    for (const l of this.links.values()) {
      if (l.scenario_id === scenarioId && l.item_id === itemId) {
        return l;
      }
    }
    this.idCounter++;
    const now = Date.now();
    const link: ScenarioKBLink = {
      id: `sk-link-${now}-${this.idCounter}`,
      scenario_id: scenarioId,
      item_id: itemId,
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

  /** 删除条目时级联删除关联 */
  cascadeDeleteForItem(itemId: string): number {
    const affected: string[] = [];
    for (const l of this.links.values()) {
      if (l.item_id === itemId) {
        affected.push(l.id);
      }
    }
    for (const id of affected) this.delete(id);
    return affected.length;
  }

  /** 删除场景时级联删除关联 */
  cascadeDeleteForScenario(scenarioId: string): number {
    const affected: string[] = [];
    for (const l of this.links.values()) {
      if (l.scenario_id === scenarioId) {
        affected.push(l.id);
      }
    }
    for (const id of affected) this.delete(id);
    return affected.length;
  }

  // ======== Internals ========

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private appendOp(op: ScenarioKBLinkOp): void {
    const line = JSON.stringify(op) + '\n';
    this.writeQueue = this.writeQueue
      .then(() => this.doWrite(line))
      .catch((err) => {
        this.writeErrors++;
        console.error('[ScenarioKBLinkStore] write failed:', err);
      });
  }

  private async doWrite(line: string): Promise<void> {
    await fs.promises.appendFile(LINKS_FILE, line, 'utf-8');
  }
}

export const scenarioKBLinkStore = new ScenarioKBLinkStore();
