/**
 * Workflow Store — 工作流持久化层
 *
 * 与 storage.ts / kb-store.ts 同架构：append-only JSONL 事件流
 *   data/wf.jsonl 每行是 WFOp：
 *     { op: 'create', workflow: Workflow }
 *     { op: 'update', id: string, patch: Partial<Workflow>, ts: number }
 *     { op: 'delete', id: string, ts: number }
 */

import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from './lib/paths.js';
import { EventEmitter } from 'events';
import { Workflow, WorkflowStep, WorkflowExecution } from './workflow-types.js';

const WF_FILE = path.join(DATA_DIR, 'wf.jsonl');

export type WFOp =
  | { op: 'create'; workflow: Workflow }
  | { op: 'update'; id: string; patch: Partial<Workflow>; ts: number }
  | { op: 'delete'; id: string; ts: number };

export class WorkflowStore extends EventEmitter {
  private workflows: Map<string, Workflow> = new Map();
  private orderCounter: number = 0;
  private idCounter: number = 0;
  // 执行历史：execution_id → WorkflowExecution
  private executions: Map<string, WorkflowExecution> = new Map();

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

  loadAll(): { workflows: number; seeded: boolean; corrupted: number } {
    if (!fs.existsSync(WF_FILE)) {
      this.seedSampleData();
      return { workflows: this.workflows.size, seeded: true, corrupted: 0 };
    }

    const lines = fs
      .readFileSync(WF_FILE, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    let corrupted = 0;
    for (const line of lines) {
      try {
        const op: WFOp = JSON.parse(line);
        this.applyOp(op);
      } catch {
        corrupted++;
      }
    }
    return { workflows: this.workflows.size, seeded: false, corrupted };
  }

  private applyOp(op: WFOp): void {
    switch (op.op) {
      case 'create': {
        this.workflows.set(op.workflow.id, op.workflow);
        const n = this.parseOrderFromId(op.workflow.id);
        if (n > this.orderCounter) this.orderCounter = n;
        break;
      }
      case 'update': {
        const cur = this.workflows.get(op.id);
        if (cur) {
          this.workflows.set(op.id, { ...cur, ...op.patch, updated_at: op.ts });
        }
        break;
      }
      case 'delete': {
        this.workflows.delete(op.id);
        break;
      }
    }
  }

  private parseOrderFromId(id: string): number {
    const m = id.match(/^wf-(\d+)-(\d+)$/);
    return m ? parseInt(m[2], 10) : 0;
  }

  // ======== Queries ========

  list(): Workflow[] {
    return Array.from(this.workflows.values())
      .filter((w) => !w.archived)
      .sort((a, b) => a.created_at - b.created_at);
  }

  get(id: string): Workflow | undefined {
    return this.workflows.get(id);
  }

  getExecution(executionId: string): WorkflowExecution | undefined {
    return this.executions.get(executionId);
  }

  // ======== Mutations ========

  create(name: string, icon: string, description: string, steps: WorkflowStep[]): Workflow {
    this.orderCounter++;
    this.idCounter++;
    const now = Date.now();
    const wf: Workflow = {
      id: `wf-${now}-${this.idCounter}`,
      name: name.trim().slice(0, 64),
      icon: (icon || '⚙️').slice(0, 2),
      description: (description || '').trim().slice(0, 200),
      steps: this.assignStepIds(steps),
      created_at: now,
      updated_at: now
    };
    this.appendOp({ op: 'create', workflow: wf });
    this.workflows.set(wf.id, wf);
    this.emit('workflow_created', wf);
    return wf;
  }

  update(
    id: string,
    patch: { name?: string; icon?: string; description?: string; steps?: WorkflowStep[] }
  ): Workflow | null {
    const cur = this.workflows.get(id);
    if (!cur) return null;
    const ts = Date.now();
    const next: Workflow = {
      ...cur,
      ...(patch.name !== undefined ? { name: patch.name.trim().slice(0, 64) } : {}),
      ...(patch.icon !== undefined ? { icon: patch.icon.slice(0, 2) || '⚙️' } : {}),
      ...(patch.description !== undefined ? { description: patch.description.trim().slice(0, 200) } : {}),
      ...(patch.steps !== undefined ? { steps: this.assignStepIds(patch.steps) } : {}),
      updated_at: ts
    };
    this.appendOp({ op: 'update', id, patch, ts });
    this.workflows.set(id, next);
    this.emit('workflow_updated', next);
    return next;
  }

  delete(id: string): boolean {
    if (!this.workflows.has(id)) return false;
    const ts = Date.now();
    this.appendOp({ op: 'delete', id, ts });
    this.workflows.delete(id);
    this.emit('workflow_deleted', { id });
    return true;
  }

  /** 记录一次执行实例 */
  recordExecution(exec: WorkflowExecution): void {
    this.executions.set(exec.execution_id, exec);
  }

  // ======== Sample Data (首次启动 / 手动追加) ========

  /**
   * 公开 seed：首次启动时由 loadAll() 自动调用，
   * 也可被 API /api/wf/seed-demo 显式调用追加更多 demo 工作流。
   * 查重策略：按 name 跳过已存在的。
   */
  seedDemo(): { added: number } {
    const before = this.workflows.size;
    const has = (name: string) => {
      for (const w of this.workflows.values()) if (w.name === name) return true;
      return false;
    };
    const add = (name: string, icon: string, description: string, steps: WorkflowStep[]) => {
      if (!has(name)) this.create(name, icon, description, steps);
    };

    // ===== 1. 股票分析报告 =====
    add('股票分析报告', '📊', '查茅台股价 + 飞天价格 + 生成简报', [
      {
        id: 's1',
        name: '查茅台股价',
        content: '查询贵州茅台（600519）当前股价、当日涨跌幅、成交量',
        task_type: 'query_info',
        priority: 'normal'
      },
      {
        id: 's2',
        name: '查飞天茅台酒价',
        content: '查询飞天茅台 500ml 53度 i 茅台零售价、京东百亿补贴价',
        task_type: 'query_info',
        priority: 'normal'
      },
      {
        id: 's3',
        name: '生成市场简报',
        content: '基于上面两步结果生成 200 字以内的市场简报 + 投资建议',
        task_type: 'generate_content',
        priority: 'normal',
        depends_on: ['s1', 's2']
      }
    ]);

    // ===== 2. 每日天气推送 =====
    add('每日天气推送', '🌤️', '查天气 + 生成微信推送文案', [
      {
        id: 's1',
        name: '查北京天气',
        content: '查询北京今日天气（实况 + 最高最低 + 降水概率 + 风力）',
        task_type: 'query_info',
        priority: 'normal'
      },
      {
        id: 's2',
        name: '生成推送文案',
        content: '把天气信息整理成 50 字以内的微信推送文案 + 穿衣出行建议',
        task_type: 'generate_content',
        priority: 'normal',
        depends_on: ['s1']
      }
    ]);

    // ===== 3. 销售月报生成 =====
    add('销售月报生成', '💰', '从原始数据到结构化月报', [
      {
        id: 's1',
        name: '拉取销售数据',
        content: '从数据库 / 平台 API 拉取本月订单数据',
        task_type: 'query_info',
        priority: 'normal'
      },
      {
        id: 's2',
        name: '计算 KPI',
        content: '总销售额、环比/同比、客单价、复购率、毛利率',
        task_type: 'analyze_data',
        priority: 'normal',
        depends_on: ['s1']
      },
      {
        id: 's3',
        name: 'TOP 排行',
        content: 'TOP 5 商品 / TOP 5 客户 / 各品类占比',
        task_type: 'analyze_data',
        priority: 'normal',
        depends_on: ['s1']
      },
      {
        id: 's4',
        name: '生成月报',
        content: '汇总上述结果生成 markdown 月报 + 异常点说明 + 下月建议',
        task_type: 'generate_content',
        priority: 'high',
        depends_on: ['s2', 's3']
      }
    ]);

    // ===== 4. 财务对账 SOP =====
    add('财务对账 SOP', '💼', '每日账单核对流程', [
      {
        id: 's1',
        name: '下载平台账单',
        content: '从天猫/京东/拼多多/抖店下载昨日账单 CSV',
        task_type: 'query_info',
        priority: 'normal'
      },
      {
        id: 's2',
        name: '与系统订单核对',
        content: '对账：缺单、重单、金额不一、退款冲销',
        task_type: 'analyze_data',
        priority: 'high',
        depends_on: ['s1']
      },
      {
        id: 's3',
        name: '提交财务审核',
        content: '把差异清单 + 调整建议打包发财务主管',
        task_type: 'chat',
        priority: 'high',
        depends_on: ['s2']
      }
    ]);

    // ===== 5. 客户回访 SOP =====
    add('客户回访 SOP', '🤝', '分级客户的回访节奏', [
      {
        id: 's1',
        name: '筛 A/B 级客户',
        content: '从 CRM 拉取近 90 天 GMV ≥1w 的 A/B 级客户名单',
        task_type: 'query_info',
        priority: 'normal'
      },
      {
        id: 's2',
        name: '生成个性化话术',
        content: '基于客户画像（行业/历史采购/痛点）生成个性化回访话术',
        task_type: 'generate_content',
        priority: 'normal',
        depends_on: ['s1']
      },
      {
        id: 's3',
        name: '推送企微任务',
        content: '通过企业微信把任务推送给对应销售',
        task_type: 'chat',
        priority: 'normal',
        depends_on: ['s2']
      }
    ]);

    // ===== 6. 告警应急响应 =====
    add('告警应急响应', '🚨', '生产告警的标准处置流程', [
      {
        id: 's1',
        name: '确认告警',
        content: '查看告警上下文（时间/服务/影响用户数），确认非误报',
        task_type: 'query_info',
        priority: 'urgent'
      },
      {
        id: 's2',
        name: '止血（rollback/限流）',
        content: '若影响面大，先回滚/限流/切流量',
        task_type: 'multi_step',
        priority: 'urgent',
        depends_on: ['s1']
      },
      {
        id: 's3',
        name: '根因定位',
        content: '查日志/链路/指标，定位根因（3 个假设）',
        task_type: 'analyze_data',
        priority: 'high',
        depends_on: ['s2']
      },
      {
        id: 's4',
        name: '写事故复盘',
        content: '5W1H + 改进项 + 责任人 + 截止时间，存档',
        task_type: 'generate_content',
        priority: 'normal',
        depends_on: ['s3']
      }
    ]);

    // ===== 7. 代码重构助手 =====
    add('代码重构助手', '🔧', '诊断 → 实施 → 验证 三步式', [
      {
        id: 's1',
        name: '诊断工程化问题',
        content: '扫描当前项目（src/ + public/）统计：console 数量、as any 数量、测试覆盖率、CI 配置、tsconfig 严格度',
        task_type: 'analyze_data',
        priority: 'normal'
      },
      {
        id: 's2',
        name: '按 ROI 排序建议',
        content: '把诊断结果按 ROI 排序：P0（必做）/ P1（本月）/ P2（季度）/ P3（长期），每项含具体动作+验收标准',
        task_type: 'generate_content',
        priority: 'normal',
        depends_on: ['s1']
      },
      {
        id: 's3',
        name: '验证：tsc + 重启 + smoke',
        content: '修改后运行 `npx tsc --noEmit` + 重启服务 + 端到端 smoke test',
        task_type: 'multi_step',
        priority: 'normal',
        depends_on: ['s2']
      }
    ]);

    // ===== 8. 周报生成 =====
    add('周报生成', '📝', '本周工作 → 结构化周报', [
      {
        id: 's1',
        name: '汇总本周任务',
        content: '从任务系统拉取本周本人完成任务（含聊天/工作流/手动）',
        task_type: 'query_info',
        priority: 'normal'
      },
      {
        id: 's2',
        name: '分类整理',
        content: '按"完成/进行中/阻塞/计划"四象限整理',
        task_type: 'analyze_data',
        priority: 'normal',
        depends_on: ['s1']
      },
      {
        id: 's3',
        name: '生成周报',
        content: '输出 markdown 周报：本周完成（≤5 条 bullet）、下周计划、风险求助',
        task_type: 'generate_content',
        priority: 'normal',
        depends_on: ['s2']
      }
    ]);

    // ===== 9. 微信客服自动回复 =====
    add('微信客服自动回复', '💬', '群消息智能分流', [
      {
        id: 's1',
        name: '识别消息类型',
        content: '从微信群消息中识别：咨询/投诉/闲聊/订单查询',
        task_type: 'analyze_data',
        priority: 'high'
      },
      {
        id: 's2',
        name: '查询知识库',
        content: '在 KB 中搜索匹配的 FAQ 条目（top-3）',
        task_type: 'query_info',
        priority: 'normal',
        depends_on: ['s1']
      },
      {
        id: 's3',
        name: '生成回复',
        content: '基于 FAQ + 客户上下文生成 100 字以内回复',
        task_type: 'generate_content',
        priority: 'high',
        depends_on: ['s1', 's2']
      },
      {
        id: 's4',
        name: '人工兜底',
        content: '若置信度 <0.6 推送给人工客服',
        task_type: 'chat',
        priority: 'normal',
        depends_on: ['s3']
      }
    ]);

    return { added: this.workflows.size - before };
  }

  private seedSampleData(): void {
    this.seedDemo();
  }

  // ======== Internals ========

  /** 为 step 补全 id（如客户端未传） */
  private assignStepIds(steps: WorkflowStep[]): WorkflowStep[] {
    return steps.map((s, i) => ({
      ...s,
      id: s.id || `step-${i + 1}`,
      name: s.name || `步骤 ${i + 1}`
    }));
  }

  private appendOp(op: WFOp): void {
    const line = JSON.stringify(op) + '\n';
    this.writeQueue = this.writeQueue
      .then(() => this.doWrite(line))
      .catch((err) => {
        this.writeErrors++;
        console.error('[WorkflowStore] write failed:', err);
      });
  }

  private async doWrite(line: string): Promise<void> {
    await fs.promises.appendFile(WF_FILE, line, 'utf-8');
  }
}

export const workflowStore = new WorkflowStore();
