import { Router } from 'express';
import { taskQueue } from '../task-queue.js';
import { storage } from '../storage.js';
import { workflowStore } from '../workflow-store.js';
import { WorkflowExecution, WFExecuteResp } from '../workflow-types.js';
import { asyncHandler } from '../middleware/error.js';

/**
 * 工作流路由（多步任务模板：CRUD + 一键执行）
 * - GET    /api/wf               列表
 * - POST   /api/wf/seed-demo     追加演示
 * - GET    /api/wf/:id           详情
 * - POST   /api/wf               创建
 * - PATCH  /api/wf/:id           更新
 * - DELETE /api/wf/:id           删除
 * - POST   /api/wf/:id/execute   执行（批量创建 task）
 */
export const workflowRouter = Router();

// 列表
workflowRouter.get(
  '/',
  asyncHandler((_req, res) => {
    res.json({ success: true, data: workflowStore.list() });
  })
);

// 追加演示
workflowRouter.post(
  '/seed-demo',
  asyncHandler((_req, res) => {
    const result = workflowStore.seedDemo();
    taskQueue.addLog('info', 'system', `工作流演示追加: ${result.added} 个`);
    res.json({ success: true, data: result, message: `新增 ${result.added} 个工作流` });
  })
);

// 详情
workflowRouter.get(
  '/:id',
  asyncHandler((req, res) => {
    const wf = workflowStore.get(req.params.id);
    if (!wf) {
      return res.status(404).json({ success: false, error: '工作流不存在' });
    }
    res.json({ success: true, data: wf });
  })
);

// 创建
workflowRouter.post(
  '/',
  asyncHandler((req, res) => {
    const { name, icon, description, steps } = req.body || {};
    if (!name || typeof name !== 'string' || !Array.isArray(steps) || steps.length === 0) {
      return res.status(400).json({ success: false, error: 'name 必填，steps 至少 1 步' });
    }
    const wf = workflowStore.create(name, icon, description, steps);
    taskQueue.addLog('info', 'system', `工作流创建: ${wf.id} (${wf.name}, ${wf.steps.length} 步)`, { wf_id: wf.id });
    res.json({ success: true, data: wf });
  })
);

// 更新
workflowRouter.patch(
  '/:id',
  asyncHandler((req, res) => {
    const updated = workflowStore.update(req.params.id, req.body || {});
    if (!updated) {
      return res.status(404).json({ success: false, error: '工作流不存在' });
    }
    res.json({ success: true, data: updated });
  })
);

// 删除
workflowRouter.delete(
  '/:id',
  asyncHandler((req, res) => {
    const ok = workflowStore.delete(req.params.id);
    if (!ok) {
      return res.status(404).json({ success: false, error: '工作流不存在' });
    }
    taskQueue.addLog('warn', 'system', `工作流删除: ${req.params.id}`, { wf_id: req.params.id });
    res.json({ success: true, data: { id: req.params.id } });
  })
);

// 执行：按 steps 顺序创建 task，返回 execution_id + task_ids
workflowRouter.post(
  '/:id/execute',
  asyncHandler(async (req, res) => {
    const wf = workflowStore.get(req.params.id);
    if (!wf) {
      return res.status(404).json({ success: false, error: '工作流不存在' });
    }
    const sessionId: string = (req.body && req.body.session_id) || 'sess-default';

    const execution_id = `wfexec-${Date.now()}`;
    const task_ids: string[] = [];
    const stepIdToTaskId = new Map<string, string>();

    for (const step of wf.steps) {
      const task = await taskQueue.createManualTask(
        step.content,
        (step.task_type as any) || 'query_info',
        (step.priority as any) || 'normal'
      );
      await storage.updateTask(task.id, {
        session_id: sessionId,
        source: 'workflow',
        data: {
          ...task.data,
          wf_id: wf.id,
          wf_name: wf.name,
          wf_execution_id: execution_id,
          wf_step_id: step.id,
          wf_step_name: step.name,
          wf_step_depends_on: step.depends_on || []
        }
      } as any);
      task_ids.push(task.id);
      stepIdToTaskId.set(step.id, task.id);
    }

    const exec: WorkflowExecution = {
      workflow_id: wf.id,
      execution_id,
      started_at: Date.now(),
      task_ids
    };
    workflowStore.recordExecution(exec);

    taskQueue.addLog('success', 'system', `工作流执行: ${wf.name} (${task_ids.length} 任务)`, {
      wf_id: wf.id,
      execution_id,
      task_count: task_ids.length
    });

    const resp: WFExecuteResp = { execution_id, task_ids };
    res.json({ success: true, data: resp });
  })
);
