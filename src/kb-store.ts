/**
 * KB Store — 知识库持久化层
 *
 * 与 storage.ts 同架构：append-only JSONL 事件流 + 内存 Map
 *   data/kb.jsonl 每行是 KBOp：
 *     { op: 'create', entry: KBCategory | KBItem }
 *     { op: 'update', id: string, patch: Partial<...> }
 *     { op: 'delete', id: string }
 *
 * 读取时从尾部回放事件构造最新状态（last-write-wins）。
 */

import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from './lib/paths.js';
import { EventEmitter } from 'events';
import {
  KBEntry,
  KBCategory,
  KBItem,
  KBListResponse,
  KBSourceType,
  KBContentType,
  KBSourceMetadata
} from './kb-types.js';
import { kbChunkStore } from './kb-chunk-store.js';
import { scenarioKBLinkStore } from './scenario-kb-link-store.js';
import { chunkText, TextChunk } from './lib/chunking.js';
import { createEmbeddings, getEmbeddingConfig } from './lib/embedding.js';
import { scenarioStore } from './scenario-store.js';

const KB_FILE = path.join(DATA_DIR, 'kb.jsonl');

// ======== Op Types ========

export type KBOp =
  | { op: 'create'; entry: KBEntry }
  | { op: 'update'; id: string; patch: Partial<KBEntry>; ts: number }
  | { op: 'delete'; id: string; ts: number };

// ======== Store Class ========

export class KBStore extends EventEmitter {
  private categories: Map<string, KBCategory> = new Map();
  private items: Map<string, KBItem> = new Map();
  private categoryOrder: number = 0;
  private itemOrder: number = 0;
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

  /**
   * 从 JSONL 重建内存状态；如文件不存在则写入示例数据
   * 返回 { categories, items, seeded }
   */
  loadAll(): { categories: number; items: number; seeded: boolean; corrupted: number } {
    if (!fs.existsSync(KB_FILE)) {
      // 首次启动：写入示例数据
      this.seedSampleData();
      return { categories: this.categories.size, items: this.items.size, seeded: true, corrupted: 0 };
    }

    const lines = fs
      .readFileSync(KB_FILE, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    let corrupted = 0;
    for (const line of lines) {
      try {
        const op: KBOp = JSON.parse(line);
        this.applyOp(op);
      } catch {
        corrupted++;
      }
    }
    return { categories: this.categories.size, items: this.items.size, seeded: false, corrupted };
  }

  private normalizeItem(item: KBItem): KBItem {
    return {
      ...item,
      scenario_id: item.scenario_id || scenarioStore.getDefaultId() || '__orphan__',
      source_type: item.source_type || 'manual',
      chunk_count: item.chunk_count ?? 0,
      index_status: item.index_status || 'pending'
    };
  }

  private applyOp(op: KBOp): void {
    switch (op.op) {
      case 'create': {
        if (op.entry.type === 'category') {
          this.categories.set(op.entry.id, op.entry);
        } else {
          this.items.set(op.entry.id, this.normalizeItem(op.entry));
        }
        break;
      }
      case 'update': {
        if (this.categories.has(op.id)) {
          const cur = this.categories.get(op.id)!;
          this.categories.set(op.id, { ...cur, ...(op.patch as Partial<KBCategory>), updated_at: op.ts });
        } else if (this.items.has(op.id)) {
          const cur = this.items.get(op.id)!;
          this.items.set(op.id, this.normalizeItem({ ...cur, ...(op.patch as Partial<KBItem>), updated_at: op.ts }));
        }
        break;
      }
      case 'delete': {
        this.categories.delete(op.id);
        this.items.delete(op.id);
        break;
      }
    }
  }

  // ======== Queries ========

  list(): KBListResponse {
    const categories = Array.from(this.categories.values())
      .filter((c) => !c.archived)
      .sort((a, b) => a.order - b.order || a.created_at - b.created_at);
    const items = Array.from(this.items.values())
      .filter((i) => !i.archived)
      .sort((a, b) => a.order - b.order || a.created_at - b.created_at);
    return { categories, items, total: categories.length + items.length };
  }

  getCategory(id: string): KBCategory | undefined {
    return this.categories.get(id);
  }
  getItem(id: string): KBItem | undefined {
    return this.items.get(id);
  }

  // ======== Mutations ========

  createCategory(name: string, icon?: string, scenarioId?: string): KBCategory {
    this.categoryOrder++;
    this.idCounter++;
    const now = Date.now();
    const resolvedScenarioId =
      scenarioId && scenarioStore.get(scenarioId) ? scenarioId : scenarioStore.getDefaultId() || '__orphan__';
    const cat: KBCategory = {
      id: `kb-cat-${now}-${this.idCounter}`,
      type: 'category',
      scenario_id: resolvedScenarioId,
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

  updateCategory(id: string, patch: { name?: string; icon?: string; scenario_id?: string }): KBCategory | null {
    const cur = this.categories.get(id);
    if (!cur) return null;
    const ts = Date.now();
    const next: KBCategory = {
      ...cur,
      ...(patch.name !== undefined ? { name: patch.name.trim().slice(0, 32) } : {}),
      ...(patch.icon !== undefined ? { icon: patch.icon.trim() } : {}),
      ...(patch.scenario_id !== undefined && scenarioStore.get(patch.scenario_id)
        ? { scenario_id: patch.scenario_id }
        : {}),
      updated_at: ts
    };
    this.appendOp({
      op: 'update',
      id,
      patch: { name: next.name, icon: next.icon, scenario_id: next.scenario_id },
      ts
    });
    this.categories.set(id, next);
    this.emit('category_updated', next);
    return next;
  }

  deleteCategory(id: string): boolean {
    if (!this.categories.has(id)) return false;
    const ts = Date.now();
    this.appendOp({ op: 'delete', id, ts });
    this.categories.delete(id);
    // 该分类下的条目保留（前端视为「未分类」），但归档避免显示
    for (const [itemId, item] of this.items) {
      if (item.category_id === id) {
        this.appendOp({ op: 'update', id: itemId, patch: { archived: true, category_id: '__orphan__' } as any, ts });
        item.archived = true;
        (item as any).category_id = '__orphan__';
      }
    }
    this.emit('category_deleted', { id });
    return true;
  }

  createItem(
    categoryId: string,
    title: string,
    body: string,
    tags: string[] = [],
    opts: {
      scenario_id?: string;
      source_type?: KBSourceType;
      source_url?: string;
      source_metadata?: KBSourceMetadata;
      content_type?: KBContentType;
    } = {}
  ): KBItem | null {
    if (!this.categories.has(categoryId) && categoryId !== '__orphan__') return null;
    const cat = this.categories.get(categoryId);
    const resolvedScenarioId =
      (opts.scenario_id && scenarioStore.get(opts.scenario_id) && opts.scenario_id) ||
      cat?.scenario_id ||
      scenarioStore.getDefaultId() ||
      '__orphan__';
    this.itemOrder++;
    this.idCounter++;
    const now = Date.now();
    const item: KBItem = {
      id: `kb-item-${now}-${this.idCounter}`,
      type: 'item',
      scenario_id: resolvedScenarioId,
      category_id: categoryId,
      title: title.trim().slice(0, 64),
      body: body.trim().slice(0, 4000),
      tags: tags
        .slice(0, 8)
        .map((t) => t.trim())
        .filter(Boolean),
      order: this.itemOrder,
      created_at: now,
      updated_at: now,
      source_type: opts.source_type || 'manual',
      source_url: opts.source_url,
      source_metadata: opts.source_metadata,
      content_type: opts.content_type || 'text',
      chunk_count: 0,
      index_status: 'pending'
    };
    this.appendOp({ op: 'create', entry: item });
    this.items.set(item.id, item);
    this.emit('item_created', item);
    scenarioKBLinkStore.ensure(item.scenario_id, item.id);
    return item;
  }

  updateItem(
    id: string,
    patch: {
      scenario_id?: string;
      category_id?: string;
      title?: string;
      body?: string;
      tags?: string[];
      source_url?: string;
      source_metadata?: KBSourceMetadata;
      content_type?: KBContentType;
      chunk_count?: number;
      embedding_model?: string;
      last_indexed_at?: number;
      index_status?: KBItem['index_status'];
    }
  ): KBItem | null {
    const cur = this.items.get(id);
    if (!cur) return null;
    const ts = Date.now();
    const nextScenarioId =
      patch.scenario_id !== undefined
        ? scenarioStore.get(patch.scenario_id)
          ? patch.scenario_id
          : cur.scenario_id
        : cur.scenario_id;
    const nextCategoryId =
      patch.category_id !== undefined
        ? this.categories.has(patch.category_id) || patch.category_id === '__orphan__'
          ? patch.category_id
          : cur.category_id
        : cur.category_id;
    const next: KBItem = {
      ...cur,
      scenario_id: nextScenarioId,
      category_id: nextCategoryId,
      ...(patch.title !== undefined ? { title: patch.title.trim().slice(0, 64) } : {}),
      ...(patch.body !== undefined ? { body: patch.body.trim().slice(0, 4000) } : {}),
      ...(patch.tags !== undefined
        ? {
            tags: patch.tags
              .slice(0, 8)
              .map((t) => t.trim())
              .filter(Boolean)
          }
        : {}),
      ...(patch.source_url !== undefined ? { source_url: patch.source_url } : {}),
      ...(patch.source_metadata !== undefined ? { source_metadata: patch.source_metadata } : {}),
      ...(patch.content_type !== undefined ? { content_type: patch.content_type } : {}),
      ...(patch.chunk_count !== undefined ? { chunk_count: patch.chunk_count } : {}),
      ...(patch.embedding_model !== undefined ? { embedding_model: patch.embedding_model } : {}),
      ...(patch.last_indexed_at !== undefined ? { last_indexed_at: patch.last_indexed_at } : {}),
      ...(patch.index_status !== undefined ? { index_status: patch.index_status } : {}),
      updated_at: ts
    };
    this.appendOp({ op: 'update', id, patch, ts });
    this.items.set(id, next);
    this.emit('item_updated', next);
    scenarioKBLinkStore.ensure(next.scenario_id, id);
    return next;
  }

  deleteItem(id: string): boolean {
    if (!this.items.has(id)) return false;
    const ts = Date.now();
    this.appendOp({ op: 'delete', id, ts });
    this.items.delete(id);
    scenarioKBLinkStore.cascadeDeleteForItem(id);
    this.emit('item_deleted', { id });
    return true;
  }

  // ======== Sample Data (首次启动 / 手动追加) ========

  /**
   * 公开的 seed 方法：首次启动时由 loadAll() 自动调用，
   * 也可被 API /api/kb/seed-demo 显式调用追加更多 demo 数据。
   * 查重策略：按 title 跳过已存在的。
   */
  seedDemo(): { categories_added: number; items_added: number } {
    const before = { c: this.categories.size, i: this.items.size };

    const scenarios = scenarioStore.list();
    const scenarioIdByName = (name: string) => scenarios.find((s) => s.name === name)?.id;
    const defaultScenarioId = scenarioStore.getDefaultId() || '__orphan__';

    const hasItemByTitle = (title: string) => {
      for (const it of this.items.values()) if (it.title === title) return true;
      return false;
    };
    const hasCatByName = (name: string) => {
      for (const c of this.categories.values()) if (c.name === name) return true;
      return false;
    };
    const cat = (name: string, icon: string, scenarioName: string) => {
      if (hasCatByName(name)) {
        for (const c of this.categories.values()) if (c.name === name) return c;
      }
      return this.createCategory(name, icon, scenarioIdByName(scenarioName) || defaultScenarioId);
    };
    const item = (catObj: KBCategory, title: string, body: string, tags: string[] = []) => {
      if (hasItemByTitle(title)) return null;
      return this.createItem(catObj.id, title, body, tags, { scenario_id: catObj.scenario_id });
    };

    // ===== 6 个分类，分别归属不同场景 =====
    const cPrompt = cat('Prompt 模板', '📝', '学习');
    const cFAQ = cat('常见问答', '❓', '学习');
    const cBiz = cat('业务知识', '📚', '售前');
    const cSales = cat('销售场景', '💰', '售前');
    const cFin = cat('财务运营', '💼', '财务');
    const cEng = cat('工程实践', '🔧', '研发');

    // ===== Prompt 模板 =====
    item(
      cPrompt,
      '查茅台价格',
      '请帮我查询茅台的当前价格：1) 贵州茅台股票（600519）当前股价、当日涨跌幅、成交量；2) 飞天茅台 500ml 53度 i 茅台零售价；3) 拼多多/京东百亿补贴价（可选）。结果用表格输出。',
      ['股票', '零售', '茅台']
    );
    item(
      cPrompt,
      '查北京天气',
      '查询北京今天的天气：当前实况（温/湿/风）、今日最高最低、是否降雨、未来 3 天趋势。文末给一句穿衣/出行建议。',
      ['天气', '生活']
    );
    item(
      cPrompt,
      '销售月报模板',
      '请基于本月销售数据生成月报：1) 总销售额与环比/同比；2) TOP 5 商品 + TOP 5 客户；3) 各品类占比饼图（用 markdown 表格代替）；4) 异常点（同比 >±30%）说明。',
      ['报告', '分析', '销售']
    );
    item(
      cPrompt,
      '代码重构',
      '请重构当前文件，重点关注：1) 显式状态机替代隐式分支；2) 单遍 O(N) 替代多次 filter；3) JSDoc 公共 API 文档；4) 错误处理边界检查。',
      ['工程', '重构']
    );
    item(
      cPrompt,
      '周报生成器',
      '基于本周工作内容生成周报：本周完成（按重要性排序）、下周计划、风险与求助。要求不超过 500 字，每条 bullet 不超过 30 字。',
      ['周报', '总结']
    );
    item(
      cPrompt,
      '告警分析模板',
      '告警内容：{alert}。请按结构分析：1) 影响面（用户/服务/数据）；2) 紧急程度（P0/P1/P2）；3) 根因假设（至少 3 个）；4) 建议处置步骤。',
      ['运维', '告警', '应急']
    );

    // ===== 常见问答 =====
    item(
      cFAQ,
      'ai-bridge 如何启动？',
      '在 /home/kali/ai-bridge 目录下运行 `npm run dev`（自动清理 4567 端口的旧进程），服务默认监听 4567 端口，UI 访问 http://localhost:4567。',
      ['入门', '启动']
    );
    item(
      cFAQ,
      '数据存储在哪里？',
      '所有数据以 JSONL append-only 格式存储在 data/ 目录：tasks.jsonl（任务）、logs.jsonl（日志）、sessions.jsonl（会话）、kb.jsonl（知识库）、kb_links.jsonl（关联）、wf.jsonl（工作流）。',
      ['存储', 'JSONL']
    );
    item(
      cFAQ,
      '如何查看任务历史？',
      '访问 GET /api/tasks?limit=50 或在 UI 中点击任意会话查看该会话下的所有任务。WebSocket 实时推送状态变更（事件类型: task:created / task:updated）。',
      ['API', '历史']
    );
    item(
      cFAQ,
      '如何重置演示数据？',
      'KB: POST /api/kb/seed-demo  |  WF: POST /api/wf/seed-demo（均为追加模式，按 title 查重不会重复）。前端工具栏"➕ 演示"按钮一键调用。',
      ['演示', 'API']
    );

    // ===== 业务知识 =====
    item(
      cBiz,
      '茅台 600519',
      '贵州茅台股票代码 600519（上交所），总市值约 1.6 万亿。i 茅台平台零售价 1639 元/瓶（500ml 53度）。拳头产品：飞天茅台、五星茅台、茅台 1935。',
      ['股票', '茅台', '百科']
    );
    item(
      cBiz,
      'iLink 微信机器人',
      '微信 iLink 机器人通过 webhook 与 ai-bridge 通信，扫码登录后 wxid 形如 `xxx@im.bot`。支持文本/图片/视频消息收发，群聊 @消息会自动创建任务。',
      ['微信', '机器人', '集成']
    );
    item(
      cBiz,
      'JSONL 事件流',
      'JSONL（JSON Lines）是一种每行一个独立 JSON 对象的存储格式，便于追加写入和流式读取。ai-bridge 全程使用，所有变更都是可追溯的事件。',
      ['存储', '格式', '架构']
    );
    item(
      cBiz,
      'Cytoscape.js 知识图谱',
      'Cytoscape.js 是一款专业图谱可视化库，支持 cose/dagre/circle/concentric 等布局算法，提供拖拽/缩放/事件 API。ai-bridge 知识图谱用 3.30.4 版本。',
      ['图谱', '可视化', '库']
    );

    // ===== 销售场景 =====
    item(
      cSales,
      '客户分级标准',
      '按近 90 天 GMV 划分：A 级 (≥10w) — 重点维护；B 级 (1w-10w) — 定期跟进；C 级 (<1w) — 群发维护。每季度复评一次。',
      ['客户', '分级', '销售']
    );
    item(
      cSales,
      '话术：价格异议',
      '客户："太贵了"。三步：1) 共情（理解预算）2) 价值重构（拆分到日均成本/对比竞品）3) 促单（限时优惠/赠品）。忌直接降价。',
      ['话术', '异议', '销售']
    );
    item(
      cSales,
      '客户跟进节奏',
      '新客首单后：24h 内确认收货 + 致谢；7 天问使用感受；30 天推关联品；90 天复购提醒。工具：企微 SCRM 自动 push。',
      ['SOP', '跟进', '复购']
    );
    item(
      cSales,
      '客诉处理 SOP',
      '收到客诉 1h 内响应 → 24h 内给出方案 → 7 天内回访满意度。退款授权 <500 元主管即可，≥500 需经理审批。',
      ['客诉', 'SOP', '服务']
    );

    // ===== 财务运营 =====
    item(
      cFin,
      '日报核对流程',
      '每日 10:00 前完成：1) 下载各平台账单 → 2) 与系统订单核对差异 → 3) 标记异常单（缺单/重单/金额不一）→ 4) 提交财务审核。',
      ['对账', '流程', '财务']
    );
    item(
      cFin,
      '毛利率计算',
      '毛利率 = (营收 - 成本) / 营收 × 100%。注意：成本含采购 + 物流 + 包装 + 平台佣金 + 退货损耗。每月 5 日前出上月报表。',
      ['财务', '指标', '公式']
    );
    item(
      cFin,
      '现金流预警阈值',
      '健康：现金 > 月固定支出 6 倍；警惕：3-6 倍；危险：<3 倍。危险时立即冻结非必要支出，3 天内启动融资或回款。',
      ['现金流', '预警', '财务']
    );

    // ===== 工程实践 =====
    item(
      cEng,
      'TypeScript 严格模式',
      'tsconfig.json 开启：strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true。所有数组下标访问必须判空。',
      ['TS', '工程', '规范']
    );
    item(
      cEng,
      'JSONL 持久化模式',
      'append-only 事件流：每次变更写入 {op, ...} 一行 JSON，加载时从尾部回放（last-write-wins）。优点：天然审计、可回放、零迁移。',
      ['JSONL', '存储', '模式']
    );
    item(
      cEng,
      'WebSocket 重连退避',
      '客户端重连用指数退避：1s → 2s → 4s → 8s → 16s（最大），30s 心跳保活。服务端检测到 3 次心跳失败（90s）则主动断开。',
      ['WS', '重连', '网络']
    );
    item(
      cEng,
      'API 错误响应规范',
      '统一格式：{success: false, error: "用户可读消息", code?: "MACHINE_CODE", details?: {...}}。4xx = 客户端错，5xx = 服务端错。',
      ['API', '错误', '规范']
    );

    return {
      categories_added: this.categories.size - before.c,
      items_added: this.items.size - before.i
    };
  }

  private seedSampleData(): void {
    this.seedDemo();
  }

  // ======== Indexing ========

  /**
   * 为指定条目重新生成 chunks 和 embedding（后台异步）
   * 失败时会将 index_status 标记为 failed，不影响 JSONL 主数据
   */
  async reindexItem(
    id: string,
    customChunks?: TextChunk[]
  ): Promise<{ chunks: number; status: KBItem['index_status'] } | null> {
    const item = this.items.get(id);
    if (!item) return null;

    this.updateItem(id, { index_status: 'indexing' });

    const cfg = getEmbeddingConfig();
    if (!cfg) {
      this.updateItem(id, { index_status: 'failed' });
      return { chunks: 0, status: 'failed' };
    }

    try {
      // 1. 清理旧 chunks
      kbChunkStore.deleteByItem(id);

      // 2. 切分新 chunks
      const chunks =
        customChunks && customChunks.length > 0
          ? customChunks
          : chunkText(item.body, { maxChunkSize: 800, overlap: 100 });
      if (chunks.length === 0) {
        this.updateItem(id, { chunk_count: 0, index_status: 'indexed', last_indexed_at: Date.now() });
        return { chunks: 0, status: 'indexed' };
      }

      // 3. 批量生成 embedding
      const embeddings = await createEmbeddings(chunks.map((c) => c.content));

      // 4. 保存 chunks
      const now = Date.now();
      const modelKey = `${cfg.provider}/${cfg.model}`;
      kbChunkStore.createMany(
        id,
        chunks.map((c, i) => ({
          chunk_index: i,
          content: c.content,
          token_count: c.token_count,
          embedding: embeddings.embeddings[i],
          embedding_model: modelKey,
          created_at: now
        }))
      );

      this.updateItem(id, {
        chunk_count: chunks.length,
        embedding_model: modelKey,
        last_indexed_at: now,
        index_status: 'indexed'
      });

      return { chunks: chunks.length, status: 'indexed' };
    } catch (e) {
      console.error(`[KBStore] reindexItem(${id}) failed:`, e);
      this.updateItem(id, { index_status: 'failed' });
      return { chunks: 0, status: 'failed' };
    }
  }

  /**
   * 后台重新索引所有 pending 条目
   */
  schedulePendingReindex(): void {
    const pending = Array.from(this.items.values()).filter(
      (i) => !i.archived && (i.index_status === 'pending' || i.index_status === 'failed')
    );
    if (pending.length === 0) return;
    if (!getEmbeddingConfig()) {
      console.log('[KBStore] 存在待索引条目但 Embedding 未配置，跳过自动索引');
      return;
    }
    console.log(`[KBStore] 计划后台索引 ${pending.length} 个条目...`);
    // 串行执行，避免 burst 调用 embedding API
    (async () => {
      for (const item of pending) {
        await this.reindexItem(item.id);
        await new Promise((r) => setTimeout(r, 100));
      }
      console.log('[KBStore] 后台索引完成');
    })();
  }

  // ======== Internals ========

  private appendOp(op: KBOp): void {
    const line = JSON.stringify(op) + '\n';
    this.writeQueue = this.writeQueue
      .then(() => this.doWrite(line))
      .catch((err) => {
        this.writeErrors++;
        console.error('[KBStore] write failed:', err);
      });
  }

  private async doWrite(line: string): Promise<void> {
    await fs.promises.appendFile(KB_FILE, line, 'utf-8');
  }
}

export const kbStore = new KBStore();
