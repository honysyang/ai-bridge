/**
 * KB Chunk Store — 知识库片段持久化层
 *
 * 与 KBStore 同架构：append-only JSONL 事件流 + 内存 Map
 *   data/kb_chunks.jsonl 每行是 KBChunkOp：
 *     { op: 'create', chunk: KBChunk }
 *     { op: 'update', id: string, patch: Partial<KBChunk>, ts: number }
 *     { op: 'delete', id: string, ts: number }
 *     { op: 'delete_by_item', item_id: string, ts: number }
 */

import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from './lib/paths.js';
import { EventEmitter } from 'events';
import { KBChunk } from './kb-chunk-types.js';

const CHUNKS_FILE = path.join(DATA_DIR, 'kb_chunks.jsonl');

export type KBChunkOp =
  | { op: 'create'; chunk: KBChunk }
  | { op: 'update'; id: string; patch: Partial<KBChunk>; ts: number }
  | { op: 'delete'; id: string; ts: number }
  | { op: 'delete_by_item'; item_id: string; ts: number };

export class KBChunkStore extends EventEmitter {
  private chunks: Map<string, KBChunk> = new Map();
  private byItem: Map<string, Set<string>> = new Map();
  private idCounter: number = 0;

  private writeQueue: Promise<void> = Promise.resolve();
  private writeErrors: number = 0;

  constructor() {
    super();
    this.ensureDataDir();
  }

  private ensureDataDir(): void {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  /**
   * 从 JSONL 重建内存状态
   */
  loadAll(): { chunks: number; corrupted: number; seeded: boolean } {
    if (!fs.existsSync(CHUNKS_FILE)) {
      return { chunks: 0, corrupted: 0, seeded: false };
    }

    const lines = fs
      .readFileSync(CHUNKS_FILE, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    let corrupted = 0;
    for (const line of lines) {
      try {
        const op: KBChunkOp = JSON.parse(line);
        this.applyOp(op);
      } catch {
        corrupted++;
      }
    }
    return { chunks: this.chunks.size, corrupted, seeded: false };
  }

  private applyOp(op: KBChunkOp): void {
    switch (op.op) {
      case 'create': {
        this.chunks.set(op.chunk.id, op.chunk);
        this.addToIndex(op.chunk.item_id, op.chunk.id);
        break;
      }
      case 'update': {
        const cur = this.chunks.get(op.id);
        if (cur) {
          const next = { ...cur, ...op.patch } as KBChunk;
          this.chunks.set(op.id, next);
        }
        break;
      }
      case 'delete': {
        const cur = this.chunks.get(op.id);
        if (cur) {
          this.removeFromIndex(cur.item_id, op.id);
          this.chunks.delete(op.id);
        }
        break;
      }
      case 'delete_by_item': {
        const ids = this.byItem.get(op.item_id);
        if (ids) {
          for (const id of Array.from(ids)) {
            this.chunks.delete(id);
          }
          this.byItem.delete(op.item_id);
        }
        break;
      }
    }
  }

  private addToIndex(itemId: string, chunkId: string): void {
    if (!this.byItem.has(itemId)) {
      this.byItem.set(itemId, new Set());
    }
    this.byItem.get(itemId)!.add(chunkId);
  }

  private removeFromIndex(itemId: string, chunkId: string): void {
    const set = this.byItem.get(itemId);
    if (set) {
      set.delete(chunkId);
      if (set.size === 0) this.byItem.delete(itemId);
    }
  }

  // ======== Queries ========

  list(): KBChunk[] {
    return Array.from(this.chunks.values()).sort((a, b) => a.created_at - b.created_at);
  }

  get(id: string): KBChunk | undefined {
    return this.chunks.get(id);
  }

  getForItem(itemId: string): KBChunk[] {
    const ids = this.byItem.get(itemId);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this.chunks.get(id)!)
      .filter(Boolean)
      .sort((a, b) => a.chunk_index - b.chunk_index);
  }

  countForItem(itemId: string): number {
    return this.byItem.get(itemId)?.size || 0;
  }

  // ======== Mutations ========

  create(chunk: KBChunk): KBChunk {
    this.chunks.set(chunk.id, chunk);
    this.addToIndex(chunk.item_id, chunk.id);
    this.appendOp({ op: 'create', chunk });
    this.emit('chunk_created', chunk);
    return chunk;
  }

  createMany(itemId: string, chunks: Omit<KBChunk, 'id' | 'item_id' | 'created_at'>[]): KBChunk[] {
    const now = Date.now();
    const created: KBChunk[] = [];
    for (let i = 0; i < chunks.length; i++) {
      this.idCounter++;
      const chunk: KBChunk = {
        ...chunks[i],
        id: `kb-chunk-${now}-${this.idCounter}`,
        item_id: itemId,
        chunk_index: chunks[i].chunk_index ?? i,
        created_at: now
      };
      this.create(chunk);
      created.push(chunk);
    }
    return created;
  }

  update(id: string, patch: Partial<KBChunk>): KBChunk | null {
    const cur = this.chunks.get(id);
    if (!cur) return null;
    const ts = Date.now();
    const next = { ...cur, ...patch } as KBChunk;
    this.appendOp({ op: 'update', id, patch, ts });
    this.chunks.set(id, next);
    this.emit('chunk_updated', next);
    return next;
  }

  updateEmbeddings(
    itemId: string,
    embeddings: { chunkId?: string; index?: number; embedding: number[]; model: string }[]
  ): number {
    const chunks = this.getForItem(itemId);
    let updated = 0;
    for (const e of embeddings) {
      const chunk = e.chunkId ? chunks.find((c) => c.id === e.chunkId) : chunks.find((c) => c.chunk_index === e.index);
      if (chunk) {
        this.update(chunk.id, { embedding: e.embedding, embedding_model: e.model });
        updated++;
      }
    }
    return updated;
  }

  delete(id: string): boolean {
    const cur = this.chunks.get(id);
    if (!cur) return false;
    const ts = Date.now();
    this.appendOp({ op: 'delete', id, ts });
    this.removeFromIndex(cur.item_id, id);
    this.chunks.delete(id);
    this.emit('chunk_deleted', { id });
    return true;
  }

  deleteByItem(itemId: string): number {
    const ids = this.byItem.get(itemId);
    if (!ids || ids.size === 0) return 0;
    const count = ids.size;
    const ts = Date.now();
    this.appendOp({ op: 'delete_by_item', item_id: itemId, ts });
    for (const id of Array.from(ids)) {
      this.chunks.delete(id);
    }
    this.byItem.delete(itemId);
    this.emit('chunks_deleted_by_item', { item_id: itemId, count });
    return count;
  }

  // ======== Internals ========

  private appendOp(op: KBChunkOp): void {
    const line = JSON.stringify(op) + '\n';
    this.writeQueue = this.writeQueue
      .then(() => this.doWrite(line))
      .catch((err) => {
        this.writeErrors++;
        console.error('[KBChunkStore] write failed:', err);
      });
  }

  private async doWrite(line: string): Promise<void> {
    await fs.promises.appendFile(CHUNKS_FILE, line, 'utf-8');
  }
}

export const kbChunkStore = new KBChunkStore();
