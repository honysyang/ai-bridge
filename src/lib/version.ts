// ======== 应用版本（v5.5.1 新增） ========
//
// 集中读取 package.json 版本号，避免在多处硬编码。
// 失败时回退到 '0.0.0'，不抛错。

import * as fs from 'fs';
import * as path from 'path';

interface PackageJson {
  name?: string;
  version?: string;
  description?: string;
}

let cached: { version: string; name: string; description: string } | null = null;

function readPackageJson(): { version: string; name: string; description: string } {
  if (cached) return cached;
  try {
    // 优先从 cwd 读（项目根目录）
    const pkgPath = path.join(process.cwd(), 'package.json');
    if (fs.existsSync(pkgPath)) {
      const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as PackageJson;
      cached = {
        version: parsed.version || '0.0.0',
        name: parsed.name || 'ai-bridge',
        description: parsed.description || ''
      };
      return cached;
    }
  } catch {
    // fall through
  }
  cached = { version: '0.0.0', name: 'ai-bridge', description: '' };
  return cached;
}

export function getAppVersion(): string {
  return readPackageJson().version;
}

export function getAppName(): string {
  return readPackageJson().name;
}

export function getAppDescription(): string {
  return readPackageJson().description;
}

export const APP_VERSION = getAppVersion();
