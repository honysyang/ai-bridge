// ======== AI 模型配置（v5.3.0）========
//
// 设计原则：
//   1. 模型定义（provider / base_url / supported_models）在代码里静态声明（schema）
//   2. 凭证（API key 等敏感字段）从 ~/.config/agent-canvas/secrets.env 读取（只读遮罩）
//   3. 用户选择（默认模型、各 provider 启用状态）持久化到 data/models-config.json
//
// 为什么不把 API key 存在 models-config.json？
//   避免该文件被误推到 git、误备份、误分享。所有密钥统一在 secrets.env（chmod 600）。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ModelProvider {
  id: string;                       // 'deepseek' / 'openai' / 'mock' 等
  name: string;                     // 显示名
  base_url: string;                 // 兼容 OpenAI Chat Completions 的 base URL
  env_key: string;                  // secrets.env 中的 API key 变量名（如 DEEPSEEK_API_KEY）
  env_base: string;                 // 覆盖 base URL 的 env 变量名
  env_model: string;                // 默认模型名 env 变量名
  models: ModelInfo[];              // 支持的模型列表
  default_model: string;            // 该 provider 的默认模型
  description?: string;
}

export interface ModelInfo {
  id: string;                       // 'deepseek-chat'
  name: string;                     // 显示名
  context_window?: number;          // 上下文窗口（tokens）
  max_output?: number;              // 最大输出（tokens）
  description?: string;
  tier?: 'flagship' | 'fast' | 'reasoning' | 'embedding';
}

export interface ModelsConfig {
  default_provider: string;
  default_model: string;
  enabled_providers: string[];      // 用户启用的 provider 列表
  provider_overrides: Record<string, { default_model?: string }>;
}

export const DEFAULT_MODELS_CONFIG: ModelsConfig = {
  default_provider: 'deepseek',
  default_model: 'deepseek-chat',
  enabled_providers: ['deepseek'],
  provider_overrides: {}
};

/** 静态模型目录（v5.3.0 起步：DeepSeek） */
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
    models: [
      {
        id: 'deepseek-chat',
        name: 'DeepSeek-V3 Chat',
        context_window: 64000,
        max_output: 8192,
        tier: 'flagship',
        description: '通用对话主力模型，640K 上下文'
      },
      {
        id: 'deepseek-reasoner',
        name: 'DeepSeek-R1 Reasoner',
        context_window: 64000,
        max_output: 8192,
        tier: 'reasoning',
        description: '深度推理模型，适合复杂任务'
      }
    ]
  }
];

const DATA_DIR = path.join(process.cwd(), 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'models-config.json');
const SECRETS_FILE = path.join(os.homedir(), '.config', 'agent-canvas', 'secrets.env');

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
        return { ...DEFAULT_MODELS_CONFIG, ...parsed };
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
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2), 'utf-8');
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
   * 返回给前端的目录数据：
   *   providers —— 完整 provider 列表（含模型）
   *   config    —— 当前用户配置
   *   secrets   —— 每个 provider 的 env 变量名是否已配置（只遮罩、不返回值）
   */
  catalog(): {
    providers: ModelProvider[];
    config: ModelsConfig;
    secrets: Record<string, {
      api_key_configured: boolean;
      api_key_masked?: string;
      base_url?: string;
      model?: string;
    }>;
  } {
    const env = this.loadSecrets();
    const secrets: Record<string, any> = {};
    for (const p of MODEL_PROVIDERS) {
      const k = env[p.env_key];
      const baseOverride = p.env_base ? env[p.env_base] : '';
      const modelOverride = p.env_model ? env[p.env_model] : '';
      secrets[p.id] = {
        api_key_configured: !!k,
        api_key_masked: k ? `${k.slice(0, 6)}…(len=${k.length})` : '',
        base_url: baseOverride || p.base_url,
        model: modelOverride || ''
      };
    }
    return { providers: MODEL_PROVIDERS, config: this.get(), secrets };
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
        const v = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
        out[k] = v;
      }
    } catch (e) {
      console.warn('[models] 读 secrets.env 失败:', e);
    }
    return out;
  }
}

export const modelsConfig = new ModelsConfigManager();
