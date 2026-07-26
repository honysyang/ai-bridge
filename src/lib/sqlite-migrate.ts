// ======== SQLite 迁移脚本（v5.4.2）========
//
// 从 JSONL 文件迁移数据到 SQLite：
//   1. 读取 data/{tasks,sessions,logs,kb,wf,users}.jsonl
//   2. 调用 SqliteStore.bulkInsert* 批量写入
//   3. 写入 _meta 记录迁移版本
//
// 使用方式：
//   1. 自动：服务启动时若 SQLite 为空且 JSONL 有数据，自动迁移
//   2. 手动：npm run sqlite:migrate
//   3. 状态：curl http://localhost:4567/api/system/storage-stats

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { sqliteStore } from './sqlite-store.js';
import { Task, Session, LogEntry } from '../types.js';
import { KBCategory, KBItem } from '../kb-types.js';
import { Scenario } from '../scenario-types.js';
import { ScenarioKBLink } from '../scenario-kb-link-store.js';
import { KBChunk } from '../kb-chunk-types.js';
import { KBLink } from '../kb-link-types.js';
import { Workflow } from '../workflow-types.js';
import { User } from '../lib/users.js';
import { childLogger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const log = childLogger({ module: 'sqlite-migrate' });

import { DATA_DIR } from './paths.js';

// DATA_DIR 从 paths.js 读取，支持 AIBRIDGE_DATA_DIR 环境变量

const TASKS_FILE = path.join(DATA_DIR, 'tasks.jsonl');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.jsonl');
const LOGS_FILE = path.join(DATA_DIR, 'logs.jsonl');
const KB_FILE = path.join(DATA_DIR, 'kb.jsonl');
const KB_CHUNKS_FILE = path.join(DATA_DIR, 'kb_chunks.jsonl');
const KB_LINKS_FILE = path.join(DATA_DIR, 'kb_links.jsonl');
const SCENARIOS_FILE = path.join(DATA_DIR, 'scenarios.jsonl');
const SCENARIO_KB_LINKS_FILE = path.join(DATA_DIR, 'scenario_kb_links.jsonl');
const WF_FILE = path.join(DATA_DIR, 'wf.jsonl');
const USERS_FILE = path.join(DATA_DIR, 'users.jsonl');

interface MigrateResult {
  tasks: number;
  sessions: number;
  logs: number;
  kb_categories: number;
  kb_items: number;
  kb_chunks: number;
  kb_links: number;
  scenarios: number;
  scenario_kb_links: number;
  workflows: number;
  users: number;
  duration_ms: number;
  errors: string[];
}

/**
 * 读取 JSONL 文件，每行一个 JSON 对象
 */
function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const content = fs.readFileSync(file, 'utf-8');
  if (!content.trim()) return [];
  const out: T[] = [];
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch (e: any) {
      log.warn(`跳过损坏行 (${path.basename(file)}): ${t.slice(0, 80)}...`);
    }
  }
  return out;
}

/**
 * 从 JSONL 的 op 序列还原最终状态：
 *   { op: 'create', task/session/entry/link/workflow: {...} }
 *   { op: 'update', id: '...', patch: {...} }
 *   { op: 'delete', id: '...' }
 *   或者是扁平对象（带 id 字段）
 */
function reduceJsonlEvents<T extends { id: string }>(rows: any[]): T[] {
  const map = new Map<string, T>();
  const order: string[] = [];
  // 支持多种 create 的 payload 键名
  const createKeys = ['task', 'session', 'entry', 'link', 'workflow', 'item', 'kb_item', 'category'];
  for (const row of rows) {
    if (!row) continue;
    if (row.op === 'create') {
      let payload: any = null;
      for (const k of createKeys) {
        if (row[k]) {
          payload = row[k];
          break;
        }
      }
      if (payload && payload.id) {
        map.set(payload.id, payload as T);
        if (!order.includes(payload.id)) order.push(payload.id);
      }
    } else if (row.op === 'update' && row.id) {
      const existing = map.get(row.id);
      if (existing) map.set(row.id, { ...existing, ...row.patch } as T);
    } else if (row.op === 'delete' && row.id) {
      map.delete(row.id);
      const idx = order.indexOf(row.id);
      if (idx >= 0) order.splice(idx, 1);
    } else if (row.id) {
      // 已经是扁平对象（直接存储的 kb/wf/users），直接用
      map.set(row.id, row as T);
      if (!order.includes(row.id)) order.push(row.id);
    }
  }
  return order.map((id) => map.get(id)!).filter(Boolean);
}

/**
 * 执行完整迁移
 */
export function runMigration(): MigrateResult {
  const start = Date.now();
  const result: MigrateResult = {
    tasks: 0,
    sessions: 0,
    logs: 0,
    kb_categories: 0,
    kb_items: 0,
    kb_chunks: 0,
    kb_links: 0,
    scenarios: 0,
    scenario_kb_links: 0,
    workflows: 0,
    users: 0,
    duration_ms: 0,
    errors: []
  };

  log.info('开始从 JSONL 迁移到 SQLite...');

  // ===== Tasks（op 序列）=====
  try {
    const rawTasks = readJsonl<any>(TASKS_FILE);
    const tasks = reduceJsonlEvents<Task>(rawTasks);
    if (tasks.length > 0) {
      result.tasks = sqliteStore.bulkInsertTasks(tasks);
      log.info(`  任务: ${result.tasks}/${tasks.length}`);
    }
  } catch (e: any) {
    result.errors.push(`tasks: ${e.message}`);
  }

  // ===== Sessions（op 序列）=====
  try {
    const rawSessions = readJsonl<any>(SESSIONS_FILE);
    const sessions = reduceJsonlEvents<Session>(rawSessions);
    if (sessions.length > 0) {
      result.sessions = sqliteStore.bulkInsertSessions(sessions);
      log.info(`  会话: ${result.sessions}/${sessions.length}`);
    }
  } catch (e: any) {
    result.errors.push(`sessions: ${e.message}`);
  }

  // ===== Logs（直接是对象）=====
  try {
    const logs = readJsonl<LogEntry>(LOGS_FILE);
    if (logs.length > 0) {
      result.logs = sqliteStore.bulkInsertLogs(logs);
      log.info(`  日志: ${result.logs}/${logs.length}`);
    }
  } catch (e: any) {
    result.errors.push(`logs: ${e.message}`);
  }

  // ===== KB（分类 + 条目，op+entry 包裹）=====
  try {
    const rawRows = readJsonl<any>(KB_FILE);
    const entries = reduceJsonlEvents<any>(rawRows);
    const categories: KBCategory[] = [];
    const items: KBItem[] = [];
    for (const e of entries) {
      if (e && (e.type === 'category' || e.kind === 'category')) categories.push(e as KBCategory);
      else if (e && (e.type === 'item' || e.kind === 'item')) items.push(e as KBItem);
    }
    if (categories.length > 0) {
      const stmt = sqliteStore['db'].prepare(`
        INSERT OR REPLACE INTO kb_categories (id, scenario_id, name, icon, sort_order, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const c of categories) {
        stmt.run(c.id, c.scenario_id || null, c.name, c.icon || null, c.order || 0, c.created_at);
      }
      result.kb_categories = categories.length;
    }
    if (items.length > 0) {
      const stmt = sqliteStore['db'].prepare(`
        INSERT OR REPLACE INTO kb_items (
          id, scenario_id, category_id, title, body, tags, created_at, updated_at,
          source_type, source_url, source_metadata_json, content_type,
          chunk_count, embedding_model, index_status, last_indexed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const it of items) {
        stmt.run(
          it.id,
          it.scenario_id || null,
          it.category_id,
          it.title,
          it.body || '',
          (it.tags || []).join(','),
          it.created_at,
          it.updated_at || it.created_at,
          it.source_type || 'manual',
          it.source_url || null,
          it.source_metadata ? JSON.stringify(it.source_metadata) : null,
          it.content_type || null,
          it.chunk_count ?? 0,
          it.embedding_model || null,
          it.index_status || 'pending',
          it.last_indexed_at || null
        );
      }
      result.kb_items = items.length;
    }

    // ===== KB Chunks =====
    try {
      const rawChunks = readJsonl<any>(KB_CHUNKS_FILE);
      const chunks = reduceJsonlEvents<KBChunk>(rawChunks);
      if (chunks.length > 0) {
        const stmt = sqliteStore['db'].prepare(`
          INSERT OR REPLACE INTO kb_chunks (id, item_id, chunk_index, content, source_path, token_count, embedding_json, embedding_model, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        let inserted = 0;
        for (const c of chunks) {
          if (!c.id || !c.item_id || c.chunk_index === undefined) continue;
          stmt.run(
            c.id,
            c.item_id,
            c.chunk_index,
            c.content,
            c.source_path || null,
            c.token_count || null,
            c.embedding ? JSON.stringify(c.embedding) : null,
            c.embedding_model || null,
            c.created_at
          );
          inserted++;
        }
        result.kb_chunks = inserted;
      }
    } catch (e: any) {
      result.errors.push(`kb_chunks: ${e.message}`);
    }
    // ===== Scenarios =====
    try {
      const rawScenarios = readJsonl<any>(SCENARIOS_FILE);
      const scenarios = reduceJsonlEvents<Scenario>(rawScenarios);
      if (scenarios.length > 0) {
        const stmt = sqliteStore['db'].prepare(`
          INSERT OR REPLACE INTO kb_scenarios (id, name, icon, description, sort_order, archived, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const s of scenarios) {
          stmt.run(
            s.id,
            s.name,
            s.icon || null,
            s.description || null,
            s.order ?? 0,
            s.archived ? 1 : 0,
            s.created_at,
            s.updated_at || s.created_at
          );
        }
        result.scenarios = scenarios.length;
      }
    } catch (e: any) {
      result.errors.push(`scenarios: ${e.message}`);
    }

    // ===== Scenario KB Links =====
    try {
      const rawLinks = readJsonl<any>(SCENARIO_KB_LINKS_FILE);
      const links = reduceJsonlEvents<ScenarioKBLink>(rawLinks);
      if (links.length > 0) {
        const stmt = sqliteStore['db'].prepare(`
          INSERT OR REPLACE INTO scenario_kb_links (id, scenario_id, item_id, created_at)
          VALUES (?, ?, ?, ?)
        `);
        let inserted = 0;
        for (const l of links) {
          if (!l.id || !l.scenario_id || !l.item_id) continue;
          stmt.run(l.id, l.scenario_id, l.item_id, l.created_at);
          inserted++;
        }
        result.scenario_kb_links = inserted;
      }
    } catch (e: any) {
      result.errors.push(`scenario_kb_links: ${e.message}`);
    }

    if (categories.length || items.length || result.scenarios || result.scenario_kb_links) {
      log.info(
        `  知识库: ${result.kb_categories} 分类, ${result.kb_items} 条目, ${result.kb_chunks} chunks, ${result.scenarios} 场景, ${result.scenario_kb_links} 场景关联`
      );
    }
  } catch (e: any) {
    result.errors.push(`kb: ${e.message}`);
  }

  // ===== KB Links (op+link 包裹) =====
  try {
    const rawRows = readJsonl<any>(KB_LINKS_FILE);
    const links = reduceJsonlEvents<KBLink>(rawRows);
    if (links.length > 0) {
      const stmt = sqliteStore['db'].prepare(`
        INSERT OR REPLACE INTO kb_links (id, source_id, target_id, type, label, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      let inserted = 0;
      for (const l of links) {
        // 跳过缺字段的损坏行
        if (!l.source_id || !l.target_id || !l.type) continue;
        stmt.run(l.id, l.source_id, l.target_id, l.type, l.label || null, l.created_at);
        inserted++;
      }
      result.kb_links = inserted;
      log.info(`  KB 关联: ${inserted}/${links.length}`);
    }
  } catch (e: any) {
    result.errors.push(`kb_links: ${e.message}`);
  }

  // ===== Workflows (op+workflow 包裹) =====
  try {
    const rawRows = readJsonl<any>(WF_FILE);
    const workflows = reduceJsonlEvents<Workflow>(rawRows);
    if (workflows.length > 0) {
      const stmt = sqliteStore['db'].prepare(`
        INSERT OR REPLACE INTO workflows (id, name, description, icon, steps_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      let inserted = 0;
      for (const w of workflows) {
        // 跳过缺 name 的损坏行
        if (!w.name) continue;
        stmt.run(
          w.id,
          w.name,
          w.description || null,
          w.icon || null,
          JSON.stringify(w.steps || []),
          w.created_at,
          w.updated_at || w.created_at
        );
        inserted++;
      }
      result.workflows = inserted;
      log.info(`  工作流: ${inserted}/${workflows.length}`);
    }
  } catch (e: any) {
    result.errors.push(`workflows: ${e.message}`);
  }

  // ===== Users =====
  try {
    const userRows = readJsonl<User>(USERS_FILE);
    if (userRows.length > 0) {
      const stmt = sqliteStore['db'].prepare(`
        INSERT OR REPLACE INTO users (id, username, password_hash, role, display_name, wechat_wxid, created_at, last_login_at, disabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const u of userRows) {
        stmt.run(
          u.id,
          u.username,
          u.password_hash,
          u.role,
          u.display_name || null,
          u.wechat_wxid || null,
          u.created_at,
          u.last_login_at || null,
          u.disabled ? 1 : 0
        );
      }
      result.users = userRows.length;
      log.info(`  用户: ${result.users}`);
    }
  } catch (e: any) {
    result.errors.push(`users: ${e.message}`);
  }

  result.duration_ms = Date.now() - start;
  sqliteStore.setMeta('migrated_at', new Date().toISOString());
  sqliteStore.setMeta('schema_version', '1.2.0');

  log.info(`迁移完成，耗时 ${result.duration_ms}ms`);
  if (result.errors.length > 0) {
    log.warn(`部分表迁移失败: ${result.errors.join('; ')}`);
  }
  return result;
}

/**
 * 是否需要迁移：核心表（tasks/sessions/kb/wf/users）都为空 且 JSONL 有数据
 *
 * 不检查 logs 表（启动时会写少量 info 日志，3-7 条，不影响迁移决策）
 */
export function shouldMigrate(): boolean {
  const counts = sqliteStore.getTableCounts();
  // 只检查核心业务表
  const coreTables = ['tasks', 'sessions', 'kb_items', 'kb_categories', 'kb_links', 'workflows', 'users'];
  for (const t of coreTables) {
    if ((counts[t] || 0) > 0) return false; // 核心表已有数据
  }

  // 检查 JSONL 是否有数据
  const jsonlFiles = [TASKS_FILE, SESSIONS_FILE, KB_FILE, KB_LINKS_FILE, WF_FILE, USERS_FILE];
  for (const f of jsonlFiles) {
    if (fs.existsSync(f)) {
      const stat = fs.statSync(f);
      if (stat.size > 0) return true;
    }
  }
  return false;
}

// CLI 模式：node --experimental-strip-types src/lib/sqlite-migrate.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = runMigration();
  console.log('迁移结果:', JSON.stringify(result, null, 2));
  sqliteStore.close();
  process.exit(0);
}
