/**
 * 知识库内置标签池
 *
 * 标签用于跨场景串联知识，以内置为主，用户也可自由输入。
 * 标签语义覆盖学习状态、内容形态、业务主题三个维度。
 */

export interface KBTagDef {
  name: string;
  icon?: string;
  description?: string;
  group: 'state' | 'form' | 'topic';
}

export const BUILTIN_KB_TAGS: KBTagDef[] = [
  // 学习状态
  { name: '可复用', icon: '♻️', description: '可被多次复用的内容', group: 'state' },
  { name: '待读', icon: '📥', description: '待后续阅读', group: 'state' },
  { name: '已读', icon: '✅', description: '已快速浏览', group: 'state' },
  { name: '精读', icon: '🔍', description: '需要精读/复习', group: 'state' },

  // 内容形态
  { name: '流程', icon: '➡️', description: '流程、SOP、步骤', group: 'form' },
  { name: '话术', icon: '💬', description: '对外沟通话术', group: 'form' },
  { name: '模板', icon: '📄', description: '可复用的模板', group: 'form' },
  { name: '规范', icon: '📏', description: '规范、约束、标准', group: 'form' },
  { name: '最佳实践', icon: '⭐', description: '推荐做法', group: 'form' },

  // 业务主题
  { name: '竞品分析', icon: '🎯', description: '竞品调研与分析', group: 'topic' },
  { name: '技术方案', icon: '🛠️', description: '技术设计与方案', group: 'topic' },
  { name: '问题排查', icon: '🐛', description: '问题定位与排查', group: 'topic' },
  { name: '客户案例', icon: '🏢', description: '客户案例与场景', group: 'topic' },
  { name: '行业报告', icon: '📊', description: '行业数据与报告', group: 'topic' }
];

/** 内置标签名称集合，用于前端快速高亮/提示 */
export const BUILTIN_KB_TAG_NAMES = new Set(BUILTIN_KB_TAGS.map((t) => t.name));
