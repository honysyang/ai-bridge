import { Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { asyncHandler } from '../middleware/error.js';
import { requireRole } from '../middleware/auth.js';
import { getAppVersion } from '../lib/version.js';

export const skillRouter = Router();

const SKILL_NAME = 'ai-bridge.skill.md';

function getProjectSkillPath(): string {
  return path.join(process.cwd(), 'docs', SKILL_NAME);
}

function getTargetDir(target: string, customPath?: string): string | null {
  const home = os.homedir();
  switch (target) {
    case 'trae':
      return path.join(home, '.trae', 'skills');
    case 'trae-cn':
      return path.join(home, '.trae-cn', 'skills');
    case 'custom':
      return customPath || null;
    default:
      return null;
  }
}

function getGuide(target: string, targetPath: string): string {
  const filePath = path.join(targetPath, SKILL_NAME);
  return `Skill 已安装到：${filePath}\n\n使用方式：\n1. 在 Trae / 智能体环境中引用本 skill，例如说「基于 ai-bridge skill 连接 bridge」。\n2. skill 会引导 AI 主动访问 http://localhost:4567 的任务队列。\n3. 保持 ai-bridge 服务运行，AI 即可持续接收并执行任务。\n\n如需更新，重新点击「一键安装」覆盖即可。`;
}

skillRouter.get(
  '/',
  asyncHandler((_req, res) => {
    const skillPath = getProjectSkillPath();
    if (!fs.existsSync(skillPath)) {
      res.status(404).json({ success: false, error: `项目 skill 文件不存在: ${skillPath}` });
      return;
    }
    const content = fs.readFileSync(skillPath, 'utf-8');
    res.json({
      success: true,
      data: {
        name: 'ai-bridge',
        file: skillPath,
        version: getAppVersion(),
        content
      }
    });
  })
);

skillRouter.get(
  '/installed',
  asyncHandler((_req, res) => {
    const home = os.homedir();
    const candidates = [
      { target: 'trae-cn', path: path.join(home, '.trae-cn', 'skills', SKILL_NAME) },
      { target: 'trae', path: path.join(home, '.trae', 'skills', SKILL_NAME) }
    ];
    const installed = candidates.filter((c) => fs.existsSync(c.path)).map((c) => ({ target: c.target, path: c.path }));
    res.json({ success: true, data: { installed, skill_name: SKILL_NAME } });
  })
);

skillRouter.post(
  '/install',
  requireRole('admin'),
  asyncHandler((req, res) => {
    const { target, customPath } = req.body || {};
    if (!target || typeof target !== 'string') {
      res.status(400).json({ success: false, error: '缺少 target 参数' });
      return;
    }

    const sourcePath = getProjectSkillPath();
    if (!fs.existsSync(sourcePath)) {
      res.status(404).json({ success: false, error: `项目 skill 文件不存在: ${sourcePath}` });
      return;
    }

    const targetDir = getTargetDir(target, customPath);
    if (!targetDir) {
      res.status(400).json({ success: false, error: `未知 target: ${target}` });
      return;
    }

    if (target === 'custom' && !path.isAbsolute(targetDir)) {
      res.status(400).json({ success: false, error: '自定义路径必须是绝对路径' });
      return;
    }

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const targetFile = path.join(targetDir, SKILL_NAME);
    const alreadyExists = fs.existsSync(targetFile);

    fs.copyFileSync(sourcePath, targetFile);

    res.json({
      success: true,
      data: {
        target,
        target_dir: targetDir,
        target_file: targetFile,
        already_exists: alreadyExists,
        status: alreadyExists ? 'updated' : 'installed',
        guide: getGuide(target, targetDir)
      }
    });
  })
);
