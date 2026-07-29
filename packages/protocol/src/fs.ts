import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { stableStringify } from './json.js';

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function readJsonFile<T = unknown>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`);
  const payload = stableStringify(value);
  try {
    await writeFile(tmp, payload, { encoding: 'utf8', flag: 'wx' });
    const handle = await open(tmp, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, filePath);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readTextFile(filePath: string): Promise<string> {
  return readFile(filePath, 'utf8');
}

const WRITE_LOCK_TIMEOUT_MS = 10_000;
const STALE_WRITE_LOCK_MS = 30_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRepositoryWriteLock<T>(repoRoot: string, operation: () => Promise<T>): Promise<T> {
  const lockDir = path.join(repoRoot, '.看板缓存', 'locks');
  const lockPath = path.join(lockDir, 'protocol-write.lock');
  await ensureDir(lockDir);
  const deadline = Date.now() + WRITE_LOCK_TIMEOUT_MS;

  while (true) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), 'utf8');
        return await operation();
      } finally {
        await handle.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > STALE_WRITE_LOCK_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error('等待仓库写锁超时；可能有另一个本地服务或脚本正在写入。');
      }
      await wait(50);
    }
  }
}
