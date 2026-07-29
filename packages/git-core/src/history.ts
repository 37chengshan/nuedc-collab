import { runGit } from './run-git.js';
import { GitError, type GitDiffFile, type GitLogEntry } from './types.js';

function normalizeRelativePath(path: string): string {
  const trimmed = path.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!trimmed || trimmed.startsWith('/') || trimmed.includes('..')) {
    throw new GitError('INVALID_GIT_REQUEST', `非法相对路径: ${path}`);
  }
  return trimmed;
}

export async function listLog(repoRoot: string, limit = 50): Promise<GitLogEntry[]> {
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 100);
  // Fixed template already has --max-count=50; for smaller limits we still parse and slice.
  const result = await runGit(repoRoot, 'log', [], { allowFailure: true });
  if (result.exitCode !== 0) return [];
  const lines = result.stdout.split('\n').filter(Boolean);
  const entries: GitLogEntry[] = [];
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const [sha, shortSha, authorName, authorEmail, committedAt, parentsRaw, ...subjectParts] = parts;
    entries.push({
      sha: sha!,
      shortSha: shortSha!,
      authorName: authorName!,
      authorEmail: authorEmail!,
      committedAt: committedAt!,
      parents: parentsRaw ? parentsRaw.split(' ').filter(Boolean) : [],
      subject: subjectParts.join('\t'),
    });
    if (entries.length >= safeLimit) break;
  }
  return entries;
}

export async function readDiff(
  repoRoot: string,
  options?: { commit?: string; path?: string },
): Promise<GitDiffFile[]> {
  const extra: string[] = [];
  if (options?.commit) {
    if (!/^[0-9a-f]{7,40}$/i.test(options.commit)) {
      throw new GitError('INVALID_GIT_REQUEST', 'commit 必须是 7—40 位十六进制 SHA。');
    }
    extra.push(options.commit, `${options.commit}^!`);
  }
  if (options?.path) {
    extra.push('--', normalizeRelativePath(options.path));
  }
  const result = await runGit(repoRoot, 'diff', extra, { allowFailure: true });
  if (!result.stdout.trim()) return [];

  // For commit show-style, prefer git show when commit provided without path-only diff complexity.
  if (options?.commit && !options.path) {
    const show = await runGit(repoRoot, 'show', [options.commit, '--name-status'], { allowFailure: true });
    const files: GitDiffFile[] = [];
    for (const line of show.stdout.split('\n')) {
      const m = /^(A|M|D|R\d*|C\d*)\t(.+)$/.exec(line);
      if (!m) continue;
      const status = m[1]!.startsWith('R') ? 'R' : m[1]!.startsWith('C') ? 'C' : m[1]!;
      const pathPart = m[2]!;
      const path = pathPart.includes('\t') ? pathPart.split('\t').at(-1)! : pathPart;
      files.push({ path, status });
    }
    if (files.length > 0) return files;
  }

  // Fallback: single aggregated patch entry when unstructured.
  return [
    {
      path: options?.path ?? '(worktree)',
      status: 'M',
      patch: result.stdout.slice(0, 200_000),
    },
  ];
}
