/**
 * Scenario Store — 知识库场景持久化层
 *
 * 与 KB / Workflow 同架构：append-only JSONL 事件流 + 内存 Map
 *   data/scenarios.jsonl 每行是 ScenarioOp：
 *     { op: 'create', scenario: Scenario }
 *     { op: 'update', id: string, patch: Partial<Scenario>, ts: number }
 *     { op: 'delete', id: string, ts: number }
 */

import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from './lib/paths.js';
import { EventEmitter } from 'events';
import { Scenario } from './scenario-types.js';

const SCENARIO_FILE = path.join(DATA_DIR, 'scenarios.jsonl');

export type ScenarioOp =
  | { op: 'create'; scenario: Scenario }
  | { op: 'update'; id: string; patch: Partial<Scenario>; ts: number }
  | { op: 'delete'; id: string; ts: number };

export const BUILTIN_SCENARIOS: Pick<Scenario, 'name' | 'icon' | 'description'>[] = [
  { name: '研发', icon: '🔧', description: '代码、架构、技术方案、仓库切片' },
  { name: '售前', icon: '💼', description: '方案、话术、竞品、客户需求' },
  { name: '财务', icon: '📊', description: '报表、对账、流程、数据' },
  { name: '运维', icon: '🛠️', description: '告警、应急响应、监控、部署' },
  { name: '市场', icon: '📢', description: '竞品动态、营销文案、行业报告' },
  { name: '产品', icon: '📱', description: '需求、原型、用户反馈、路线' },
  { name: '管理', icon: '📋', description: 'SOP、周报、会议、规范' },
  { name: '学习', icon: '📚', description: '研究报告、读书笔记、待读清单' }
];

export class ScenarioStore extends EventEmitter {
  private scenarios: Map<string, Scenario> = new Map();
  private orderCounter: number = 0;
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

  loadAll(): { scenarios: number; seeded: boolean; corrupted: number } {
    if (!fs.existsSync(SCENARIO_FILE)) {
      this.seedBuiltIn();
      return { scenarios: this.scenarios.size, seeded: true, corrupted: 0 };
    }

    const lines = fs
      .readFileSync(SCENARIO_FILE, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    let corrupted = 0;
    for (const line of lines) {
      try {
        const op: ScenarioOp = JSON.parse(line);
        this.applyOp(op);
      } catch {
        corrupted++;
      }
    }

    // 若启动时没有任何场景，自动补全内置场景
    if (this.scenarios.size === 0) {
      this.seedBuiltIn();
      return { scenarios: this.scenarios.size, seeded: true, corrupted };
    }

    return { scenarios: this.scenarios.size, seeded: false, corrupted };
  }

  private applyOp(op: ScenarioOp): void {
    switch (op.op) {
      case 'create': {
        this.scenarios.set(op.scenario.id, op.scenario);
        if (op.scenario.order > this.orderCounter) this.orderCounter = op.scenario.order;
        break;
      }
      case 'update': {
        const cur = this.scenarios.get(op.id);
        if (cur) {
          this.scenarios.set(op.id, { ...cur, ...(op.patch as Partial<Scenario>), updated_at: op.ts });
        }
        break;
      }
      case 'delete': {
        this.scenarios.delete(op.id);
        break;
      }
    }
  }

  // ======== Queries ========

  list(): Scenario[] {
    return Array.from(this.scenarios.values())
      .filter((s) => !s.archived)
      .sort((a, b) => a.order - b.order || a.created_at - b.created_at);
  }

  get(id: string): Scenario | undefined {
    return this.scenarios.get(id);
  }

  getDefaultId(): string | undefined {
    const list = this.list();
    return list[0]?.id;
  }

  // ======== Mutations ========

  create(name: string, icon?: string, description?: string): Scenario {
    this.orderCounter++;
    this.idCounter++;
    const now = Date.now();
    const scenario: Scenario = {
      id: `scenario-${now}-${this.idCounter}`,
      name: name.trim().slice(0, 32),
      icon: icon?.trim() || '🏠',
      description: description?.trim().slice(0, 200),
      order: this.orderCounter,
      archived: false,
      created_at: now,
      updated_at: now
    };
    this.appendOp({ op: 'create', scenario });
    this.scenarios.set(scenario.id, scenario);
    this.emit('scenario_created', scenario);
    return scenario;
  }

  update(
    id: string,
    patch: { name?: string; icon?: string; description?: string; archived?: boolean }
  ): Scenario | null {
    const cur = this.scenarios.get(id);
    if (!cur) return null;
    const ts = Date.now();
    const next: Scenario = {
      ...cur,
      ...(patch.name !== undefined ? { name: patch.name.trim().slice(0, 32) } : {}),
      ...(patch.icon !== undefined ? { icon: patch.icon.trim() } : {}),
      ...(patch.description !== undefined ? { description: patch.description.trim().slice(0, 200) } : {}),
      ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
      updated_at: ts
    };
    this.appendOp({ op: 'update', id, patch, ts });
    this.scenarios.set(id, next);
    this.emit('scenario_updated', next);
    return next;
  }

  delete(id: string): boolean {
    if (!this.scenarios.has(id)) return false;
    const ts = Date.now();
    this.appendOp({ op: 'delete', id, ts });
    this.scenarios.delete(id);
    this.emit('scenario_deleted', { id });
    return true;
  }

  // ======== Seed ========

  seedBuiltIn(): { added: number } {
    const before = this.scenarios.size;
    const existingNames = new Set(Array.from(this.scenarios.values()).map((s) => s.name));
    for (const s of BUILTIN_SCENARIOS) {
      if (!existingNames.has(s.name)) {
        this.create(s.name, s.icon, s.description);
      }
    }
    return { added: this.scenarios.size - before };
  }

  // ======== Internals ========

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private appendOp(op: ScenarioOp): void {
    const line = JSON.stringify(op) + '\n';
    this.writeQueue = this.writeQueue
      .then(() => this.doWrite(line))
      .catch((err) => {
        this.writeErrors++;
        console.error('[ScenarioStore] write failed:', err);
      });
  }

  private async doWrite(line: string): Promise<void> {
    await fs.promises.appendFile(SCENARIO_FILE, line, 'utf-8');
  }
}

export const scenarioStore = new ScenarioStore();
