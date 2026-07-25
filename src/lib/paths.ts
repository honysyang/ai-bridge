// ======== 路径配置（v5.5.6 产品化）========
//
// 统一管理系统中所有文件路径，支持通过环境变量自定义。
//
// 环境变量：
//   - AIBRIDGE_DATA_DIR   : JSONL / SQLite / 设置文件存放目录（默认 process.cwd()/data）
//   - AIBRIDGE_LOGS_DIR   : winston 日志目录（默认 process.cwd()/logs）
//   - AIBRIDGE_SECRETS_DIR: secrets.env 存放目录（默认 ~/.config/agent-canvas）

import * as path from 'path';
import * as os from 'os';

function resolveDir(envName: string, defaultPath: string): string {
  const fromEnv = process.env[envName];
  const raw = fromEnv || defaultPath;
  const expanded = raw.replace(/^~/, os.homedir());
  return path.resolve(expanded);
}

export const DATA_DIR = resolveDir('AIBRIDGE_DATA_DIR', path.join(process.cwd(), 'data'));
export const LOGS_DIR = resolveDir('AIBRIDGE_LOGS_DIR', path.join(process.cwd(), 'logs'));
export const SECRETS_DIR = resolveDir('AIBRIDGE_SECRETS_DIR', path.join(os.homedir(), '.config', 'agent-canvas'));
export const SECRETS_FILE = path.join(SECRETS_DIR, 'secrets.env');
