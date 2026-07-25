// ======== AI 模型配置（v5.4.2 扩展多模型 + 任务类型路由）========
//
// 设计原则：
//   1. 模型定义（provider / base_url / supported_models）在代码里静态声明（schema）
//   2. 凭证（API key 等敏感字段）从 ~/.config/agent-canvas/secrets.env 读取（只读遮罩）
//   3. 用户选择（默认模型、各 provider 启用状态、任务类型路由）持久化到 data/models-config.json
//
// v5.4.2 新增：
//   - 多 provider 支持（OpenAI、Anthropic、Qwen、Zhipu、Moonshot、Ollama、Mock）
//   - 任务类型路由：每种 task_type 可指定使用的 provider/model（如 reasoning → deepseek-reasoner）
//   - 全局默认：未指定 task_type 时使用 default_provider/default_model
//
// 为什么不把 API key 存在 models-config.json？
//   避免该文件被误推到 git、误备份、误分享。所有密钥统一在 secrets.env（chmod 600）。

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { DATA_DIR, SECRETS_FILE } from './paths.js';
import { loadOrCreateSecret } from './auth.js';

export type TaskType =
  'chat' | 'reply_message' | 'query_info' | 'analyze_data' | 'execute_command' | 'generate_content' | 'multi_step';

export interface ModelProvider {
  id: string; // 'deepseek' / 'openai' / 'mock' 等
  name: string; // 显示名
  base_url: string; // 兼容 OpenAI Chat Completions 的 base URL
  env_key: string; // secrets.env 中的 API key 变量名（如 DEEPSEEK_API_KEY）
  env_base: string; // 覆盖 base URL 的 env 变量名
  env_model: string; // 默认模型名 env 变量名
  models: ModelInfo[]; // 支持的模型列表
  default_model: string; // 该 provider 的默认模型
  description?: string;
  /** 该 provider 推荐用于哪些任务类型（不强制） */
  recommended_for?: TaskType[];
}

export interface ModelInfo {
  id: string; // 'deepseek-chat'
  name: string; // 显示名
  context_window?: number; // 上下文窗口（tokens）
  max_output?: number; // 最大输出（tokens）
  description?: string;
  tier?: 'flagship' | 'fast' | 'reasoning' | 'embedding' | 'local';
  /** 该模型擅长的任务类型（用于前端智能推荐） */
  best_for?: TaskType[];
}

export interface CustomProvider {
  id: string;
  name: string;
  base_url: string;
  api_key: string; // 自定义 provider 的 API key，保存在 models-config.json
  models: ModelInfo[];
  default_model: string;
  description?: string;
  is_custom?: boolean; // 标记为自定义，便于前端区分
}

export interface ModelsConfig {
  default_provider: string;
  default_model: string;
  enabled_providers: string[]; // 用户启用的 provider 列表
  provider_overrides: Record<string, { default_model?: string }>;
  /** v5.4.2: 任务类型 → 路由（provider + model），缺省走 default_provider/default_model */
  task_routing: Partial<Record<TaskType, { provider: string; model: string }>>;
  /** v5.4.2: 路由策略 */
  routing_strategy: 'fixed' | 'smart'; // fixed=按 task_routing 固定；smart=根据提示词长度/复杂度自动选
  /** v5.5.4: 用户自定义 provider（前端可新建） */
  custom_providers: CustomProvider[];
  /** v5.5.4: 知识库模型路由 */
  kb_provider?: string;
  kb_model?: string;
}

export const DEFAULT_TASK_ROUTING: ModelsConfig['task_routing'] = {
  // 默认路由：reasoning 类任务用 R1，generate_content 用 chat，其他走默认
  multi_step: { provider: 'deepseek', model: 'deepseek-reasoner' },
  analyze_data: { provider: 'deepseek', model: 'deepseek-reasoner' },
  generate_content: { provider: 'deepseek', model: 'deepseek-chat' }
};

export const DEFAULT_MODELS_CONFIG: ModelsConfig = {
  default_provider: 'deepseek',
  default_model: 'deepseek-chat',
  enabled_providers: ['deepseek', 'mock'],
  provider_overrides: {},
  task_routing: { ...DEFAULT_TASK_ROUTING },
  routing_strategy: 'fixed',
  custom_providers: []
};

/** 静态模型目录（v5.4.2 扩展为多 provider） */
export const MODEL_PROVIDERS: ModelProvider[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    base_url: 'https://api.deepseek.com/v1',
    env_key: 'DEEPSEEK_API_KEY',
    env_base: 'DEEPSEEK_BASE_URL',
    env_model: 'DEEPSEEK_MODEL',
    description: '深度求索 · 国产高性价比 OpenAI 兼容 API',
    default_model: 'deepseek-chat',
    recommended_for: ['chat', 'multi_step', 'analyze_data', 'generate_content'],
    models: [
      {
        id: 'deepseek-chat',
        name: 'DeepSeek-V3 Chat',
        context_window: 64000,
        max_output: 8192,
        tier: 'flagship',
        description: '通用对话主力模型，64K 上下文',
        best_for: ['chat', 'reply_message', 'generate_content']
      },
      {
        id: 'deepseek-reasoner',
        name: 'DeepSeek-R1 Reasoner',
        context_window: 64000,
        max_output: 8192,
        tier: 'reasoning',
        description: '深度推理模型，适合复杂任务',
        best_for: ['multi_step', 'analyze_data']
      }
    ]
  },
  {
    id: 'openai',
    name: 'OpenAI',
    base_url: 'https://api.openai.com/v1',
    env_key: 'OPENAI_API_KEY',
    env_base: 'OPENAI_BASE_URL',
    env_model: 'OPENAI_MODEL',
    description: 'OpenAI · GPT 系列（兼容 Azure OpenAI、LocalAI 等）',
    default_model: 'gpt-4o-mini',
    recommended_for: ['chat', 'generate_content', 'analyze_data'],
    models: [
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        context_window: 128000,
        max_output: 16384,
        tier: 'flagship',
        description: '多模态旗舰模型',
        best_for: ['chat', 'generate_content', 'analyze_data']
      },
      {
        id: 'gpt-4o-mini',
        name: 'GPT-4o mini',
        context_window: 128000,
        max_output: 16384,
        tier: 'fast',
        description: '高性价比小模型',
        best_for: ['chat', 'reply_message']
      },
      {
        id: 'o1',
        name: 'o1',
        context_window: 200000,
        max_output: 100000,
        tier: 'reasoning',
        description: '复杂推理专用',
        best_for: ['multi_step', 'analyze_data']
      },
      {
        id: 'o1-mini',
        name: 'o1-mini',
        context_window: 128000,
        max_output: 65536,
        tier: 'reasoning',
        description: '轻量推理',
        best_for: ['analyze_data']
      }
    ]
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    base_url: 'https://api.anthropic.com/v1',
    env_key: 'ANTHROPIC_API_KEY',
    env_base: 'ANTHROPIC_BASE_URL',
    env_model: 'ANTHROPIC_MODEL',
    description: 'Anthropic · Claude 系列（需走兼容代理）',
    default_model: 'claude-3-5-sonnet-20241022',
    recommended_for: ['chat', 'generate_content', 'analyze_data'],
    models: [
      {
        id: 'claude-3-5-sonnet-20241022',
        name: 'Claude 3.5 Sonnet',
        context_window: 200000,
        max_output: 8192,
        tier: 'flagship',
        description: '平衡性能与速度的旗舰',
        best_for: ['chat', 'generate_content', 'analyze_data']
      },
      {
        id: 'claude-3-5-haiku-20241022',
        name: 'Claude 3.5 Haiku',
        context_window: 200000,
        max_output: 8192,
        tier: 'fast',
        description: '快速响应小模型',
        best_for: ['chat', 'reply_message']
      }
    ]
  },
  {
    id: 'qwen',
    name: '通义千问',
    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    env_key: 'QWEN_API_KEY',
    env_base: 'QWEN_BASE_URL',
    env_model: 'QWEN_MODEL',
    description: '阿里云 · 通义千问（OpenAI 兼容模式）',
    default_model: 'qwen-plus',
    recommended_for: ['chat', 'generate_content'],
    models: [
      {
        id: 'qwen-plus',
        name: 'Qwen Plus',
        context_window: 128000,
        max_output: 8192,
        tier: 'flagship',
        description: '通用主力',
        best_for: ['chat', 'generate_content']
      },
      {
        id: 'qwen-turbo',
        name: 'Qwen Turbo',
        context_window: 1000000,
        max_output: 8192,
        tier: 'fast',
        description: '超长上下文 · 快速',
        best_for: ['chat', 'reply_message', 'query_info']
      },
      {
        id: 'qwen-max',
        name: 'Qwen Max',
        context_window: 32000,
        max_output: 8192,
        tier: 'flagship',
        description: '最强大模型',
        best_for: ['multi_step', 'analyze_data', 'generate_content']
      }
    ]
  },
  {
    id: 'zhipu',
    name: '智谱 AI',
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    env_key: 'ZHIPU_API_KEY',
    env_base: 'ZHIPU_BASE_URL',
    env_model: 'ZHIPU_MODEL',
    description: '智谱 GLM 系列（OpenAI 兼容）',
    default_model: 'glm-4-plus',
    recommended_for: ['chat', 'generate_content'],
    models: [
      {
        id: 'glm-4-plus',
        name: 'GLM-4 Plus',
        context_window: 128000,
        max_output: 8192,
        tier: 'flagship',
        description: '主力大模型',
        best_for: ['chat', 'generate_content', 'analyze_data']
      },
      {
        id: 'glm-4-flash',
        name: 'GLM-4 Flash',
        context_window: 128000,
        max_output: 8192,
        tier: 'fast',
        description: '免费快速',
        best_for: ['chat', 'reply_message']
      }
    ]
  },
  {
    id: 'moonshot',
    name: '月之暗面',
    base_url: 'https://api.moonshot.cn/v1',
    env_key: 'MOONSHOT_API_KEY',
    env_base: 'MOONSHOT_BASE_URL',
    env_model: 'MOONSHOT_MODEL',
    description: 'Moonshot Kimi（长上下文优势）',
    default_model: 'moonshot-v1-128k',
    recommended_for: ['chat', 'analyze_data', 'query_info'],
    models: [
      {
        id: 'moonshot-v1-8k',
        name: 'Kimi v1 8K',
        context_window: 8000,
        max_output: 4096,
        tier: 'fast',
        description: '短上下文快速',
        best_for: ['chat', 'reply_message']
      },
      {
        id: 'moonshot-v1-32k',
        name: 'Kimi v1 32K',
        context_window: 32000,
        max_output: 4096,
        tier: 'flagship',
        description: '中等长度',
        best_for: ['chat', 'generate_content']
      },
      {
        id: 'moonshot-v1-128k',
        name: 'Kimi v1 128K',
        context_window: 128000,
        max_output: 4096,
        tier: 'flagship',
        description: '长文档分析专用',
        best_for: ['analyze_data', 'query_info']
      }
    ]
  },
  {
    id: 'ollama',
    name: 'Ollama（本地）',
    base_url: 'http://localhost:11434/v1',
    env_key: '', // 本地无 API key
    env_base: 'OLLAMA_BASE_URL',
    env_model: 'OLLAMA_MODEL',
    description: '本地部署的 Ollama 模型（无需 API key）',
    default_model: 'qwen2.5:7b',
    recommended_for: ['chat', 'reply_message', 'generate_content'],
    models: [
      {
        id: 'qwen2.5:7b',
        name: 'Qwen 2.5 7B (本地)',
        context_window: 32000,
        max_output: 4096,
        tier: 'local',
        description: '本地 7B 量化模型',
        best_for: ['chat', 'reply_message']
      },
      {
        id: 'llama3.1:8b',
        name: 'Llama 3.1 8B (本地)',
        context_window: 32000,
        max_output: 4096,
        tier: 'local',
        description: '本地 8B 通用模型',
        best_for: ['chat', 'generate_content']
      },
      {
        id: 'deepseek-r1:8b',
        name: 'DeepSeek R1 8B (本地)',
        context_window: 32000,
        max_output: 4096,
        tier: 'local',
        description: '本地推理模型',
        best_for: ['analyze_data']
      }
    ]
  },
  {
    id: 'mock',
    name: 'Mock（测试用）',
    base_url: 'mock://local',
    env_key: '',
    env_base: '',
    env_model: '',
    description: '内置 Mock 模型，返回固定示例（无需配置 key）',
    default_model: 'mock-fast',
    recommended_for: [
      'chat',
      'reply_message',
      'query_info',
      'generate_content',
      'multi_step',
      'analyze_data',
      'execute_command'
    ],
    models: [
      {
        id: 'mock-fast',
        name: 'Mock 快速响应',
        context_window: 8000,
        max_output: 1024,
        tier: 'fast',
        description: '演示/Smoke test 用，~50ms 响应',
        best_for: ['chat', 'reply_message']
      },
      {
        id: 'mock-echo',
        name: 'Mock Echo（回显）',
        context_window: 8000,
        max_output: 1024,
        tier: 'fast',
        description: '原样回显输入，便于调试',
        best_for: ['chat', 'reply_message']
      }
    ]
  }
];

const CONFIG_FILE = path.join(DATA_DIR, 'models-config.json');

// v5.5.6: 自定义 provider API key 加密（AES-256-GCM）
function getDataKey(): Buffer {
  // 使用 JWT secret 派生 32 字节加密密钥；产品化后建议单独 AIBRIDGE_DATA_KEY
  const secret = loadOrCreateSecret();
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptApiKey(plain: string): string {
  if (!plain) return plain;
  if (plain.startsWith('enc:')) return plain;
  const key = getDataKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return 'enc:' + Buffer.concat([iv, authTag, enc]).toString('base64');
}

function decryptApiKey(encrypted: string): string {
  if (!encrypted || !encrypted.startsWith('enc:')) return encrypted;
  const data = Buffer.from(encrypted.slice(4), 'base64');
  if (data.length < 32) return '';
  const iv = data.slice(0, 16);
  const authTag = data.slice(16, 32);
  const enc = data.slice(32);
  const key = getDataKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf-8');
}

function maskApiKey(key: string): string {
  if (!key) return '';
  return `${key.slice(0, 6)}…(len=${key.length})`;
}

class ModelsConfigManager {
  private config: ModelsConfig;

  constructor() {
    this.config = this.load();
  }

  private load(): ModelsConfig {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      if (fs.existsSync(CONFIG_FILE)) {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        // v5.4.2: 合并时保留 task_routing 字段；v5.5.4: 保留 custom_providers/kb 字段
        const customProviders = Array.isArray(parsed.custom_providers)
          ? parsed.custom_providers.map((c: CustomProvider) => ({
              ...c,
              api_key: decryptApiKey(c.api_key)
            }))
          : [];
        return {
          ...DEFAULT_MODELS_CONFIG,
          ...parsed,
          task_routing: { ...DEFAULT_MODELS_CONFIG.task_routing, ...(parsed.task_routing || {}) },
          custom_providers: customProviders
        };
      } else {
        const initial = { ...DEFAULT_MODELS_CONFIG };
        this.saveFile(initial);
        return initial;
      }
    } catch (e) {
      console.error('[models] 配置加载失败，使用默认值:', e);
      return { ...DEFAULT_MODELS_CONFIG };
    }
  }

  private saveFile(c: ModelsConfig): void {
    try {
      const toSave = {
        ...c,
        custom_providers: (c.custom_providers || []).map((p: CustomProvider) => ({
          ...p,
          api_key: encryptApiKey(p.api_key)
        }))
      };
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(toSave, null, 2), 'utf-8');
    } catch (e) {
      console.error('[models] 保存失败:', e);
    }
  }

  get(): ModelsConfig {
    return { ...this.config };
  }

  update(patch: Partial<ModelsConfig>): ModelsConfig {
    this.config = { ...this.config, ...patch };
    this.saveFile(this.config);
    return this.get();
  }

  /**
   * 返回所有 provider（静态 + 自定义），自定义 provider 标记 is_custom=true
   */
  allProviders(): ModelProvider[] {
    const customs: ModelProvider[] = (this.config.custom_providers || []).map(
      (c) =>
        ({
          id: c.id,
          name: c.name,
          base_url: c.base_url,
          env_key: '',
          env_base: '',
          env_model: '',
          models: c.models,
          default_model: c.default_model,
          description: c.description,
          is_custom: true
        }) as ModelProvider
    );
    return [...MODEL_PROVIDERS, ...customs];
  }

  /**
   * 返回给前端的目录数据：
   *   providers —— 完整 provider 列表（含模型，自定义 provider 的 api_key 被遮罩）
   *   config    —— 当前用户配置
   *   secrets   —— 每个 provider 的 env 变量名是否已配置（只遮罩、不返回值）
   *   task_types —— 所有可用 task_type 列表（供前端路由编辑器使用）
   */
  catalog(): {
    providers: ModelProvider[];
    config: ModelsConfig;
    secrets: Record<
      string,
      {
        api_key_configured: boolean;
        api_key_masked?: string;
        base_url?: string;
        model?: string;
      }
    >;
    task_types: TaskType[];
  } {
    const env = this.loadSecrets();
    const secrets: Record<string, any> = {};
    for (const p of MODEL_PROVIDERS) {
      const k = p.env_key ? env[p.env_key] : '';
      const baseOverride = p.env_base ? env[p.env_base] : '';
      const modelOverride = p.env_model ? env[p.env_model] : '';
      secrets[p.id] = {
        api_key_configured: !!k,
        api_key_masked: k ? `${k.slice(0, 6)}…(len=${k.length})` : '',
        base_url: baseOverride || p.base_url,
        model: modelOverride || ''
      };
    }
    // 自定义 provider 的密钥状态：只要有 api_key 即认为已配置，并遮罩返回
    for (const c of this.config.custom_providers || []) {
      secrets[c.id] = {
        api_key_configured: !!c.api_key,
        api_key_masked: maskApiKey(c.api_key),
        base_url: c.base_url
      };
    }
    return {
      providers: this.allProviders(),
      config: this.get(),
      secrets,
      task_types: [
        'chat',
        'reply_message',
        'query_info',
        'analyze_data',
        'execute_command',
        'generate_content',
        'multi_step'
      ]
    };
  }

  /**
   * v5.4.2: 根据 task_type 解析实际使用的 provider + model
   * 优先级：task_routing[task_type] > provider_overrides[provider].default_model > default_provider/default_model
   * v5.5.4: 支持自定义 provider
   */
  resolve(taskType: TaskType): { provider: string; model: string; source: 'routing' | 'override' | 'default' } {
    const cfg = this.config;
    const providers = this.allProviders();
    // 1) 任务路由
    const routed = cfg.task_routing[taskType];
    if (routed && cfg.enabled_providers.includes(routed.provider)) {
      const p = providers.find((p) => p.id === routed.provider);
      if (p && p.models.some((m) => m.id === routed.model)) {
        return { provider: routed.provider, model: routed.model, source: 'routing' };
      }
    }
    // 2) provider override
    const overrideModel = cfg.provider_overrides[cfg.default_provider]?.default_model;
    if (overrideModel && cfg.enabled_providers.includes(cfg.default_provider)) {
      const p = providers.find((p) => p.id === cfg.default_provider);
      if (p && p.models.some((m) => m.id === overrideModel)) {
        return { provider: cfg.default_provider, model: overrideModel, source: 'override' };
      }
    }
    // 3) 全局默认
    return { provider: cfg.default_provider, model: cfg.default_model, source: 'default' };
  }

  /**
   * v5.5.4: 解析知识库模型
   */
  resolveKB(): { provider: string; model: string } | null {
    const cfg = this.config;
    if (!cfg.kb_provider || !cfg.kb_model) return null;
    const providers = this.allProviders();
    const p = providers.find((p) => p.id === cfg.kb_provider);
    if (!p || !cfg.enabled_providers.includes(cfg.kb_provider)) return null;
    if (!p.models.some((m) => m.id === cfg.kb_model)) return null;
    return { provider: cfg.kb_provider, model: cfg.kb_model };
  }

  /** 读取 ~/.config/agent-canvas/secrets.env，仅返回关心的变量 */
  private loadSecrets(): Record<string, string> {
    const out: Record<string, string> = {};
    if (!fs.existsSync(SECRETS_FILE)) return out;
    try {
      const content = fs.readFileSync(SECRETS_FILE, 'utf-8');
      for (const line of content.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq < 0) continue;
        const k = t.slice(0, eq).trim();
        const v = t
          .slice(eq + 1)
          .trim()
          .replace(/^['"]|['"]$/g, '');
        out[k] = v;
      }
    } catch (e) {
      console.warn('[models] 读 secrets.env 失败:', e);
    }
    return out;
  }

  /**
   * v5.5.4: 获取指定 provider 的有效 API key
   * - 内置 provider 从 secrets.env 读取 env_key 变量
   * - 自定义 provider 从 models-config.json 的 custom_providers.api_key 读取
   */
  getApiKey(providerId: string): string | undefined {
    const p = MODEL_PROVIDERS.find((p) => p.id === providerId);
    if (p) {
      if (!p.env_key) return undefined;
      const env = this.loadSecrets();
      return env[p.env_key];
    }
    const custom = (this.config.custom_providers || []).find((c) => c.id === providerId);
    return custom?.api_key;
  }

  /**
   * v5.5.6: 更新自定义 provider 时，如果 api_key 是遮罩则保持原值
   */
  normalizeCustomProviderInput(input: CustomProvider): CustomProvider {
    const existing = (this.config.custom_providers || []).find((c) => c.id === input.id);
    if (existing && input.api_key === maskApiKey(existing.api_key)) {
      return { ...input, api_key: existing.api_key };
    }
    return input;
  }

  /**
   * v5.5.4: 获取指定 provider 的有效 base_url
   */
  getBaseUrl(providerId: string): string | undefined {
    const p = MODEL_PROVIDERS.find((p) => p.id === providerId);
    if (p) {
      if (!p.env_base) return p.base_url;
      const env = this.loadSecrets();
      return env[p.env_base] || p.base_url;
    }
    const custom = (this.config.custom_providers || []).find((c) => c.id === providerId);
    return custom?.base_url;
  }
}

export const modelsConfig = new ModelsConfigManager();
