// ======== 用户管理（v5.4.0 新增）========
//
// 设计原则：
// 1. 存储：data/users.jsonl（JSONL 追加写，与 sessions/tasks/logs 一致）
// 2. 密码哈希：PBKDF2-SHA256（Node 内置 crypto，无新依赖）
//    - 10w 迭代 + 16字节 salt + 32字节 hash
// 3. 默认管理员：首次启动自动创建，密码写入 secrets.env（chmod 600）
// 4. 微信 wxid → user_id 自动映射（lazy provision，首次收到消息时创建）
// 5. 角色：admin / operator / viewer（admin 拥有全部权限，viewer 只读）
//
// 公共 API：
//   users.create({username, password, role}) → User
//   users.findByUsername(username) → User | null
//   users.findById(id) → User | null
//   users.findByWechatWxid(wxid) → User | null
//   users.provisionWechatUser(wxid, nickname) → User
//   users.verifyPassword(plain, hash) → boolean
//   users.ensureDefaultAdmin() → { username, password }
//
// 存储格式：每行一个 JSON 对象
//   {"id":"u-1","username":"admin","password_hash":"pbkdf2$...","role":"admin",
//    "created_at":1234,"wechat_wxid":null,"display_name":"Administrator"}

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { childLogger } from './logger.js';
import { DATA_DIR, SECRETS_DIR } from './paths.js';

const log = childLogger({ module: 'users' });

const USERS_FILE = path.join(DATA_DIR, 'users.jsonl');

export type UserRole = 'admin' | 'operator' | 'viewer';

export interface User {
  id: string;
  username: string;
  password_hash: string;
  role: UserRole;
  display_name?: string;
  wechat_wxid?: string | null;
  created_at: number;
  last_login_at?: number;
  disabled?: boolean;
}

const PBKDF2_ITER = 100_000;
const PBKDF2_KEYLEN = 32;
const PBKDF2_DIGEST = 'sha256';
const SALT_BYTES = 16;

/**
 * 用 PBKDF2-SHA256 对密码进行哈希
 * 格式：pbkdf2$<iter>$<salt-hex>$<hash-hex>
 */
export function hashPassword(password: string, saltHex?: string, iter = PBKDF2_ITER): string {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(SALT_BYTES);
  const hash = crypto.pbkdf2Sync(password, salt, iter, PBKDF2_KEYLEN, PBKDF2_DIGEST);
  return `pbkdf2$${iter}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/**
 * 验证明文密码 vs 哈希值（constant-time 比较）
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iter = parseInt(parts[1], 10);
  const saltHex = parts[2];
  const expectedHex = parts[3];
  if (!iter || !saltHex || !expectedHex) return false;

  const computed = crypto.pbkdf2Sync(password, Buffer.from(saltHex, 'hex'), iter, PBKDF2_KEYLEN, PBKDF2_DIGEST);
  const expected = Buffer.from(expectedHex, 'hex');
  if (computed.length !== expected.length) return false;
  return crypto.timingSafeEqual(computed, expected);
}

/**
 * 简单的密码强度校验（生产环境可加强）
 */
export function isPasswordStrong(pw: string): { ok: boolean; reason?: string } {
  if (!pw || pw.length < 8) return { ok: false, reason: '密码至少 8 个字符' };
  if (pw.length > 128) return { ok: false, reason: '密码不能超过 128 个字符' };
  if (!/[A-Za-z]/.test(pw)) return { ok: false, reason: '密码必须包含字母' };
  if (!/[0-9]/.test(pw)) return { ok: false, reason: '密码必须包含数字' };
  return { ok: true };
}

/**
 * 生成随机密码（默认管理员使用）
 * 保证至少 1 个字母 + 1 个数字，满足 isPasswordStrong 校验
 */
export function generateRandomPassword(length = 16): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const mixed = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  // 第一个字符：字母；第二个字符：数字；其余随机
  const bytes = crypto.randomBytes(length);
  const chars: string[] = [];
  chars.push(letters[bytes[0] % letters.length]);
  chars.push(digits[bytes[1] % digits.length]);
  for (let i = 2; i < length; i++) {
    chars.push(mixed[bytes[i] % mixed.length]);
  }
  return chars.join('');
}

class UserManager {
  private cache: User[] = [];
  private loaded = false;
  private nextId = 1;

  private ensureLoaded() {
    if (this.loaded) return;
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(USERS_FILE)) {
      const content = fs.readFileSync(USERS_FILE, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      const byId = new Map<string, User>();
      for (const line of lines) {
        try {
          const u = JSON.parse(line) as User;
          // append-only 写入，同 ID 只保留最后一条（最新状态）
          byId.set(u.id, u);
          // 提取最大 ID 数字
          const m = /^u-(\d+)$/.exec(u.id);
          if (m) {
            const n = parseInt(m[1], 10);
            if (n >= this.nextId) this.nextId = n + 1;
          }
        } catch (e) {
          log.warn(`跳过损坏行: ${line.slice(0, 50)}...`);
        }
      }
      this.cache = Array.from(byId.values());
    }
    this.loaded = true;
    log.info(`已加载 ${this.cache.length} 个用户`);
  }

  private persist(u: User) {
    fs.appendFileSync(USERS_FILE, JSON.stringify(u) + '\n', { mode: 0o600 });
  }

  list(): User[] {
    this.ensureLoaded();
    return [...this.cache];
  }

  findById(id: string): User | null {
    this.ensureLoaded();
    return this.cache.find((u) => u.id === id) || null;
  }

  findByUsername(username: string): User | null {
    this.ensureLoaded();
    return this.cache.find((u) => u.username === username) || null;
  }

  findByWechatWxid(wxid: string): User | null {
    this.ensureLoaded();
    if (!wxid) return null;
    return this.cache.find((u) => u.wechat_wxid === wxid) || null;
  }

  /**
   * 重写整个 users.jsonl 文件（用于更新/删除后持久化）
   */
  private rewriteAll() {
    fs.writeFileSync(
      USERS_FILE,
      this.cache.map((u) => JSON.stringify(u)).join('\n') + (this.cache.length ? '\n' : ''),
      { mode: 0o600 }
    );
  }

  /**
   * 更新用户字段（admin 用）
   */
  update(id: string, opts: { role?: UserRole; display_name?: string; disabled?: boolean }): User {
    this.ensureLoaded();
    const u = this.findById(id);
    if (!u) throw new Error('用户不存在');

    if (opts.role !== undefined) u.role = opts.role;
    if (opts.display_name !== undefined) u.display_name = opts.display_name;
    if (opts.disabled !== undefined) u.disabled = opts.disabled;

    this.rewriteAll();
    log.info(`更新用户 ${u.username} (${u.id})`);
    return u;
  }

  /**
   * 更新当前用户密码（原密码验证）
   */
  updatePassword(id: string, opts: { oldPassword: string; newPassword: string }): User {
    this.ensureLoaded();
    const u = this.findById(id);
    if (!u) throw new Error('用户不存在');
    if (!verifyPassword(opts.oldPassword, u.password_hash)) {
      throw new Error('原密码错误');
    }
    const strength = isPasswordStrong(opts.newPassword);
    if (!strength.ok) throw new Error(strength.reason);

    u.password_hash = hashPassword(opts.newPassword);
    this.rewriteAll();
    log.info(`用户 ${u.username} 修改密码`);
    return u;
  }

  /**
   * 管理员重置密码（无需原密码）
   */
  resetPassword(id: string, newPassword?: string): { user: User; password: string } {
    this.ensureLoaded();
    const u = this.findById(id);
    if (!u) throw new Error('用户不存在');
    const password = newPassword || generateRandomPassword(16);
    const strength = isPasswordStrong(password);
    if (!strength.ok) throw new Error(strength.reason);

    u.password_hash = hashPassword(password);
    this.rewriteAll();
    log.info(`管理员重置用户 ${u.username} 密码`);
    return { user: u, password };
  }

  /**
   * 删除用户（admin 用）
   */
  delete(id: string): void {
    this.ensureLoaded();
    const u = this.findById(id);
    if (!u) throw new Error('用户不存在');
    this.cache = this.cache.filter((user) => user.id !== id);
    this.rewriteAll();
    log.info(`删除用户 ${u.username} (${u.id})`);
  }

  /**
   * 创建用户
   */
  create(opts: {
    username: string;
    password: string;
    role?: UserRole;
    display_name?: string;
    wechat_wxid?: string;
  }): User {
    this.ensureLoaded();
    if (!opts.username || !opts.password) throw new Error('用户名和密码不能为空');
    if (this.findByUsername(opts.username)) throw new Error('用户名已存在');
    if (opts.wechat_wxid && this.findByWechatWxid(opts.wechat_wxid)) throw new Error('该微信 ID 已绑定其他用户');

    const strength = isPasswordStrong(opts.password);
    if (!strength.ok) throw new Error(strength.reason);

    const u: User = {
      id: `u-${this.nextId++}`,
      username: opts.username,
      password_hash: hashPassword(opts.password),
      role: opts.role || 'viewer',
      display_name: opts.display_name,
      wechat_wxid: opts.wechat_wxid || null,
      created_at: Date.now()
    };
    this.cache.push(u);
    this.persist(u);
    log.info(`创建用户 ${u.username} (${u.role}, id=${u.id})`);
    return u;
  }

  /**
   * 微信用户 lazy provision：首次收到 wxid 的消息时自动建账号
   */
  provisionWechatUser(wxid: string, nickname?: string): User {
    this.ensureLoaded();
    const existing = this.findByWechatWxid(wxid);
    if (existing) return existing;

    // 用 wxid 的 @ 之前部分作为 username，自动去重
    const baseName =
      (wxid.split('@')[0] || `wx_${Date.now()}`).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 24) || `wx_${Date.now()}`;
    let username = baseName;
    let n = 1;
    while (this.findByUsername(username)) {
      username = `${baseName}_${n++}`;
    }

    // 微信用户初始密码为 32 位随机串（不暴露，用户无需登录）
    const u = this.create({
      username,
      password: generateRandomPassword(32),
      role: 'operator',
      display_name: nickname || username,
      wechat_wxid: wxid
    });
    log.info(`微信用户 lazy provision: wxid=${wxid} → user=${u.username}`);
    return u;
  }

  /**
   * 记录登录时间
   */
  recordLogin(id: string): void {
    const u = this.findById(id);
    if (!u) return;
    u.last_login_at = Date.now();
    // 重新追加一行（JSONL 是 append-only 存储）
    this.persist(u);
  }

  /**
   * 首次启动时确保存在默认 admin
   * 密码写入 ~/.config/agent-canvas/secrets.env（chmod 600）
   */
  ensureDefaultAdmin(): { username: string; password: string; created: boolean } {
    this.ensureLoaded();
    const existing = this.findByUsername('admin');
    if (existing) {
      return { username: 'admin', password: '(已存在，使用旧密码)', created: false };
    }
    const password = generateRandomPassword(16);
    const u = this.create({
      username: 'admin',
      password,
      role: 'admin',
      display_name: 'Administrator'
    });

    // 写入 secrets.env
    try {
      if (!fs.existsSync(SECRETS_DIR)) {
        fs.mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
      }
      const secretsFile = path.join(SECRETS_DIR, 'secrets.env');
      const line = `\n# 默认管理员（首次启动自动创建，${new Date().toISOString()}）\nAIBRIDGE_ADMIN_PASSWORD=${password}\n`;
      fs.appendFileSync(secretsFile, line, { mode: 0o600 });
      log.info(`默认管理员密码已写入 ${secretsFile}（chmod 600）`);
    } catch (e: any) {
      log.warn(`无法写入 secrets.env: ${e.message}，请手动记录密码: ${password}`);
    }
    return { username: u.username, password, created: true };
  }
}

export const users = new UserManager();
