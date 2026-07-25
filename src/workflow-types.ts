/**
 * Workflow（工作流）类型定义
 *
 * 数据形态：append-only JSONL 事件流（与 storage.ts / kb-store.ts 同架构）
 *
 * 一个 Workflow = 一组有序步骤（WorkflowStep[]），每步是一个待执行 task。
 * 执行时按步骤顺序批量创建 task，可设置依赖（depends_on）。
 */

export type WorkflowStep = {
  id: string; // 步骤内 id（与 task id 无关）
  name: string; // 步骤名
  content: string; // 步骤内容（作为 task.data.content）
  task_type?: 'chat' | 'reply_message' | 'query_info' | 'analyze_data' | 'generate_content' | 'multi_step' | 'custom';
  priority?: 'urgent' | 'high' | 'normal' | 'low';
  depends_on?: string[]; // 依赖步骤的 id 列表
};

export interface Workflow {
  id: string; // wf-<ts>-<n>
  name: string; // 1-64 字符
  icon: string; // 1-2 字符 emoji
  description: string; // 0-200 字符
  steps: WorkflowStep[]; // 至少 1 步
  created_at: number;
  updated_at: number;
  archived?: boolean;
}

/** 一次执行实例（前端用，标识同一 workflow 的多次执行） */
export interface WorkflowExecution {
  workflow_id: string;
  execution_id: string; // wfexec-<ts>-<n>
  started_at: number;
  task_ids: string[]; // 创建的 task ID 列表（按 step 顺序）
}

/** API DTO */
export interface WFCreateReq {
  name: string;
  icon?: string;
  description?: string;
  steps: Omit<WorkflowStep, 'id'>[];
}

export interface WFUpdateReq {
  name?: string;
  icon?: string;
  description?: string;
  steps?: WorkflowStep[];
}

export interface WFExecuteReq {
  session_id?: string; // 归属会话，默认 'sess-default'
}

export interface WFExecuteResp {
  execution_id: string;
  task_ids: string[]; // 顺序：step[0].task_id, step[1].task_id, ...
}
