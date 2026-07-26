// ======== 系统设置（v6.0.1）========
//
// 持久化到 data/system-settings.json
// 设计目标：纯本地配置，不存敏感凭证（凭证统一在 ~/.config/agent-canvas/secrets.env）
//
// v6.0.1 产品化精简后，前端仅暴露「任务行为」与「日志」两类设置：
//   tasks —— 默认优先级、失败自动重试、最大重试次数、归档天数
//   logs  —— 日志级别、保留天数
//
// 以下分组保留默认值以兼容旧配置，但不再在前端展示：
//   ui     —— 主题固定为 indigo，动画/密度/语言不再可配置
//   data   —— 自动清理、写入备份由后端逻辑决定
//   bridge —— 心跳/长轮询超时由服务端固定，避免用户误改

import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from './paths.js';

export interface SystemSettings {
  ui: {
    theme: 'indigo';
    density: 'comfortable' | 'compact';
    animations: boolean;
    language: 'zh-CN' | 'en-US';
  };
  logs: {
    level: 'debug' | 'info' | 'warn' | 'error';
    retention_days: number; // 日志保留天数（0 = 永久）
    console_output: boolean; // 是否同时输出到 stdout
  };
  tasks: {
    default_priority: 'low' | 'normal' | 'high' | 'urgent';
    auto_retry_on_failure: boolean;
    max_retries: number;
    archive_after_days: number; // 已完成任务归档天数
  };
  data: {
    auto_cleanup: boolean;
    backup_on_write: boolean; // 每次写入前备份（影响性能）
  };
  bridge: {
    heartbeat_interval_sec: number;
    long_poll_timeout_sec: number;
  };
}

export const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  ui: {
    theme: 'indigo',
    density: 'comfortable',
    animations: true,
    language: 'zh-CN'
  },
  logs: {
    level: 'info',
    retention_days: 30,
    console_output: false
  },
  tasks: {
    default_priority: 'normal',
    auto_retry_on_failure: false,
    max_retries: 2,
    archive_after_days: 7
  },
  data: {
    auto_cleanup: false,
    backup_on_write: false
  },
  bridge: {
    heartbeat_interval_sec: 5,
    long_poll_timeout_sec: 30
  }
};

const SETTINGS_FILE = path.join(DATA_DIR, 'system-settings.json');

class SystemSettingsManager {
  private settings: SystemSettings;
  private listeners: Array<(s: SystemSettings) => void> = [];

  constructor() {
    this.settings = this.load();
  }

  private load(): SystemSettings {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      if (fs.existsSync(SETTINGS_FILE)) {
        const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        return this.mergeDeep({ ...DEFAULT_SYSTEM_SETTINGS }, parsed);
      } else {
        const initial = JSON.parse(JSON.stringify(DEFAULT_SYSTEM_SETTINGS));
        this.saveFile(initial);
        return initial;
      }
    } catch (e) {
      console.error('[settings] 加载失败，使用默认值:', e);
      return JSON.parse(JSON.stringify(DEFAULT_SYSTEM_SETTINGS));
    }
  }

  /**
   * 深度合并：defaults 兜底，parsed 覆盖
   * 保证新增字段时旧配置文件也能兼容
   */
  private mergeDeep(target: any, source: any): any {
    if (source == null || typeof source !== 'object') return target;
    for (const key of Object.keys(source)) {
      const sv = source[key];
      const tv = target[key];
      if (
        sv != null &&
        typeof sv === 'object' &&
        !Array.isArray(sv) &&
        tv != null &&
        typeof tv === 'object' &&
        !Array.isArray(tv)
      ) {
        target[key] = this.mergeDeep(tv, sv);
      } else {
        target[key] = sv;
      }
    }
    return target;
  }

  private saveFile(s: SystemSettings): void {
    try {
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf-8');
    } catch (e) {
      console.error('[settings] 保存失败:', e);
    }
  }

  get(): SystemSettings {
    return JSON.parse(JSON.stringify(this.settings));
  }

  update(patch: Partial<SystemSettings>): SystemSettings {
    this.settings = this.mergeDeep(this.settings, patch || {});
    this.saveFile(this.settings);
    this.listeners.forEach((fn) => fn(this.settings));
    return this.get();
  }

  reset(): SystemSettings {
    this.settings = JSON.parse(JSON.stringify(DEFAULT_SYSTEM_SETTINGS));
    this.saveFile(this.settings);
    this.listeners.forEach((fn) => fn(this.settings));
    return this.get();
  }

  onChange(fn: (s: SystemSettings) => void): void {
    this.listeners.push(fn);
  }
}

export const systemSettings = new SystemSettingsManager();
