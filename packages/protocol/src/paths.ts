import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELATIVE_DIRS = {
  tasks: '比赛管理/任务',
  issues: '比赛管理/问题',
  ideas: '比赛管理/想法',
  events: '比赛管理/事件',
  members: '比赛管理/成员',
  templates: '比赛管理/模板',
  localSettings: '.本机配置',
  boardCache: '.看板缓存',
  actionReceipts: '.看板缓存/actions',
} as const;

export function resolveRepoPath(repoRoot: string, ...segments: string[]): string {
  const root = path.resolve(repoRoot);
  const target = path.resolve(root, ...segments);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`路径逃逸被拒绝: ${segments.join('/')}`);
  }
  return target;
}

export function toPosixRelative(repoRoot: string, absolutePath: string): string {
  const relative = path.relative(path.resolve(repoRoot), path.resolve(absolutePath));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`路径逃逸被拒绝: ${absolutePath}`);
  }
  return relative.split(path.sep).join('/');
}

export function taskPath(repoRoot: string, id: string): string {
  return resolveRepoPath(repoRoot, RELATIVE_DIRS.tasks, `${id}.json`);
}
export function issuePath(repoRoot: string, id: string): string {
  return resolveRepoPath(repoRoot, RELATIVE_DIRS.issues, `${id}.json`);
}
export function ideaPath(repoRoot: string, id: string): string {
  return resolveRepoPath(repoRoot, RELATIVE_DIRS.ideas, `${id}.json`);
}
export function eventPath(repoRoot: string, id: string): string {
  return resolveRepoPath(repoRoot, RELATIVE_DIRS.events, `${id}.json`);
}
export function memberPath(repoRoot: string, username: string): string {
  return resolveRepoPath(repoRoot, RELATIVE_DIRS.members, `${username}.json`);
}
export function localSettingsPath(repoRoot: string): string {
  return resolveRepoPath(repoRoot, RELATIVE_DIRS.localSettings, 'settings.json');
}
export function actionReceiptPath(repoRoot: string, keyHash: string): string {
  return resolveRepoPath(repoRoot, RELATIVE_DIRS.actionReceipts, `${keyHash}.json`);
}

export function defaultRepoRootFromCwd(cwd = process.cwd()): string {
  return path.resolve(cwd);
}

export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}
