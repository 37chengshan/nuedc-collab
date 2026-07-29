import { randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { RELATIVE_DIRS, resolveRepoPath } from './paths.js';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomSuffix(length = 4): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += CROCKFORD[bytes[i]! % CROCKFORD.length]!;
  }
  return out;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function ymd(date = new Date()): string {
  const y = date.getFullYear();
  const m = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  return `${y}${m}${d}`;
}

function hms(date = new Date()): string {
  return `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

async function existingIds(dir: string, prefix: string): Promise<Set<string>> {
  try {
    const files = await readdir(dir);
    return new Set(
      files
        .filter((f) => f.endsWith('.json') && f.startsWith(prefix))
        .map((f) => f.replace(/\.json$/, '')),
    );
  } catch {
    return new Set();
  }
}

async function allocate(
  repoRoot: string,
  relativeDir: string,
  build: () => string,
  maxAttempts = 32,
): Promise<string> {
  const dir = resolveRepoPath(repoRoot, relativeDir);
  const existing = await existingIds(dir, build().slice(0, 2));
  for (let i = 0; i < maxAttempts; i += 1) {
    const id = build();
    if (!existing.has(id)) {
      existing.add(id);
      return id;
    }
  }
  throw new Error(`无法生成唯一 ID: ${relativeDir}`);
}

export async function generateTaskId(repoRoot: string, now = new Date()): Promise<string> {
  return allocate(repoRoot, RELATIVE_DIRS.tasks, () => `T-${ymd(now)}-${randomSuffix()}`);
}

export async function generateIssueId(repoRoot: string, now = new Date()): Promise<string> {
  return allocate(repoRoot, RELATIVE_DIRS.issues, () => `I-${ymd(now)}-${randomSuffix()}`);
}

export async function generateIdeaId(repoRoot: string, now = new Date()): Promise<string> {
  return allocate(repoRoot, RELATIVE_DIRS.ideas, () => `A-${ymd(now)}-${randomSuffix()}`);
}

export async function generateEventId(repoRoot: string, now = new Date()): Promise<string> {
  return allocate(
    repoRoot,
    RELATIVE_DIRS.events,
    () => `E-${ymd(now)}-${hms(now)}-${randomSuffix()}`,
  );
}

export function isTaskId(value: string): boolean {
  return /^T-\d{8}-[0-9A-HJKMNP-TV-Z]{4}$/.test(value);
}
export function isIssueId(value: string): boolean {
  return /^I-\d{8}-[0-9A-HJKMNP-TV-Z]{4}$/.test(value);
}
export function isIdeaId(value: string): boolean {
  return /^A-\d{8}-[0-9A-HJKMNP-TV-Z]{4}$/.test(value);
}
export function isEventId(value: string): boolean {
  return /^E-\d{8}-\d{6}-[0-9A-HJKMNP-TV-Z]{4}$/.test(value);
}

export function nowIso(date = new Date()): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const hh = pad2(Math.floor(abs / 60));
  const mm = pad2(abs % 60);
  const iso = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .replace('Z', '');
  return `${iso.slice(0, 19)}${sign}${hh}:${mm}`;
}
