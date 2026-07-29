import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  hashSelectedChanges,
  listSelectedChanges,
  validateCommitFiles,
  validateCommitMessage,
} from './changes.js';
import { AsyncGitLock } from './lock.js';
import { runGit } from './run-git.js';
import { inspectRepo } from './status.js';
import {
  GitError,
  type CommitRequest,
  type ConnectionState,
  type GitCore,
  type GitOperationResult,
  type GitState,
  type PullRequest,
  type PushRequest,
} from './types.js';

export interface CreateGitCoreOptions {
  repoRoot: string;
}

function requireConfirmed(confirmed: unknown): void {
  if (confirmed !== true) {
    throw new GitError('INVALID_GIT_REQUEST', 'Git 写操作必须 confirmed: true。');
  }
}

function ensureCacheDir(repoRoot: string): string {
  const dir = join(repoRoot, '.看板缓存');
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function readStagedNameStatus(repoRoot: string): Promise<string[]> {
  const result = await runGit(repoRoot, 'diffCached', [], { allowFailure: true });
  if (!result.stdout) return [];
  const entries = result.stdout.split('\0').filter(Boolean);
  const paths: string[] = [];
  let i = 0;
  while (i < entries.length) {
    const entry = entries[i]!;
    // name-status -z: STATUS\0path\0 or R100\0old\0new\0
    if (/^R\d+|^C\d+/.test(entry) && i + 2 < entries.length) {
      paths.push(entries[i + 2]!);
      i += 3;
      continue;
    }
    if (i + 1 < entries.length && /^[A-Z]/.test(entry) && entry.length <= 5) {
      paths.push(entries[i + 1]!);
      i += 2;
      continue;
    }
    // fallback porcelain-ish
    if (entry.length >= 3) {
      paths.push(entry.slice(3));
    }
    i += 1;
  }
  return [...new Set(paths)].sort((a, b) => a.localeCompare(b));
}

export function createGitCore(options: CreateGitCoreOptions): GitCore {
  const repoRoot = options.repoRoot;
  let lastConnection: ConnectionState = 'online';

  const inspect = async (inspectOptions?: { connection?: ConnectionState }): Promise<GitState> => {
    const connection = inspectOptions?.connection ?? lastConnection;
    const state = await inspectRepo(repoRoot, { connection });
    return state;
  };

  const fetch = async (): Promise<GitState> => {
    return AsyncGitLock.run(repoRoot, async () => {
      try {
        await runGit(repoRoot, 'fetch');
        lastConnection = 'online';
      } catch (error) {
        if (error instanceof GitError && error.code === 'GIT_AUTH_ERROR') {
          lastConnection = 'authError';
          const state = await inspectRepo(repoRoot, { connection: 'authError' });
          throw Object.assign(error, { state });
        }
        if (error instanceof GitError && error.code === 'NETWORK_ERROR') {
          lastConnection = 'networkError';
          const state = await inspectRepo(repoRoot, { connection: 'networkError' });
          throw Object.assign(error, { state });
        }
        throw error;
      }
      return inspectRepo(repoRoot, { connection: 'online' });
    });
  };

  const pullFastForward = async (request: PullRequest): Promise<GitOperationResult> => {
    requireConfirmed(request.confirmed);
    return AsyncGitLock.run(repoRoot, async () => {
      const state = await inspectRepo(repoRoot, { connection: lastConnection });
      if (state.head !== request.expectedHead || state.remoteHead !== request.expectedRemoteHead) {
        throw new GitError('STALE_GIT_STATE', '确认后的 Git 状态已变化，未执行拉取。');
      }
      if (state.worktree === 'conflict') {
        throw new GitError('CONFLICT_PRESENT', '工作区存在冲突，禁止拉取。');
      }
      if (state.worktree !== 'clean') {
        throw new GitError('DIRTY_WORKTREE', '工作区不干净，禁止拉取。');
      }
      if (state.topology === 'diverged') {
        throw new GitError('DIVERGED_HISTORY', '本地与远端已分叉，禁止自动拉取。');
      }
      if (state.topology === 'unborn') {
        throw new GitError('UNBORN_HEAD', '本地尚未创建提交，禁止拉取。');
      }
      if (state.topology === 'noRemote' || !state.remoteHead) {
        throw new GitError('NO_REMOTE', '未配置可用 origin/main，禁止拉取。');
      }
      if (state.connection !== 'online') {
        throw new GitError(
          state.connection === 'authError' ? 'GIT_AUTH_ERROR' : 'NETWORK_ERROR',
          '连接状态异常，禁止拉取。',
        );
      }
      if (state.topology !== 'behind') {
        throw new GitError('INVALID_GIT_REQUEST', '仅允许在 clean + behind + online 时快进拉取。');
      }

      await runGit(repoRoot, 'mergeFfOnly');
      const next = await inspectRepo(repoRoot, { connection: 'online' });
      return {
        ok: true,
        state: next,
        ...(next.head === null ? {} : { commit: next.head }),
        message: '快进拉取成功',
      };
    });
  };

  const commitSelected = async (request: CommitRequest): Promise<GitOperationResult> => {
    requireConfirmed(request.confirmed);
    const files = validateCommitFiles(request.files);
    const message = validateCommitMessage(request.message);

    return AsyncGitLock.run(repoRoot, async () => {
      const state = await inspectRepo(repoRoot, { connection: lastConnection });
      if (state.worktree === 'conflict') {
        throw new GitError('CONFLICT_PRESENT', '工作区存在冲突，禁止提交。');
      }
      if (state.head !== request.expectedHead) {
        throw new GitError('STALE_GIT_STATE', '确认后的 HEAD 已变化，未执行提交。');
      }

      const currentChanges = await listSelectedChanges(repoRoot);
      const selected = currentChanges.filter((item) => files.includes(item.path));
      if (selected.length !== files.length) {
        throw new GitError('STALE_GIT_STATE', '选中文件集合与当前工作区不一致。');
      }
      const changesHash = hashSelectedChanges(selected);
      if (changesHash !== request.expectedChangesHash) {
        throw new GitError('STALE_GIT_STATE', '选中文件内容摘要已变化，未执行提交。');
      }

      const staged = await readStagedNameStatus(repoRoot);
      if (staged.length > 0) {
        throw new GitError('PREEXISTING_STAGED_CHANGES', 'index 中已有暂存内容，请先处理后再提交。');
      }

      const cacheDir = ensureCacheDir(repoRoot);
      const indexPath = join(repoRoot, '.git', 'index');
      const backupPath = join(cacheDir, `index-backup-${Date.now()}.bin`);
      if (existsSync(indexPath)) {
        copyFileSync(indexPath, backupPath);
      } else {
        writeFileSync(backupPath, '');
      }

      const restoreIndex = () => {
        if (existsSync(backupPath) && readFileSync(backupPath).length > 0) {
          copyFileSync(backupPath, indexPath);
        } else if (existsSync(indexPath) && readFileSync(backupPath).length === 0 && !existsSync(join(repoRoot, '.git', 'index'))) {
          // nothing
        } else if (existsSync(backupPath) && readFileSync(backupPath).length === 0 && existsSync(indexPath)) {
          // keep current if no original index? prefer remove staged by restoring empty only when no original
        }
        try {
          rmSync(backupPath, { force: true });
        } catch {
          // ignore
        }
      };

      try {
        await runGit(repoRoot, 'add', files);
        const stagedAfter = await readStagedNameStatus(repoRoot);
        const stagedSet = new Set(stagedAfter);
        for (const file of files) {
          // deleted files appear in staged; added/modified too
          if (!stagedSet.has(file) && !selected.some((s) => s.path === file && s.status === 'D')) {
            // allow D to be represented; if still missing, stale
            const stillMissing = !stagedSet.has(file);
            if (stillMissing) {
              // Some git versions list deleted differently; re-check via status
              const afterChanges = await listSelectedChanges(repoRoot);
              const item = afterChanges.find((c) => c.path === file);
              if (!item) {
                throw new GitError('STALE_GIT_STATE', `暂存后缺少文件: ${file}`);
              }
            }
          }
        }

        await runGit(repoRoot, 'commit', [message]);
        try {
          rmSync(backupPath, { force: true });
        } catch {
          // ignore
        }
        const next = await inspectRepo(repoRoot, { connection: lastConnection });
        return {
          ok: true,
          state: next,
          ...(next.head === null ? {} : { commit: next.head }),
          message: '提交成功',
        };
      } catch (error) {
        // restore index
        try {
          if (existsSync(backupPath)) {
            if (readFileSync(backupPath).length > 0) {
              copyFileSync(backupPath, indexPath);
            }
          }
          rmSync(backupPath, { force: true });
        } catch {
          // ignore restore errors
        }
        void restoreIndex;
        throw error;
      }
    });
  };

  const push = async (request: PushRequest): Promise<GitOperationResult> => {
    requireConfirmed(request.confirmed);
    return AsyncGitLock.run(repoRoot, async () => {
      // always fetch first
      try {
        await runGit(repoRoot, 'fetch');
        lastConnection = 'online';
      } catch (error) {
        if (error instanceof GitError && error.code === 'GIT_AUTH_ERROR') {
          lastConnection = 'authError';
        } else if (error instanceof GitError && error.code === 'NETWORK_ERROR') {
          lastConnection = 'networkError';
        }
        throw error;
      }

      const state = await inspectRepo(repoRoot, { connection: 'online' });
      if (state.head !== request.expectedHead || state.remoteHead !== request.expectedRemoteHead) {
        // after fetch remote head may change; expectedRemoteHead is pre-fetch remote
        // Spec: re-read and compare confirmation snapshot — if remote moved, STALE
        if (state.head !== request.expectedHead) {
          throw new GitError('STALE_GIT_STATE', '确认后的 HEAD 已变化，未执行推送。');
        }
        if (state.remoteHead !== request.expectedRemoteHead) {
          throw new GitError('STALE_GIT_STATE', '远端 HEAD 已变化，未执行推送。');
        }
      }
      if (state.worktree === 'conflict') {
        throw new GitError('CONFLICT_PRESENT', '工作区存在冲突，禁止推送。');
      }
      if (state.worktree !== 'clean') {
        throw new GitError('DIRTY_WORKTREE', '工作区不干净，禁止推送。');
      }
      if (state.topology === 'diverged') {
        throw new GitError('DIVERGED_HISTORY', '历史已分叉，禁止推送。');
      }
      if (state.topology === 'unborn') {
        throw new GitError('UNBORN_HEAD', '本地尚未创建提交，禁止推送。');
      }
      if (state.topology === 'noRemote') {
        throw new GitError('NO_REMOTE', '未配置可用远端，禁止推送。');
      }
      if (state.topology !== 'ahead') {
        throw new GitError('INVALID_GIT_REQUEST', '仅允许在 clean + ahead + online 时推送。');
      }

      await runGit(repoRoot, 'push');
      const next = await inspectRepo(repoRoot, { connection: 'online' });
      return {
        ok: true,
        state: next,
        ...(next.head === null ? {} : { commit: next.head }),
        message: '推送成功',
      };
    });
  };

  return {
    inspect,
    listChanges: () => listSelectedChanges(repoRoot),
    listLog: (limit) => import('./history.js').then((m) => m.listLog(repoRoot, limit)),
    readDiff: (opts) => import('./history.js').then((m) => m.readDiff(repoRoot, opts)),
    fetch,
    pullFastForward,
    commitSelected,
    push,
  };
}
