#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DOMAIN_ACTIONS,
  DomainRecordStore,
  atomicWriteJson,
  createProtocolRuntime,
  nowIso,
  type DomainActionName,
  type DomainActionRequest,
  type Member,
} from '@nuedc/protocol';
import { createGitCore } from '@nuedc/git-core';

type Io = {
  cwd: string;
  readStdin: () => Promise<string>;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
};

const defaultIo: Io = {
  cwd: process.cwd(),
  readStdin: async () => {
    let data = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) data += chunk;
    return data;
  },
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
};

function output(io: Io, value: unknown): void {
  io.writeStdout(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(io: Io, code: string, message: string, exitCode = 64, action?: string): number {
  output(io, { ok: false, ...(action ? { action } : {}), code, message });
  return exitCode;
}

function parseArgs(argv: string[]): { positional: string[]; options: Map<string, string | true> } {
  const positional: string[] = [];
  const options = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const [key = token, inline] = token.split('=', 2);
    if (inline !== undefined) {
      options.set(key, inline);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      options.set(key, next);
      index += 1;
    } else {
      options.set(key, true);
    }
  }
  return { positional, options };
}

function option(options: Map<string, string | true>, name: string): string | undefined {
  const value = options.get(name);
  return typeof value === 'string' ? value : undefined;
}

function csv(value: string | undefined): string[] {
  return value ? value.split(',').map((item) => item.trim()).filter(Boolean) : [];
}

async function readRequest(
  options: Map<string, string | true>,
  io: Io,
): Promise<DomainActionRequest> {
  const inline = option(options, '--request');
  const stdin = inline ? '' : (await io.readStdin()).trim();
  if (inline || stdin) return JSON.parse(inline || stdin) as DomainActionRequest;
  const payloadText = option(options, '--payload');
  const expectedRevision = option(options, '--expected-revision');
  return {
    idempotencyKey: option(options, '--idempotency-key') ?? '',
    ...(expectedRevision ? { expectedRevision } : {}),
    payload: payloadText ? JSON.parse(payloadText) : {},
  };
}

async function runAction(
  action: DomainActionName,
  options: Map<string, string | true>,
  io: Io,
): Promise<number> {
  if (options.has('--dry-run')) {
    return fail(io, 'OPTION_NOT_SUPPORTED', '领域动作不支持 --dry-run；请使用唯一幂等键安全重试。', 64, action);
  }
  const repoRoot = path.resolve(option(options, '--repo') ?? io.cwd);
  const runtime = await createProtocolRuntime(repoRoot);
  const settings = await runtime.repository.readLocalSettings();
  const actor = option(options, '--actor');
  if (actor && actor !== settings.githubUsername) {
    return fail(io, 'ACTOR_MISMATCH', `actor 必须与本机设置一致：${settings.githubUsername}`, 64, action);
  }
  const request = await readRequest(options, io);
  const result = await runtime.actions.execute('agent', action, request);
  if (result.ok) {
    output(io, result);
    return 0;
  }
  output(io, {
    ok: false,
    action,
    code: result.error?.code ?? 'ACTION_FAILED',
    message: result.error?.message ?? '动作失败',
    result,
  });
  return result.error?.code === 'ACTION_VALIDATION_FAILED' ? 2 : 1;
}

async function initMember(options: Map<string, string | true>, io: Io): Promise<number> {
  const repoRoot = path.resolve(option(options, '--repo') ?? io.cwd);
  const username = option(options, '--username');
  if (!username) return fail(io, 'MISSING_ARGUMENT', '缺少 --username GitHub 用户名。');
  const roles = csv(option(options, '--roles'));
  if (roles.length === 0) return fail(io, 'MISSING_ARGUMENT', '缺少 --roles，例如 hardware,firmware。');
  const store = new DomainRecordStore(repoRoot);
  await store.ensureStructure();
  const { snapshot } = await store.buildSnapshot();
  const existing = snapshot.members.get(username);
  const timestamp = nowIso();
  const member: Member = {
    recordType: 'member',
    schemaVersion: 1,
    githubUsername: username,
    roles: roles as Member['roles'],
    responsibilities: csv(option(options, '--responsibilities')),
    status: 'active',
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
  await store.writeMember(member);
  if (options.has('--local')) {
    await store.writeLocalSettings({
      schemaVersion: 1,
      githubUsername: username,
      port: 3210,
      autoFetchIntervalSeconds: 60,
      motionLevel: 'none',
      confirmGitWrites: true,
    });
  }
  output(io, {
    ok: true,
    idempotentUpdate: Boolean(existing),
    member,
    localSettingsWritten: options.has('--local'),
  });
  return 0;
}

async function collect(repoRoot: string) {
  const runtime = await createProtocolRuntime(repoRoot);
  const [tasks, issues, ideas, events, members] = await Promise.all([
    runtime.repository.listTasks(),
    runtime.repository.listIssues(),
    runtime.repository.listIdeas(),
    runtime.repository.listEvents(),
    runtime.repository.listMembers(),
  ]);
  return { tasks, issues, ideas, events, members };
}

async function listRecords(
  kind: string,
  options: Map<string, string | true>,
  io: Io,
): Promise<number> {
  const repoRoot = path.resolve(option(options, '--repo') ?? io.cwd);
  const data = await collect(repoRoot);
  const mapping = {
    tasks: data.tasks,
    issues: data.issues,
    ideas: data.ideas,
    events: data.events,
    members: data.members,
  } as const;
  const selected = mapping[kind as keyof typeof mapping];
  if (!selected) return fail(io, 'INVALID_KIND', '类型必须是 tasks/issues/ideas/events/members。');
  output(io, selected);
  return selected.invalidFiles.length > 0 ? 2 : 0;
}

async function showRecord(id: string | undefined, options: Map<string, string | true>, io: Io): Promise<number> {
  if (!id) return fail(io, 'MISSING_ARGUMENT', '缺少记录 ID 或 GitHub username。');
  const repoRoot = path.resolve(option(options, '--repo') ?? io.cwd);
  const data = await collect(repoRoot);
  const all = [
    ...data.tasks.items,
    ...data.issues.items,
    ...data.ideas.items,
    ...data.events.items,
    ...data.members.items,
  ];
  const found = all.find((item) => {
    const record = item.data as { id?: string; githubUsername?: string };
    return record.id === id || record.githubUsername === id;
  });
  if (!found) return fail(io, 'NOT_FOUND', `未找到记录：${id}`, 1);
  output(io, { ok: true, record: found });
  return 0;
}

async function validateAll(options: Map<string, string | true>, io: Io): Promise<number> {
  const repoRoot = path.resolve(option(options, '--repo') ?? io.cwd);
  const data = await collect(repoRoot);
  const invalidFiles = [
    ...data.tasks.invalidFiles,
    ...data.issues.invalidFiles,
    ...data.ideas.invalidFiles,
    ...data.events.invalidFiles,
    ...data.members.invalidFiles,
  ].filter((item, index, all) => all.findIndex((candidate) => candidate.path === item.path) === index);
  const warnings = [
    ...data.tasks.warnings,
    ...data.issues.warnings,
    ...data.ideas.warnings,
    ...data.events.warnings,
    ...data.members.warnings,
  ];
  output(io, {
    ok: invalidFiles.length === 0,
    counts: {
      tasks: data.tasks.items.length,
      issues: data.issues.items.length,
      ideas: data.ideas.items.length,
      events: data.events.items.length,
      members: data.members.items.length,
    },
    invalidFiles,
    warnings,
  });
  return invalidFiles.length === 0 ? 0 : 2;
}

async function overview(options: Map<string, string | true>, io: Io): Promise<number> {
  const repoRoot = path.resolve(option(options, '--repo') ?? io.cwd);
  const data = await collect(repoRoot);
  const generatedAt = nowIso();
  const value = {
    schemaVersion: 1,
    generatedAt,
    members: data.members.items.map((item) => item.data),
    tasks: data.tasks.items.map((item) => item.data),
    issues: data.issues.items.map((item) => item.data),
    ideas: data.ideas.items.map((item) => ({ ...item.data, effectiveState: item.effectiveState })),
    recentEvents: data.events.items
      .map((item) => item.data)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 20),
    recentCommits: await createGitCore({ repoRoot }).listLog(10).catch(() => []),
    summary: {
      openTasks: data.tasks.items.filter((item) => item.data.status !== 'done').length,
      blockedTasks: data.tasks.items.filter((item) => item.data.status === 'blocked').length,
      openIssues: data.issues.items.filter((item) => item.data.status !== 'resolved').length,
      openIdeas: data.ideas.items.filter((item) => item.effectiveState === 'open').length,
    },
  };
  const outputPath = path.resolve(repoRoot, option(options, '--output') ?? '生成内容/当前总览.json');
  await atomicWriteJson(outputPath, value);
  const markdownPath = outputPath.replace(/\.json$/i, '.md');
  const markdown = [
    '# 当前协作总览',
    '',
    `生成时间：${generatedAt}`,
    '',
    `- 未完成任务：${value.summary.openTasks}`,
    `- 阻塞任务：${value.summary.blockedTasks}`,
    `- 未解决问题：${value.summary.openIssues}`,
    `- 待讨论想法：${value.summary.openIdeas}`,
    '',
    '## 当前任务',
    '',
    ...value.tasks.map((task) => `- [${task.status}] ${task.id} ${task.title}（${task.owner ?? '未分配'}）`),
    '',
    '## 当前问题',
    '',
    ...value.issues.map((issue) => `- [${issue.status}] ${issue.id} ${issue.title}（${issue.owner ?? '未分配'}）`),
    '',
    '## 想法',
    '',
    ...value.ideas.map((idea) => `- [${idea.effectiveState}] ${idea.id} ${idea.title}（${idea.author}）`),
    '',
  ].join('\n');
  await writeFile(markdownPath, `${markdown}\n`, 'utf8');
  output(io, { ok: true, json: path.relative(repoRoot, outputPath), markdown: path.relative(repoRoot, markdownPath), summary: value.summary });
  return 0;
}

function help(io: Io): number {
  io.writeStdout(`电赛协作 Agent CLI

用法：
  nuedc-agent action <动作> [--repo 路径] [--request JSON|从 stdin 读取]
  nuedc-agent init-member --username GitHub用户名 --roles hardware,firmware [--local]
  nuedc-agent list <tasks|issues|ideas|events|members>
  nuedc-agent show <ID或用户名>
  nuedc-agent validate
  nuedc-agent overview [--output 生成内容/当前总览.json]

动作：
  ${DOMAIN_ACTIONS.join('\n  ')}

说明：
  - 每次写操作都必须提供 16—128 字符的 --idempotency-key。
  - 更新动作还必须提供最新 --expected-revision。
  - --payload 接受 JSON；也可从 stdin 传完整 request JSON。
  - 领域动作不执行 Git，也不支持 --dry-run；安全 Git 请使用 scripts/git-safe.mjs。
`);
  return 0;
}

export async function main(argv = process.argv.slice(2), ioOverrides: Partial<Io> = {}): Promise<number> {
  const io: Io = { ...defaultIo, ...ioOverrides };
  try {
    const { positional, options } = parseArgs(argv);
    const command = positional[0];
    if (!command || command === 'help' || options.has('--help')) return help(io);
    if (command === 'action') {
      const action = positional[1] as DomainActionName | undefined;
      if (!action || !DOMAIN_ACTIONS.includes(action)) {
        return fail(io, 'ACTION_NOT_SUPPORTED', `不支持的动作：${action ?? ''}`);
      }
      return await runAction(action, options, io);
    }
    if (command === 'init-member') return await initMember(options, io);
    if (command === 'list') return await listRecords(positional[1] ?? '', options, io);
    if (command === 'show') return await showRecord(positional[1], options, io);
    if (command === 'validate') return await validateAll(options, io);
    if (command === 'overview') return await overview(options, io);
    return fail(io, 'UNKNOWN_COMMAND', `未知命令：${command}`);
  } catch (error) {
    return fail(io, 'CLI_ERROR', error instanceof Error ? error.message : String(error), 1);
  }
}

export async function runMappedAction(action: DomainActionName): Promise<void> {
  const code = await main(['action', action, ...process.argv.slice(2)]);
  process.exitCode = code;
}

const currentFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (currentFile === path.resolve(fileURLToPath(import.meta.url))) {
  main().then((code) => {
    process.exitCode = code;
  });
}
