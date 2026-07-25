/**
 * 提示词库类型定义（v5.6.0）
 *
 * 独立于 KB 的提示词模板存储，支持变量占位符 {{var}}。
 */

export interface PromptCategory {
  id: string;
  type: 'category';
  name: string;
  icon: string;
  order: number;
  created_at: number;
  updated_at: number;
}

export interface PromptTemplate {
  id: string;
  type: 'prompt';
  category_id: string;
  title: string;
  description?: string;
  content: string;
  variables: string[];
  tags: string[];
  archived?: boolean;
  order: number;
  created_at: number;
  updated_at: number;
}

export type PromptEntry = PromptCategory | PromptTemplate;

export interface PromptListResponse {
  categories: PromptCategory[];
  prompts: PromptTemplate[];
  total: number;
}

export interface ApplyPromptResult {
  rendered: string;
  missing: string[];
}
