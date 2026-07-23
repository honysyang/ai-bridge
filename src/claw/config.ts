// ======== Claw 配置加载/保存 ========
//
// 配置文件路径: data/claw-config.json
// 启动时加载，运行时可通过 /api/claw/config 热更新
//
// v4.1.0: iLink 凭证统一存到 ~/.config/agent-canvas/secrets.env
//   ILINK_BASE_URL, ILINK_BOT_TOKEN, ILINK_BOT_ID, ILINK_USER_ID, ILINK_NICKNAME, ILINK_GET_UPDATES_BUF

import * as fs from 'fs';
import * as path from 'path';
import { ClawConfig, DEFAULT_CLAW_CONFIG } from './types.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'claw-config.json');

class ClawConfigManager {
  private config: ClawConfig;
  private listeners: Array<(cfg: ClawConfig) => void> = [];

  constructor() {
    this.config = this.load();
  }

  private load(): ClawConfig {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      if (fs.existsSync(CONFIG_FILE)) {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        return { ...DEFAULT_CLAW_CONFIG, ...parsed };
      } else {
        const initial = { ...DEFAULT_CLAW_CONFIG };
        this.save(initial);
        return initial;
      }
    } catch (e) {
      console.error('[claw] 配置加载失败，使用默认值:', e);
      return { ...DEFAULT_CLAW_CONFIG };
    }
  }

  private save(cfg: ClawConfig): void {
    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
    } catch (e) {
      console.error('[claw] 配置保存失败:', e);
    }
  }

  get(): ClawConfig {
    return { ...this.config };
  }

  update(patch: Partial<ClawConfig>): ClawConfig {
    this.config = { ...this.config, ...patch };
    this.save(this.config);
    this.listeners.forEach((fn) => fn(this.config));
    return this.get();
  }

  onChange(fn: (cfg: ClawConfig) => void): void {
    this.listeners.push(fn);
  }
}

export const clawConfig = new ClawConfigManager();
