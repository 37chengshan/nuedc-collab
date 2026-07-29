import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runGit } from './run-git.js';
import { GitError, type SelectedChange } from './types.js';

function normalizeRelativePath(path: string): string {
  const trimmed = path.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!trimmed || trimmed.startsWith('/') || trimmed.includes('..')) {
    throw new GitError('INVALID_GIT_REQUEST', `非法相对路径: ${path}`);
  }
  return trimmed;
}

export function hashSelectedChanges(changes: SelectedChange[]): string {
  const normalized = [...changes]
    .map((item) => ({
      path: normalizeRelativePath(item.path),
      status: item.status,
      contentHash: item.contentHash,
    }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.status.localeCompare(b.status));

  const payload = JSON.stringify(normalized);
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

function parseStatusEntries(stdout: string): Array<{ status: string; path: string }> {
  const out: Array<{ status: string; path: string }> = [];
  if (!stdout) return out;
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
    if ((xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') && i + 1 < entries.length) {
      path = entries[i + 1]!;
      i += 2;
    } else {
      i += 1;
    }
    if (path.includes('\t')) path = path.split('\t').at(-1)!;
    const indexStatus = xy[0] === ' ' ? xy[1]! : xy[0]!;
    const worktreeStatus = xy[1]!;
    const status =
      indexStatus === 'D' || worktreeStatus === 'D'
        ? 'D'
        : indexStatus === 'A' || worktreeStatus === 'A' || xy === '??'
          ? 'A'
          : indexStatus === 'R' || worktreeStatus === 'R'
            ? 'R'
            : 'M';
    out.push({ status, path });
  }
  return out;
}

function contentHashForPath(repoRoot: string, path: string, status: string): string {
  if (status === 'D') return 'DELETED';
  const abs = join(repoRoot, path);
  if (!existsSync(abs)) return 'DELETED';
  const bytes = readFileSync(abs);
  return createHash('sha256').update(bytes).digest('hex');
}

export async function listSelectedChanges(repoRoot: string): Promise<SelectedChange[]> {
  const result = await runGit(repoRoot, 'status', [], { allowFailure: true });
  const entries = parseStatusEntries(result.stdout);
  const byPath = new Map<string, SelectedChange>();
  for (const entry of entries) {
    const path = normalizeRelativePath(entry.path);
    byPath.set(path, {
      path,
      status: entry.status,
      contentHash: contentHashForPath(repoRoot, path, entry.status),
    });
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export async function hashObjectFile(repoRoot: string, relativePath: string): Promise<string> {
  const path = normalizeRelativePath(relativePath);
  const result = await runGit(repoRoot, 'hashObject', [`--path=${path}`, '--', path]);
  return result.stdout.trim();
}

export async function listStagedBlobIds(repoRoot: string, relativePaths: string[]): Promise<Map<string, string>> {
  const paths = relativePaths.map(normalizeRelativePath);
  const result = await runGit(repoRoot, 'lsFiles', paths, { allowFailure: true });
  const blobs = new Map<string, string>();
  for (const entry of result.stdout.split('\0').filter(Boolean)) {
    const match = /^\d+ ([0-9a-f]+) 0\t(.+)$/i.exec(entry);
    if (!match) continue;
    blobs.set(normalizeRelativePath(match[2]!), match[1]!);
  }
  return blobs;
}

export function validateCommitFiles(files: string[]): string[] {
  if (!Array.isArray(files) || files.length < 1 || files.length > 200) {
    throw new GitError('INVALID_GIT_REQUEST', '提交文件数量必须在 1—200 之间。');
  }
  const normalized = [...new Set(files.map(normalizeRelativePath))];
  if (normalized.length < 1 || normalized.length > 200) {
    throw new GitError('INVALID_GIT_REQUEST', '提交文件去重后数量必须在 1—200 之间。');
  }
  return normalized.sort((a, b) => a.localeCompare(b));
}

export function validateCommitMessage(message: string): string {
  const trimmed = message.normalize('NFC').trim();
  const length = [...trimmed].length;
  if (length < 1 || length > 500) {
    throw new GitError('INVALID_GIT_REQUEST', '提交说明必须为 1—500 个 Unicode 字符。');
  }
  return trimmed;
}
