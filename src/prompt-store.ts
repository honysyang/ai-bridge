/**
 * Prompt Store — 独立提示词库持久化层
 *
 * 与 KB / Workflow 同架构：append-only JSONL 事件流 + 内存 Map
 *   data/prompts.jsonl 每行是 PromptOp：
 *     { op: 'create', entry: PromptCategory | PromptTemplate }
 *     { op: 'update', id: string, patch: Partial<...>, ts: number }
 *     { op: 'delete', id: string, ts: number }
 */

import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from './lib/paths.js';
import { EventEmitter } from 'events';
import { PromptCategory, PromptTemplate, PromptListResponse, ApplyPromptResult } from './prompt-types.js';

const PROMPT_FILE = path.join(DATA_DIR, 'prompts.jsonl');

export type PromptOp =
  | { op: 'create'; entry: PromptEntry }
  | { op: 'update'; id: string; patch: Partial<PromptEntry>; ts: number }
  | { op: 'delete'; id: string; ts: number };

type PromptEntry = PromptCategory | PromptTemplate;

const VAR_REGEX = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export class PromptStore extends EventEmitter {
  private categories: Map<string, PromptCategory> = new Map();
  private prompts: Map<string, PromptTemplate> = new Map();
  private categoryOrder: number = 0;
  private promptOrder: number = 0;
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

  loadAll(): { categories: number; prompts: number; seeded: boolean; corrupted: number } {
    if (!fs.existsSync(PROMPT_FILE)) {
      this.seedSampleData();
      return {
        categories: this.categories.size,
        prompts: this.prompts.size,
        seeded: true,
        corrupted: 0
      };
    }

    const lines = fs
      .readFileSync(PROMPT_FILE, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    let corrupted = 0;
    for (const line of lines) {
      try {
        const op: PromptOp = JSON.parse(line);
        this.applyOp(op);
      } catch {
        corrupted++;
      }
    }
    return {
      categories: this.categories.size,
      prompts: this.prompts.size,
      seeded: false,
      corrupted
    };
  }

  private normalizePrompt(p: PromptTemplate): PromptTemplate {
    return {
      ...p,
      variables: p.variables || this.extractVariables(p.content),
      archived: p.archived ?? false
    };
  }

  private applyOp(op: PromptOp): void {
    switch (op.op) {
      case 'create': {
        if (op.entry.type === 'category') {
          this.categories.set(op.entry.id, op.entry);
        } else {
          this.prompts.set(op.entry.id, this.normalizePrompt(op.entry));
        }
        break;
      }
      case 'update': {
        if (this.categories.has(op.id)) {
          const cur = this.categories.get(op.id)!;
          this.categories.set(op.id, { ...cur, ...(op.patch as Partial<PromptCategory>), updated_at: op.ts });
        } else if (this.prompts.has(op.id)) {
          const cur = this.prompts.get(op.id)!;
          this.prompts.set(
            op.id,
            this.normalizePrompt({ ...cur, ...(op.patch as Partial<PromptTemplate>), updated_at: op.ts })
          );
        }
        break;
      }
      case 'delete': {
        this.categories.delete(op.id);
        this.prompts.delete(op.id);
        break;
      }
    }
  }

  // ======== Queries ========

  list(): PromptListResponse {
    const categories = Array.from(this.categories.values()).sort(
      (a, b) => a.order - b.order || a.created_at - b.created_at
    );
    const prompts = Array.from(this.prompts.values())
      .filter((p) => !p.archived)
      .sort((a, b) => a.order - b.order || a.created_at - b.created_at);
    return { categories, prompts, total: categories.length + prompts.length };
  }

  getCategory(id: string): PromptCategory | undefined {
    return this.categories.get(id);
  }

  getPrompt(id: string): PromptTemplate | undefined {
    return this.prompts.get(id);
  }

  // ======== Mutations ========

  createCategory(name: string, icon?: string): PromptCategory {
    this.categoryOrder++;
    this.idCounter++;
    const now = Date.now();
    const cat: PromptCategory = {
      id: `prompt-cat-${now}-${this.idCounter}`,
      type: 'category',
      name: name.trim().slice(0, 32),
      icon: icon?.trim() || '📁',
      order: this.categoryOrder,
      created_at: now,
      updated_at: now
    };
    this.appendOp({ op: 'create', entry: cat });
    this.categories.set(cat.id, cat);
    this.emit('category_created', cat);
    return cat;
  }

  updateCategory(id: string, patch: { name?: string; icon?: string }): PromptCategory | null {
    const cur = this.categories.get(id);
    if (!cur) return null;
    const ts = Date.now();
    const next: PromptCategory = {
      ...cur,
      ...(patch.name !== undefined ? { name: patch.name.trim().slice(0, 32) } : {}),
      ...(patch.icon !== undefined ? { icon: patch.icon.trim() } : {}),
      updated_at: ts
    };
    this.appendOp({ op: 'update', id, patch: { name: next.name, icon: next.icon }, ts });
    this.categories.set(id, next);
    this.emit('category_updated', next);
    return next;
  }

  deleteCategory(id: string): boolean {
    if (!this.categories.has(id)) return false;
    const ts = Date.now();
    this.appendOp({ op: 'delete', id, ts });
    this.categories.delete(id);
    // 该分类下的提示词保留，但改为未分类
    for (const [pid, p] of this.prompts) {
      if (p.category_id === id) {
        this.appendOp({ op: 'update', id: pid, patch: { category_id: '__orphan__' } as any, ts });
        (p as any).category_id = '__orphan__';
      }
    }
    this.emit('category_deleted', { id });
    return true;
  }

  createPrompt(
    categoryId: string,
    title: string,
    content: string,
    opts: {
      description?: string;
      tags?: string[];
      variables?: string[];
    } = {}
  ): PromptTemplate | null {
    if (!this.categories.has(categoryId) && categoryId !== '__orphan__') return null;
    this.promptOrder++;
    this.idCounter++;
    const now = Date.now();
    const prompt: PromptTemplate = {
      id: `prompt-${now}-${this.idCounter}`,
      type: 'prompt',
      category_id: categoryId,
      title: title.trim().slice(0, 64),
      description: opts.description?.trim().slice(0, 200),
      content: content.trim(),
      variables: opts.variables && opts.variables.length > 0 ? opts.variables : this.extractVariables(content),
      tags: (opts.tags || [])
        .slice(0, 8)
        .map((t) => t.trim())
        .filter(Boolean),
      archived: false,
      order: this.promptOrder,
      created_at: now,
      updated_at: now
    };
    this.appendOp({ op: 'create', entry: prompt });
    this.prompts.set(prompt.id, prompt);
    this.emit('prompt_created', prompt);
    return prompt;
  }

  updatePrompt(
    id: string,
    patch: {
      category_id?: string;
      title?: string;
      description?: string;
      content?: string;
      tags?: string[];
      variables?: string[];
      archived?: boolean;
    }
  ): PromptTemplate | null {
    const cur = this.prompts.get(id);
    if (!cur) return null;
    const ts = Date.now();
    const next: PromptTemplate = {
      ...cur,
      ...(patch.category_id !== undefined ? { category_id: patch.category_id } : {}),
      ...(patch.title !== undefined ? { title: patch.title.trim().slice(0, 64) } : {}),
      ...(patch.description !== undefined ? { description: patch.description.trim().slice(0, 200) } : {}),
      ...(patch.content !== undefined ? { content: patch.content.trim() } : {}),
      ...(patch.tags !== undefined
        ? {
            tags: patch.tags
              .slice(0, 8)
              .map((t) => t.trim())
              .filter(Boolean)
          }
        : {}),
      updated_at: ts
    };
    // content 变更时自动刷新 variables
    if (patch.content !== undefined && (!patch.variables || patch.variables.length === 0)) {
      next.variables = this.extractVariables(next.content);
    } else if (patch.variables !== undefined) {
      next.variables = patch.variables;
    }
    this.appendOp({ op: 'update', id, patch, ts });
    this.prompts.set(id, next);
    this.emit('prompt_updated', next);
    return next;
  }

  deletePrompt(id: string): boolean {
    if (!this.prompts.has(id)) return false;
    const ts = Date.now();
    this.appendOp({ op: 'delete', id, ts });
    this.prompts.delete(id);
    this.emit('prompt_deleted', { id });
    return true;
  }

  // ======== Variable / Apply ========

  extractVariables(content: string): string[] {
    const set = new Set<string>();
    let m: RegExpExecArray | null;
    VAR_REGEX.lastIndex = 0;
    while ((m = VAR_REGEX.exec(content)) !== null) {
      set.add(m[1]);
    }
    return Array.from(set);
  }

  apply(id: string, variables: Record<string, string> = {}): ApplyPromptResult | null {
    const prompt = this.prompts.get(id);
    if (!prompt) return null;
    const missing: string[] = [];
    const rendered = prompt.content.replace(VAR_REGEX, (_match, name: string) => {
      if (variables[name] !== undefined) return variables[name];
      missing.push(name);
      return `{{${name}}}`;
    });
    return { rendered, missing: Array.from(new Set(missing)) };
  }

  // ======== Sample Data ========

  seedDemo(): { categories_added: number; prompts_added: number } {
    const before = { c: this.categories.size, p: this.prompts.size };

    const hasPromptByTitle = (title: string) => {
      for (const p of this.prompts.values()) if (p.title === title) return true;
      return false;
    };
    const hasCatByName = (name: string) => {
      for (const c of this.categories.values()) if (c.name === name) return true;
      return false;
    };
    const cat = (name: string, icon: string) => {
      if (hasCatByName(name)) {
        for (const c of this.categories.values()) if (c.name === name) return c;
      }
      return this.createCategory(name, icon);
    };
    const prompt = (
      catObj: PromptCategory,
      title: string,
      description: string,
      content: string,
      tags: string[] = []
    ) => {
      if (hasPromptByTitle(title)) return null;
      return this.createPrompt(catObj.id, title, content, { description, tags });
    };

    const cQuery = cat('查询类', '🔍');
    const cWriting = cat('写作类', '✍️');
    const cCoding = cat('代码类', '💻');
    const cBiz = cat('业务类', '💼');

    prompt(
      cQuery,
      '查茅台价格',
      '查询股票、零售价、补贴价',
      '请帮我查询茅台的当前价格：1) 贵州茅台股票（600519）当前股价、当日涨跌幅、成交量；2) 飞天茅台 500ml 53度 i 茅台零售价；3) 拼多多/京东百亿补贴价。结果用表格输出。',
      ['股票', '零售']
    );
    prompt(
      cQuery,
      '查天气',
      '查询指定城市天气',
      '查询 {{city}} 今天的天气：当前实况（温/湿/风）、今日最高最低、是否降雨、未来 3 天趋势。文末给一句穿衣/出行建议。',
      ['天气', '生活']
    );
    prompt(
      cWriting,
      '销售月报',
      '基于销售数据生成月报',
      '请基于本月销售数据生成月报：1) 总销售额与环比/同比；2) TOP 5 商品 + TOP 5 客户；3) 各品类占比；4) 异常点说明。',
      ['报告', '销售']
    );
    prompt(
      cWriting,
      '周报生成器',
      '基于工作内容生成周报',
      '基于本周工作内容生成周报：本周完成（按重要性排序）、下周计划、风险与求助。要求不超过 500 字。',
      ['周报', '总结']
    );
    prompt(
      cCoding,
      '代码重构',
      '重构代码并说明改动',
      '请重构以下代码，重点关注：1) 显式状态机替代隐式分支；2) 单遍 O(N) 替代多次 filter；3) JSDoc 公共 API 文档；4) 错误处理边界检查。\n\n```\n{{code}}\n```',
      ['工程', '重构']
    );
    prompt(
      cCoding,
      '告警分析',
      '按结构分析告警',
      '告警内容：{{alert}}。请按结构分析：1) 影响面；2) 紧急程度（P0/P1/P2）；3) 根因假设（至少 3 个）；4) 建议处置步骤。',
      ['运维', '告警']
    );
    prompt(
      cBiz,
      '客诉处理',
      '生成客诉回复话术',
      '客户反馈：{{complaint}}。请生成一段 200 字以内的回复：1) 致歉与共情；2) 解决方案；3) 后续跟进动作。',
      ['客服', '话术']
    );
    prompt(
      cBiz,
      '价格异议',
      '销售话术：客户说太贵',
      '客户说"太贵了"，请生成三步回复：1) 共情；2) 价值重构；3) 促单优惠。控制在 100 字以内。',
      ['销售', '话术']
    );

    return {
      categories_added: this.categories.size - before.c,
      prompts_added: this.prompts.size - before.p
    };
  }

  private seedSampleData(): void {
    this.seedDemo();
  }

  // ======== Lifecycle ========

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  // ======== Internals ========

  private appendOp(op: PromptOp): void {
    const line = JSON.stringify(op) + '\n';
    this.writeQueue = this.writeQueue
      .then(() => this.doWrite(line))
      .catch((err) => {
        this.writeErrors++;
        console.error('[PromptStore] write failed:', err);
      });
  }

  private async doWrite(line: string): Promise<void> {
    await fs.promises.appendFile(PROMPT_FILE, line, 'utf-8');
  }
}

export const promptStore = new PromptStore();
