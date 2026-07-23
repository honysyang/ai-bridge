// ======== Task Types ========

export type TaskType =
  | 'chat'             // 聊天消息（每次对话入队为任务）
  | 'reply_message'
  | 'query_info'
  | 'analyze_data'
  | 'execute_command'
  | 'generate_content'
  | 'multi_step';

export type TaskSource = 'manual' | 'chat' | 'wechat' | 'scheduled' | 'system';

export type TaskStatus = 'pending' | 'assigned' | 'processing' | 'completed' | 'failed';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';
export type TaskResultStatus = 'success' | 'failed' | 'partial';

export interface TaskData {
  from_user?: string;
  content: string;
  extra?: any;
}

export interface Task {
  id: string;
  session_id?: string;        // v3.0.0: 归属会话（可选，缺省走 default 会话）
  type: TaskType;
  priority: TaskPriority;
  source: TaskSource;
  data: TaskData;
  context?: any;
  created_at: number;
  status: TaskStatus;
  assigned_to?: string;
  started_at?: number;     // 转为 processing 的时间
  completed_at?: number;   // 提交结果的时间
  result?: TaskResult;
}

// ======== Evidence (执行依据) ========

export interface ExecutedCommand {
  cmd: string;
  output_summary: string;
  at: number;
}

export interface ReadFile {
  path: string;
  purpose: string;
  at: number;
}

export interface SearchEntry {
  query: string;
  engine: string;
  at: number;
}

export interface ToolCall {
  tool: string;
  args: Record<string, any>;
  result_summary: string;
  at: number;
}

export interface Evidence {
  executed_commands: ExecutedCommand[];
  read_files: ReadFile[];
  searches: SearchEntry[];
  tool_calls: ToolCall[];
  thinking: string;
}

export const EMPTY_EVIDENCE: Evidence = {
  executed_commands: [],
  read_files: [],
  searches: [],
  tool_calls: [],
  thinking: ''
};

// ======== Task Result ========

export interface TaskResult {
  task_id: string;
  status: TaskResultStatus;
  result: {
    action: string;
    summary: string;
    details?: string;
    [key: string]: any;
  };
  evidence?: Evidence;
  context_summary: AgentContext;
  completed_at: number;
}

// ======== Agent Context ========

export interface AgentContext {
  session_id: string;
  active_conversations: ConversationContext[];
  global_state: {
    current_focus: string;
    scheduled_tasks: string[];
    alerts: string[];
  };
}

export interface ConversationContext {
  user_id: string;
  last_active: number;
  topic: string;
  pending_items: string[];
  memory: string[];
}

// ======== Bridge Response ========

export interface BridgeResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  meta?: {
    unread_count?: number;
    total_count?: number;
    queue_stats?: QueueStats;
  };
}

export interface QueueStats {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  total: number;
}

// ======== Heartbeat ========

export interface AgentInfo {
  agent_id: string;
  last_heartbeat: number;
  first_seen: number;
}

export interface HeartbeatResponse {
  server_time: number;
  agent_online: boolean;
  has_urgent_task: boolean;
  queue_stats: QueueStats;
  pending_count: number;
  processing_count: number;
}

// ======== Session (v3.0.0) ========

export type SessionStatus = 'active' | 'archived';

export interface Session {
  id: string;                     // sess-{ts}-{counter}
  name: string;                   // 用户命名
  description?: string;           // 可选备注
  created_at: number;
  updated_at: number;             // 任意变更时更新
  task_count: number;             // 缓存，避免每次 count
  last_task_summary?: string;     // 最近一条任务内容（用于会话列表预览）
  status: SessionStatus;          // 归档后不出现在默认列表
  meta?: Record<string, any>;     // 用户自定义标签
}

// ======== System Log ========

export type LogLevel = 'info' | 'warn' | 'error' | 'debug' | 'success';
export type LogSource = 'server' | 'bridge' | 'task' | 'agent' | 'system' | 'kb';

export interface LogEntry {
  id: string;
  level: LogLevel;
  source: LogSource;
  message: string;
  meta?: Record<string, any>;
  created_at: number;
}
