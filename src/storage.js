import fs from 'node:fs';
import path from 'node:path';

/**
 * JSONL append-only 存储 + 内存索引。
 * 每行一个事件：{...obj} 插入；{_op:'u', id, patch, at} 更新；{_op:'d', id, at} 删除。
 * 启动时回放合并。
 */
class Collection {
  constructor(name, file) {
    this.name = name;
    this.file = file;
    this.map = new Map(); // id -> obj
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try { this._apply(JSON.parse(line)); } catch { /* 跳过坏行 */ }
      }
    }
  }

  _apply(row) {
    if (row._op === 'u') {
      const cur = this.map.get(row.id);
      if (cur) this.map.set(row.id, { ...cur, ...row.patch });
    } else if (row._op === 'd') {
      this.map.delete(row.id);
    } else if (row && row.id) {
      this.map.set(row.id, row);
    }
  }

  _append(row) {
    fs.appendFileSync(this.file, JSON.stringify(row) + '\n');
  }

  all() { return [...this.map.values()]; }
  find(fn) { return this.all().find(fn); }
  filter(fn) { return this.all().filter(fn); }
  get(id) { return this.map.get(id); }
  count() { return this.map.size; }

  insert(obj) {
    this._append(obj);
    this.map.set(obj.id, obj);
    return obj;
  }

  update(id, patch) {
    const cur = this.map.get(id);
    if (!cur) return null;
    const row = { _op: 'u', id, patch, at: Math.floor(Date.now() / 1000) };
    this._append(row);
    const next = { ...cur, ...patch };
    this.map.set(id, next);
    return next;
  }

  remove(id) {
    this._append({ _op: 'd', id, at: Math.floor(Date.now() / 1000) });
    return this.map.delete(id);
  }
}

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.collections = new Map();
    this.settingsFile = path.join(dataDir, 'settings.json');
    this.settings = fs.existsSync(this.settingsFile)
      ? JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'))
      : {};
  }

  coll(name) {
    if (!this.collections.has(name)) {
      this.collections.set(name, new Collection(name, path.join(this.dataDir, `${name}.jsonl`)));
    }
    return this.collections.get(name);
  }

  getSetting(key, defaultVal = null) {
    return key in this.settings ? this.settings[key] : defaultVal;
  }

  setSetting(key, val) {
    this.settings[key] = val;
    fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2));
    return val;
  }

  log(level, source, message) {
    const logs = this.coll('logs');
    const entry = { id: `log-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`, level, source, message, at: Math.floor(Date.now() / 1000) };
    logs.insert(entry);
    // 内存窗口：保留最近 500 条
    const all = logs.all().sort((a, b) => a.at - b.at);
    if (all.length > 500) for (const e of all.slice(0, all.length - 500)) logs.map.delete(e.id);
    return entry;
  }
}

export async function loadAll(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  return new Store(dataDir);
}
