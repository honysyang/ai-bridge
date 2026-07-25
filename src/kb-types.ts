/**
 * 知识库（KB）类型定义
 *
 * 数据形态：append-only JSONL 事件流（与 storage.ts / session.ts 同架构）
 * 两种事件：
 *   - category 事件：表示一个分类容器（可展开/收起）
 *   - item     事件：表示一个具体知识条目（点击填入聊天输入框）
 *
 * 删分类不会删其下条目（条目 category_id 保持但被前端视为「未分类」）
 */

export type KBEntryType = 'category' | 'item';

/** 分类事件 payload（不变量：name 必填） */
export interface KBCategory {
  id: string; // kb-cat-<ts>-<n>
  type: 'category';
  name: string; // 1-32 字符
  icon?: string; // emoji，默认 📁
  order: number; // 同一时间窗内插入顺序（小→前）
  archived?: boolean;
  created_at: number;
  updated_at: number;
}

/** 条目事件 payload */
export interface KBItem {
  id: string; // kb-item-<ts>-<n>
  type: 'item';
  category_id: string; // 引用 KBCategory.id
  title: string; // 1-64 字符
  body: string; // 1-4000 字符（填入输入框时作为 content）
  tags: string[]; // 0-8 个 tag
  order: number;
  archived?: boolean;
  created_at: number;
  updated_at: number;
}

/** 联合类型 */
export type KBEntry = KBCategory | KBItem;

/** API 请求/响应 DTO */
export interface KBCreateCategoryReq {
  name: string;
  icon?: string;
}

export interface KBUpdateCategoryReq {
  name?: string;
  icon?: string;
}

export interface KBCreateItemReq {
  category_id: string;
  title: string;
  body: string;
  tags?: string[];
}

export interface KBUpdateItemReq {
  category_id?: string;
  title?: string;
  body?: string;
  tags?: string[];
}

/** 列表响应：按 order 排好的分类 + 条目 */
export interface KBListResponse {
  categories: KBCategory[];
  items: KBItem[];
  total: number;
}
