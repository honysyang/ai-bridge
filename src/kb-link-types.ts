/**
 * 知识库关联（KBLink）类型定义
 *
 * 用于在「知识图谱」视图中表示条目之间的有向关系。
 * 数据形态：append-only JSONL 事件流（与 kb-store / session-store 同架构）
 *
 * 关系类型（type）：
 *   - related  : 相关（默认，最常用）
 *   - depends_on : 依赖（A 依赖 B 才能完成）
 *   - references : 引用（A 引用了 B 的内容）
 *   - contains   : 包含（A 包含 B，A 通常是更上位的概念）
 *
 * 删除条目时应级联删除相关关联（在 kb-link-store 中实现）。
 */

export type KBLinkType = 'related' | 'depends_on' | 'references' | 'contains';

export const KB_LINK_TYPE_META: Record<KBLinkType, { label: string; color: string; arrow: boolean; dashed: boolean }> = {
  related:     { label: '相关',     color: '#64748b', arrow: true,  dashed: false },
  depends_on:  { label: '依赖',     color: '#ef4444', arrow: true,  dashed: false },
  references:  { label: '引用',     color: '#3b82f6', arrow: true,  dashed: true  },
  contains:    { label: '包含',     color: '#8b5cf6', arrow: true,  dashed: false }
};

export interface KBLink {
  id: string;                  // kb-link-<ts>-<n>
  source_id: string;           // 引用 KBItem.id
  target_id: string;           // 引用 KBItem.id
  type: KBLinkType;            // 关系类型
  label?: string;              // 可选标注（0-32 字符）
  created_at: number;
}

/** API DTO */
export interface KBCreateLinkReq {
  source_id: string;
  target_id: string;
  type?: KBLinkType;           // 默认 'related'
  label?: string;
}

export interface KBListLinksResponse {
  links: KBLink[];
  total: number;
}
