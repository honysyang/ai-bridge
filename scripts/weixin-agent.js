#!/usr/bin/env node
// ======== 微信智能体 v2（心跳保活 + 执行依据） ========
//
// 基于 weixin-agent.skill.md 实现：
// - 每 5 秒心跳 GET /api/heartbeat
// - 长轮询 GET /api/task/poll?timeout=30
// - 任务执行后提交结果 + evidence 到 POST /api/task/complete
//
// 用法：
//   node scripts/weixin-agent.js
// 环境变量：
//   AIBRIDGE_AGENT_BASE_URL=http://localhost:4567
//   AIBRIDGE_AGENT_POLL_TIMEOUT=30000
//   AIBRIDGE_AGENT_HEARTBEAT_INTERVAL=5000

const BASE_URL = (process.env.AIBRIDGE_AGENT_BASE_URL || 'http://localhost:4567').replace(/\/$/, '');
const POLL_TIMEOUT = parseInt(process.env.AIBRIDGE_AGENT_POLL_TIMEOUT || '30000', 10);
const HEARTBEAT_INTERVAL = parseInt(process.env.AIBRIDGE_AGENT_HEARTBEAT_INTERVAL || '5000', 10);

let running = true;
let heartbeatFailCount = 0;
let lastHeartbeatAt = 0;

// ======== 日志 ========
function log(level, ...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level.toUpperCase()}]`, ...args);
}

// ======== HTTP 封装 ========
async function apiGet(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

// ======== 心跳循环 ========
async function heartbeatLoop() {
  while (running) {
    try {
      const data = await apiGet('/api/heartbeat');
      heartbeatFailCount = 0;
      lastHeartbeatAt = Date.now();
      if (data.data?.has_urgent_task) {
        log('info', '心跳发现紧急任务，立即触发轮询');
      }
    } catch (e) {
      heartbeatFailCount++;
      log('warn', `心跳失败 (${heartbeatFailCount}/3): ${e.message}`);
      if (heartbeatFailCount >= 3) {
        log('error', 'bridge 离线，进入慢速重试模式');
        await sleep(10000);
        continue;
      }
    }
    await sleep(HEARTBEAT_INTERVAL);
  }
}

// ======== 长轮询循环 ========
async function pollLoop() {
  while (running) {
    try {
      const data = await apiGet(`/api/task/poll?timeout=${Math.min(POLL_TIMEOUT, 60000)}`);
      if (data.has_task && data.task) {
        log('info', `收到任务: ${data.task.id} [${data.task.type}]`);
        await executeTask(data.task);
        // 立即继续轮询，不等待
        continue;
      }
    } catch (e) {
      log('error', `轮询失败: ${e.message}，5 秒后重试`);
      await sleep(5000);
      continue;
    }
    // 无任务时 poll 已阻塞 timeout 时间，直接继续
  }
}

// ======== 任务执行 ========
async function executeTask(task) {
  const evidence = {
    executed_commands: [],
    read_files: [],
    searches: [],
    tool_calls: [],
    thinking: ''
  };

  let result;
  let status = 'success';

  try {
    const content = task.data?.content || '';
    const type = task.type || 'chat';

    evidence.thinking = `收到类型为 ${type} 的任务，内容：${content.slice(0, 80)}${content.length > 80 ? '...' : ''}`;

    switch (type) {
      case 'query_info':
        result = await handleQueryInfo(content, evidence);
        break;
      case 'execute_command':
        result = await handleExecuteCommand(content, evidence);
        break;
      case 'generate_content':
        result = await handleGenerateContent(content, evidence);
        break;
      case 'analyze_data':
        result = await handleAnalyzeData(content, evidence);
        break;
      case 'reply_message':
        result = await handleReplyMessage(content, evidence);
        break;
      case 'multi_step':
        result = await handleMultiStep(content, evidence);
        break;
      case 'chat':
      default:
        result = await handleChat(content, evidence);
        break;
    }
  } catch (e) {
    status = 'failed';
    result = {
      action: task.type || 'chat',
      summary: '任务执行失败',
      details: e.message
    };
    evidence.thinking += `\n执行异常: ${e.message}`;
  }

  // 提交结果
  try {
    await apiPost('/api/task/complete', {
      task_id: task.id,
      status,
      result,
      evidence,
      context_summary: {
        session_id: task.session_id || 'default',
        active_conversations: [
          {
            user_id: task.data?.from_user || 'unknown',
            last_active: Date.now(),
            topic: result.summary || '任务处理',
            pending_items: [],
            memory: [task.data?.content || ''].filter(Boolean)
          }
        ],
        global_state: {
          current_focus: result.summary || '',
          scheduled_tasks: [],
          alerts: []
        }
      }
    });
    log('info', `任务结果已提交: ${task.id} [${status}]`);
  } catch (e) {
    log('error', `提交任务结果失败: ${task.id}: ${e.message}`);
  }
}

// ======== 任务类型处理器 ========

async function handleQueryInfo(content, evidence) {
  // 示例：查询当前时间 / 系统信息 / 简单知识
  const lower = content.toLowerCase();

  if (lower.includes('时间') || lower.includes('time')) {
    const now = new Date().toLocaleString('zh-CN');
    evidence.searches.push({ query: content, engine: 'local', at: Date.now() });
    return { action: 'query_info', summary: '当前时间查询完成', details: `当前时间：${now}` };
  }

  if (lower.includes('磁盘') || lower.includes('disk') || lower.includes('df')) {
    const { stdout, cmd } = await safeExec('df -h /');
    evidence.executed_commands.push({ cmd, output_summary: stdout.slice(0, 200), at: Date.now() });
    return { action: 'query_info', summary: '磁盘容量查询完成', details: stdout };
  }

  if (lower.includes('内存') || lower.includes('memory') || lower.includes('mem')) {
    const { stdout, cmd } = await safeExec('free -h');
    evidence.executed_commands.push({ cmd, output_summary: stdout.slice(0, 200), at: Date.now() });
    return { action: 'query_info', summary: '内存使用查询完成', details: stdout };
  }

  // 默认：返回简单确认
  evidence.searches.push({ query: content, engine: 'local', at: Date.now() });
  return {
    action: 'query_info',
    summary: '已收到信息查询请求',
    details: `暂不支持该查询，请尝试：时间、磁盘、内存等关键词。原始问题：${content}`
  };
}

async function handleExecuteCommand(content, evidence) {
  // 安全：仅执行明确以 /cmd 或 "执行命令" 开头的指令，并做命令过滤
  const cmd = extractCommand(content);
  if (!cmd) {
    return {
      action: 'execute_command',
      summary: '无法解析命令',
      details: '请使用 "执行命令: <命令>" 或 "/cmd <命令>" 格式'
    };
  }

  if (!isCommandAllowed(cmd)) {
    evidence.executed_commands.push({ cmd, output_summary: '命令被安全策略拦截', at: Date.now() });
    return {
      action: 'execute_command',
      summary: '命令被安全策略拦截',
      details: `不允许执行：${cmd}`
    };
  }

  const { stdout, stderr, exitCode } = await safeExec(cmd);
  evidence.executed_commands.push({
    cmd,
    output_summary: (stdout || stderr).slice(0, 300),
    exit_code: exitCode,
    at: Date.now()
  });

  return {
    action: 'execute_command',
    summary: exitCode === 0 ? '命令执行成功' : `命令退出码 ${exitCode}`,
    details: stdout || stderr || '无输出'
  };
}

async function handleGenerateContent(content, evidence) {
  // 示例：生成简单回复或模板内容
  const topic = content.replace(/^(生成|写|创建|生成内容)[\s:：]*/i, '').trim();
  evidence.tool_calls.push({
    tool: 'template_generator',
    args: { topic },
    result_summary: '基于模板生成内容',
    at: Date.now()
  });

  const generated = `关于「${topic || '未指定主题'}」的简要内容：\n\n1. 背景与目标\n2. 核心要点\n3. 执行建议\n4. 预期结果\n\n（此内容为模板示例，实际可接入 LLM 生成高质量文案）`;

  return {
    action: 'generate_content',
    summary: '内容已生成',
    details: generated
  };
}

async function handleAnalyzeData(content, evidence) {
  // 示例：分析指定文件行数
  const filePath = extractFilePath(content);
  if (!filePath) {
    return {
      action: 'analyze_data',
      summary: '未指定文件路径',
      details: '请使用 "分析文件: /path/to/file" 格式'
    };
  }

  const fs = await import('fs');
  if (!fs.existsSync(filePath)) {
    evidence.read_files.push({ path: filePath, purpose: '分析数据', at: Date.now() });
    return {
      action: 'analyze_data',
      summary: '文件不存在',
      details: `路径：${filePath}`
    };
  }

  const data = fs.readFileSync(filePath, 'utf-8');
  const lines = data.split('\n').length;
  evidence.read_files.push({ path: filePath, purpose: '统计行数与内容摘要', at: Date.now() });

  return {
    action: 'analyze_data',
    summary: '文件分析完成',
    details: `文件：${filePath}\n行数：${lines}\n大小：${data.length} 字节\n前 200 字符：${data.slice(0, 200)}`
  };
}

async function handleReplyMessage(content, evidence) {
  evidence.tool_calls.push({ tool: 'reply_builder', args: { content }, result_summary: '构建回复', at: Date.now() });
  return {
    action: 'reply_message',
    summary: '已构建回复',
    details: `收到消息，正在处理：${content}`
  };
}

async function handleMultiStep(content, evidence) {
  evidence.thinking += '\n识别为多步骤任务，按顺序执行';
  // 示例：先查询时间，再生成总结
  const timeResult = await handleQueryInfo('当前时间', evidence);
  const summaryResult = await handleGenerateContent(`总结：${content}`, evidence);
  return {
    action: 'multi_step',
    summary: '多步骤任务已完成',
    details: `步骤1: ${timeResult.details}\n步骤2: ${summaryResult.details}`
  };
}

async function handleChat(content, evidence) {
  evidence.tool_calls.push({ tool: 'chat_handler', args: { content }, result_summary: '普通对话处理', at: Date.now() });
  return {
    action: 'chat',
    summary: '已收到消息',
    details: `你好，我是 ai-bridge 微信智能体。你发送了：${content}`
  };
}

// ======== 工具函数 ========

function extractCommand(content) {
  const m = content.match(/(?:执行命令|cmd|command)[:：\s]+(.+)/i);
  return m ? m[1].trim() : '';
}

function extractFilePath(content) {
  const m = content.match(/(?:分析文件|文件|file)[:：\s]+(\S+)/i);
  return m ? m[1].trim() : '';
}

function isCommandAllowed(cmd) {
  const dangerous = ['rm', 'rmdir', 'mkfs', 'dd', '>', '|', ';', '&&', 'eval', '`', '$('];
  return !dangerous.some((d) => cmd.includes(d));
}

async function safeExec(cmd) {
  const { exec } = await import('child_process');
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout?.trim() || '',
        stderr: stderr?.trim() || '',
        exitCode: error ? error.code || 1 : 0,
        cmd
      });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ======== 优雅退出 ========
process.on('SIGINT', () => {
  log('info', '收到 SIGINT，正在停止...');
  running = false;
  setTimeout(() => process.exit(0), 500);
});

process.on('SIGTERM', () => {
  log('info', '收到 SIGTERM，正在停止...');
  running = false;
  setTimeout(() => process.exit(0), 500);
});

// ======== 启动 ========
async function main() {
  log('info', `微信智能体启动，baseUrl=${BASE_URL}`);
  // 并行启动心跳和轮询
  await Promise.all([heartbeatLoop(), pollLoop()]);
}

main().catch((e) => {
  log('error', '主循环异常:', e);
  process.exit(1);
});
