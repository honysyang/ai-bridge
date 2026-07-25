// ======== 启动时配置校验（v5.5.6 产品化）========
//
// 在服务启动前检查关键配置，避免运行时才报错。

import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR, SECRETS_FILE } from './paths.js';
import { childLogger } from './logger.js';

const log = childLogger({ module: 'config-check' });

export interface ConfigCheckResult {
  ok: boolean;
  warnings: string[];
  errors: string[];
}

export function checkStartupConfig(): ConfigCheckResult {
  const result: ConfigCheckResult = { ok: true, warnings: [], errors: [] };

  // 1. 数据目录可写
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const testFile = `${DATA_DIR}/.write-test-${Date.now()}`;
    fs.writeFileSync(testFile, '', 'utf-8');
    fs.unlinkSync(testFile);
  } catch (e: any) {
    result.errors.push(`数据目录不可写: ${DATA_DIR} (${e.message})`);
  }

  // 2. secrets 目录可写
  try {
    const secretsDir = path.dirname(SECRETS_FILE);
    if (!fs.existsSync(secretsDir)) {
      fs.mkdirSync(secretsDir, { recursive: true });
    }
  } catch (e: any) {
    result.warnings.push(`secrets 目录不可写: ${SECRETS_FILE} (${e.message})`);
  }

  // 3. JWT 密钥
  if (!process.env.AIBRIDGE_JWT_SECRET) {
    result.warnings.push(
      '未设置 AIBRIDGE_JWT_SECRET，将自动生成并写入 secrets.env（重启后若未持久化会导致所有会话失效）'
    );
  }

  // 4. 端口
  const port = parseInt(process.env.PORT || '4567', 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    result.errors.push(`PORT 必须是 1-65535 之间的整数: ${process.env.PORT}`);
  }

  // 5. 信任代理
  const trustProxy = process.env.AIBRIDGE_TRUSTED_PROXIES || 'loopback,linklocal,uniquelocal';
  if (trustProxy === 'true' || trustProxy === '*') {
    result.warnings.push('AIBRIDGE_TRUSTED_PROXIES 设置为信任所有代理，存在认证绕过风险');
  }

  // 6. 本地网络
  const localNetworks = (process.env.AIBRIDGE_LOCAL_NETWORKS || '127.0.0.1,::1')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (localNetworks.some((n) => n === '0.0.0.0/0' || n === '::/0')) {
    result.errors.push('AIBRIDGE_LOCAL_NETWORKS 不能包含 0.0.0.0/0 或 ::/0，否则等同于关闭认证');
  }

  result.ok = result.errors.length === 0;
  return result;
}

export function logConfigCheck(result: ConfigCheckResult): void {
  if (result.warnings.length > 0) {
    for (const w of result.warnings) {
      log.warn(`配置警告: ${w}`);
    }
  }
  if (result.errors.length > 0) {
    for (const e of result.errors) {
      log.error(`配置错误: ${e}`);
    }
  }
  if (result.ok && result.warnings.length === 0) {
    log.info('启动配置校验通过');
  }
}
