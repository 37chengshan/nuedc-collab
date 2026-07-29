import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DomainRecordStore, DOMAIN_ACTIONS } from '@nuedc/protocol';
import { main } from '../src/runner.js';

const fixtures: string[] = [];
const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

async function makeRepository(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'nuedc-agent-cli-'));
  fixtures.push(repoRoot);
  const store = new DomainRecordStore(repoRoot);
  await store.ensureStructure();
  await store.writeMember({
    recordType: 'member',
    schemaVersion: 1,
    githubUsername: 'agent-user',
    roles: ['testing'],
    responsibilities: [],
    status: 'active',
    createdAt: '2026-07-29T09:00:00+08:00',
    updatedAt: '2026-07-29T09:00:00+08:00',
  });
  await store.writeLocalSettings({
    schemaVersion: 1,
    githubUsername: 'agent-user',
    port: 3210,
    autoFetchIntervalSeconds: 60,
    motionLevel: 'none',
    confirmGitWrites: true,
  });
  return repoRoot;
}

async function invoke(
  argv: string[],
  cwd: string,
  stdin = '',
): Promise<{ code: number; stdout: unknown; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, {
    cwd,
    readStdin: async () => stdin,
    writeStdout: (text) => {
      stdout += text;
    },
    writeStderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout: JSON.parse(stdout), stderr };
}

afterEach(async () => {
  while (fixtures.length > 0) {
    const root = fixtures.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe('Agent action runner', () => {
  it('通过 argv 调用唯一动作服务，并对相同请求返回幂等回放', async () => {
    const repoRoot = await makeRepository();
    const argv = [
      'action',
      'task.create',
      '--repo',
      repoRoot,
      '--idempotency-key',
      'agent-cli-task-create-0001',
      '--payload',
      '{"title":"验证通用 Runner","module":"测试","priority":"medium","owner":"agent-user"}',
      '--actor',
      'agent-user',
    ];

    const first = await invoke(argv, repoRoot);
    const second = await invoke(argv, repoRoot);

    expect(first.code).toBe(0);
    expect(first.stdout).toMatchObject({
      ok: true,
      action: 'task.create',
      idempotentReplay: false,
    });
    expect(second.code).toBe(0);
    expect(second.stdout).toMatchObject({
      ok: true,
      action: 'task.create',
      idempotentReplay: true,
    });
  });

  it('接受 stdin JSON，且拒绝伪造 actor 与协议未支持的模拟选项', async () => {
    const repoRoot = await makeRepository();
    const request = JSON.stringify({
      idempotencyKey: 'agent-cli-idea-create-0001',
      payload: { title: 'stdin 输入', module: '测试' },
    });

    const result = await invoke(['action', 'idea.create', '--repo', repoRoot], repoRoot, request);
    const actorMismatch = await invoke(
      ['action', 'idea.create', '--repo', repoRoot, '--actor', 'someone-else'],
      repoRoot,
      request,
    );
    const dryRun = await invoke(
      ['action', 'idea.create', '--repo', repoRoot, '--dry-run'],
      repoRoot,
      request,
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toMatchObject({ ok: true, action: 'idea.create' });
    expect(actorMismatch.code).toBe(64);
    expect(actorMismatch.stdout).toMatchObject({ ok: false, code: 'ACTOR_MISMATCH' });
    expect(dryRun.code).toBe(64);
    expect(dryRun.stdout).toMatchObject({ ok: false, code: 'OPTION_NOT_SUPPORTED' });
  });

  it('为 13 个协议动作提供一一对应的薄包装，且脚本不含 Git 动作', async () => {
    const scriptDirectory = path.join(workspaceRoot, 'scripts/agent');
    const scriptNames = (await readdir(scriptDirectory)).sort();
    const mappedActions = await Promise.all(
      scriptNames.map(async (scriptName) => {
        const source = await readFile(path.join(scriptDirectory, scriptName), 'utf8');
        expect(source).toMatch(/^import \{ runMappedAction \} from /);
        expect(source).not.toMatch(/\bgit(?:\s|\.|["'])/i);
        expect(source).not.toMatch(/child_process|spawn|execFile|DOM|puppeteer|playwright/i);
        return source.match(/runMappedAction\('([^']+)'\)/)?.[1];
      }),
    );

    expect(scriptNames).toHaveLength(13);
    expect(new Set(mappedActions)).toEqual(new Set(DOMAIN_ACTIONS));
    expect(mappedActions).not.toContain(undefined);
  });

  it('错误始终为结构化 JSON，并且不需要 Git 仓库即可执行领域动作', async () => {
    const repoRoot = await makeRepository();
    const invalid = await invoke(
      [
        'action',
        'task.create',
        '--repo',
        repoRoot,
        '--idempotency-key',
        'agent-cli-invalid-input-01',
        '--payload',
        '{"title":"","module":"测试","priority":"medium"}',
      ],
      repoRoot,
    );

    expect(invalid.code).toBe(2);
    expect(invalid.stdout).toMatchObject({
      ok: false,
      action: 'task.create',
      code: 'ACTION_VALIDATION_FAILED',
    });
    expect(invalid.stderr).toBe('');
  });
});
