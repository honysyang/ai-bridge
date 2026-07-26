/**
 * 场景（Scenario）类型定义
 *
 * 场景是知识库的顶层组织维度，对应业务角色/职能域：
 *   研发、售前、财务、运维、市场、学习 等。
 */

export interface Scenario {
  id: string; // scenario-<ts>-<n>
  name: string; // 1-32 字符
  icon?: string; // emoji，默认 🏠
  description?: string; // 1-200 字符
  order: number;
  archived?: boolean;
  created_at: number;
  updated_at: number;
}

export interface ScenarioListResponse {
  scenarios: Scenario[];
  total: number;
}
