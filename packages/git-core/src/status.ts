import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runGit } from './run-git.js';
import {
  GitError,
  type ConnectionState,
  type GitSeverity,
  type GitState,
  type TopologyState,
  type WorktreeState,
} from './types.js';

export interface SeverityInput {
  worktree: WorktreeState;
  topology: TopologyState;
  connection: ConnectionState;
}

export function getSeverity(input: SeverityInput): GitSeverity {
  if (input.worktree === 'conflict') return 'conflict';
  if (input.topology === 'unborn') return 'unborn';
  if (input.topology === 'noRemote') return 'noRemote';
  if (input.connection === 'networkError') return 'networkError';
  if (input.connection === 'authError') return 'authError';
  if (input.topology === 'diverged') return 'diverged';
  if (input.topology === 'behind') return 'behind';
  if (input.topology === 'ahead') return 'ahead';
  if (input.worktree === 'dirty') return 'dirty';
  return 'clean';
}

function parsePorcelainZ(stdout: string): { dirtyPaths: string[]; conflictPaths: string[] } {
  const dirtyPaths: string[] = [];
  const conflictPaths: string[] = [];
  if (!stdout) return { dirtyPaths, conflictPaths };

  const entries = stdout.split('\0').filter(Boolean);
  let i = 0;
  while (i < entries.length) {
    const entry = entries[i]!;
    if (entry.length < 3) {
      i += 1;
      continue;
    }
    const xy = entry.slice(0, 2);
    let path = entry.slice(3);
    // rename/copy: XY\0 old \0 new
    if ((xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') && i + 1 < entries.length) {
      path = entries[i + 1]!;
      i += 2;
    } else {
      i += 1;
    }
    if (path.includes('\t')) {
      path = path.split('\t').at(-1)!;
    }
    dirtyPaths.push(path);
    if (
      xy.includes('U') ||
      xy === 'AA' ||
      xy === 'DD' ||
      xy === 'AU' ||
      xy === 'UA' ||
      xy === 'DU' ||
      xy === 'UD'
    ) {
      conflictPaths.push(path);
    }
  }
  return {
    dirtyPaths: [...new Set(dirtyPaths)].sort((a, b) => a.localeCompare(b)),
    conflictPaths: [...new Set(conflictPaths)].sort((a, b) => a.localeCompare(b)),
  };
}

async function tryRevParse(
  repoRoot: string,
  operation: 'revParseHead' | 'revParseRemote',
): Promise<string | null> {
  try {
    const result = await runGit(repoRoot, operation, [], { allowFailure: true });
    if (result.exitCode !== 0) return null;
    const value = result.stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function remoteOriginConfigured(repoRoot: string): boolean {
  const configPath = join(repoRoot, '.git', 'config');
  if (!existsSync(configPath)) return false;
  const text = readFileSync(configPath, 'utf8');
  return /\[remote "origin"\]/.test(text);
}

async function readAheadBehind(repoRoot: string): Promise<{ ahead: number; behind: number } | null> {
  try {
    const result = await runGit(repoRoot, 'revList', [], { allowFailure: true });
    if (result.exitCode !== 0) return null;
    const parts = result.stdout.trim().split(/\s+/);
    if (parts.length < 2) return null;
    const ahead = Number(parts[0]);
    const behind = Number(parts[1]);
    if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null;
    return { ahead, behind };
  } catch {
    return null;
  }
}

async function readBranch(repoRoot: string): Promise<string | null> {
  try {
    const result = await runGit(repoRoot, 'symbolicRef', [], { allowFailure: true });
    if (result.exitCode !== 0) return null;
    const ref = result.stdout.trim();
    return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref || null;
  } catch {
    return null;
  }
}

export async function inspectRepo(
  repoRoot: string,
  options?: { connection?: ConnectionState },
): Promise<GitState> {
  const connection: ConnectionState = options?.connection ?? 'online';
  const statusResult = await runGit(repoRoot, 'status', [], { allowFailure: true });
  const { dirtyPaths, conflictPaths } = parsePorcelainZ(statusResult.stdout);

  const head = await tryRevParse(repoRoot, 'revParseHead');
  const hasOrigin = remoteOriginConfigured(repoRoot);
  const remoteHead = hasOrigin ? await tryRevParse(repoRoot, 'revParseRemote') : null;
  const branch = await readBranch(repoRoot);

  let worktree: WorktreeState = 'clean';
  if (conflictPaths.length > 0) worktree = 'conflict';
  else if (dirtyPaths.length > 0) worktree = 'dirty';

  let topology: TopologyState;
  let ahead = 0;
  let behind = 0;

  if (head === null) {
    topology = 'unborn';
  } else if (!hasOrigin) {
    topology = 'noRemote';
  } else if (remoteHead === null) {
    topology = 'noRemote';
  } else {
    const counts = await readAheadBehind(repoRoot);
    if (!counts) {
      topology = 'diverged';
    } else {
      ahead = counts.ahead;
      behind = counts.behind;
      if (ahead > 0 && behind > 0) topology = 'diverged';
      else if (ahead > 0) topology = 'ahead';
      else if (behind > 0) topology = 'behind';
      else topology = 'synced';
    }
  }

  const severity = getSeverity({ worktree, topology, connection });

  return {
    worktree,
    topology,
    connection,
    head,
    remoteHead,
    ahead,
    behind,
    branch,
    remoteName: hasOrigin ? 'origin' : null,
    severity,
    dirtyPaths,
    conflictPaths,
    lastCheckedAt: new Date().toISOString(),
  };
}

export function assertNoUserGitArgs(args: string[]): void {
  const forbidden = [
    '--force',
    '-f',
    '--hard',
    'reset',
    'rebase',
    'checkout',
    'switch',
    'clean',
    'submodule',
    'config',
  ];
  for (const arg of args) {
    if (
      forbidden.includes(arg) ||
      arg.startsWith('--upload-pack') ||
      arg.startsWith('--receive-pack')
    ) {
      throw new GitError('INVALID_GIT_REQUEST', `禁止的 Git 参数: ${arg}`);
    }
  }
}
