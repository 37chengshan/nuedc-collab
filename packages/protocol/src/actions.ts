import { DOMAIN_ACTIONS, getActionSchema, validateActionRequest } from './schemas.js';
import { generateEventId, generateIdeaId, generateIssueId, generateTaskId, nowIso } from './ids.js';
import { computeRequestHash, computeRevision, sha256Hex } from './json.js';
import { atomicWriteJson, fileExists, readJsonFile, withRepositoryWriteLock } from './fs.js';
import { actionReceiptPath } from './paths.js';
import { DomainRecordStore, envelope } from './repository.js';
import type {
  Channel,
  CapabilityDocument,
  DomainActionName,
  DomainActionRequest,
  DomainActionResult,
  DomainActionService,
  Event,
  Idea,
  Issue,
  LocalSettings,
  Member,
  RecordEnvelope,
  Task,
  TaskId,
  IssueId,
  IdeaId,
} from './types.js';

const ACTION_LABELS: Record<DomainActionName, string> = {
  'task.create': '创建任务',
  'task.update': '更新任务',
  'task.setStatus': '设置任务状态',
  'task.handoff': '交接任务',
  'issue.create': '创建问题',
  'issue.update': '更新问题',
  'issue.handoff': '交接问题',
  'event.append': '追加事件',
  'idea.create': '创建想法',
  'idea.update': '更新想法',
  'idea.promoteToTask': '想法提升为任务',
  'member.update': '更新成员',
  'settings.update': '更新本机设置',
};

const REQUIRES_REVISION = new Set<DomainActionName>([
  'task.update',
  'task.setStatus',
  'task.handoff',
  'issue.update',
  'issue.handoff',
  'idea.update',
  'idea.promoteToTask',
  'member.update',
]);

const EXTERNAL_EVENT_KINDS = new Set(['comment', 'progress', 'decision', 'testResult']);

interface Receipt {
  requestHash: string;
  result: DomainActionResult;
}

function fail(
  action: DomainActionName,
  key: string,
  code: NonNullable<DomainActionResult['error']>['code'],
  message: string,
  entities: DomainActionResult['entities'] = [],
): DomainActionResult {
  return {
    ok: false,
    action,
    idempotencyKey: key,
    idempotentReplay: false,
    entities,
    warnings: [],
    nextActions: [],
    error: { code, message },
  };
}

function success(
  action: DomainActionName,
  key: string,
  entities: DomainActionResult['entities'],
  extras?: Partial<DomainActionResult>,
): DomainActionResult {
  return {
    ok: true,
    action,
    idempotencyKey: key,
    idempotentReplay: false,
    entities,
    warnings: [],
    nextActions: [],
    ...extras,
  };
}

function entityFromEnvelope(
  recordType: 'task' | 'issue' | 'idea' | 'event' | 'member',
  env: RecordEnvelope<any>,
): DomainActionResult['entities'][number] {
  const id =
    recordType === 'member' ? env.data.githubUsername : env.data.id;
  return {
    recordType,
    id,
    relativePath: env.relativePath,
    revision: env.revision,
    updatedAt: env.data.updatedAt,
  };
}

function setsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((x) => sb.has(x));
}

export function createDomainActionService(
  repoRoot: string,
  store: DomainRecordStore,
): DomainActionService {
  let chain: Promise<unknown> = Promise.resolve();

  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function loadActor(): Promise<{ actor: string; member: Member; settings: LocalSettings }> {
    const settings = await store.readLocalSettings();
    const { snapshot } = await store.buildSnapshot();
    const member = snapshot.members.get(settings.githubUsername);
    if (!member) {
      throw new Error(`本机成员不存在: ${settings.githubUsername}`);
    }
    if (member.status !== 'active') {
      const err = new Error(`本机成员未激活: ${settings.githubUsername}`);
      (err as any).code = 'INACTIVE_MEMBER';
      throw err;
    }
    return { actor: settings.githubUsername, member, settings };
  }

  async function readReceipt(key: string): Promise<Receipt | null> {
    const file = actionReceiptPath(repoRoot, sha256Hex(key));
    if (!(await fileExists(file))) return null;
    return readJsonFile<Receipt>(file);
  }

  async function writeReceipt(key: string, receipt: Receipt): Promise<void> {
    await atomicWriteJson(actionReceiptPath(repoRoot, sha256Hex(key)), receipt);
  }

  async function requireActiveMember(username: string): Promise<Member> {
    const { snapshot } = await store.buildSnapshot();
    const member = snapshot.members.get(username);
    if (!member) throw new Error(`成员不存在: ${username}`);
    if (member.status !== 'active') {
      const err = new Error(`成员未激活: ${username}`);
      (err as any).code = 'INACTIVE_MEMBER';
      throw err;
    }
    return member;
  }

  function assertRevision<T>(
    env: RecordEnvelope<T> | null,
    expected: string | undefined,
    action: DomainActionName,
    key: string,
    recordType: 'task' | 'issue' | 'idea' | 'event' | 'member',
  ): DomainActionResult | null {
    if (!env) {
      return fail(action, key, 'STALE_ENTITY', '目标记录不存在');
    }
    if (!expected || expected !== env.revision) {
      return fail(action, key, 'STALE_ENTITY', '记录 revision 已过期，请重新读取后重试', [
        entityFromEnvelope(recordType, env),
      ]);
    }
    return null;
  }

  async function findTask(id: string): Promise<RecordEnvelope<Task> | null> {
    const { snapshot } = await store.buildSnapshot();
    const task = snapshot.tasks.get(id);
    if (!task) return null;
    const { taskPath } = await import('./paths.js');
    return envelope(repoRoot, taskPath(repoRoot, task.id), task);
  }

  async function findIssue(id: string): Promise<RecordEnvelope<Issue> | null> {
    const { snapshot } = await store.buildSnapshot();
    const issue = snapshot.issues.get(id);
    if (!issue) return null;
    const { issuePath } = await import('./paths.js');
    return envelope(repoRoot, issuePath(repoRoot, issue.id), issue);
  }

  async function findIdea(id: string): Promise<RecordEnvelope<Idea> | null> {
    const { snapshot } = await store.buildSnapshot();
    const idea = snapshot.ideas.get(id);
    if (!idea) return null;
    const { ideaPath } = await import('./paths.js');
    return envelope(repoRoot, ideaPath(repoRoot, idea.id), idea);
  }

  async function findMember(username: string): Promise<RecordEnvelope<Member> | null> {
    const { snapshot } = await store.buildSnapshot();
    const member = snapshot.members.get(username);
    if (!member) return null;
    const { memberPath } = await import('./paths.js');
    return envelope(repoRoot, memberPath(repoRoot, member.githubUsername), member);
  }

  async function appendSystemEvent(input: {
    entityType: 'task' | 'issue' | 'idea';
    entityId: string;
    kind: 'statusChange' | 'handoff';
    actor: string;
    message: string;
  }): Promise<RecordEnvelope<Event>> {
    const event: Event = {
      recordType: 'event',
      schemaVersion: 1,
      id: (await generateEventId(repoRoot)) as Event['id'],
      entityType: input.entityType,
      entityId: input.entityId,
      kind: input.kind,
      actor: input.actor,
      message: input.message,
      createdAt: nowIso(),
    };
    return store.writeEvent(event);
  }

  async function executeInner(
    channel: Channel,
    action: DomainActionName,
    request: DomainActionRequest,
  ): Promise<DomainActionResult> {
    const validated = validateActionRequest(action, request);
    if (!validated.ok) {
      return fail(action, String((request as any)?.idempotencyKey ?? 'invalid'), 'ACTION_VALIDATION_FAILED', validated.message);
    }
    const req = validated.value;
    const requestHash = computeRequestHash({
      action,
      channel,
      ...(req.expectedRevision === undefined
        ? {}
        : { expectedRevision: req.expectedRevision }),
      payload: req.payload,
    });

    const existing = await readReceipt(req.idempotencyKey);
    if (existing) {
      if (existing.requestHash === requestHash) {
        return { ...existing.result, idempotentReplay: true };
      }
      return fail(
        action,
        req.idempotencyKey,
        'IDEMPOTENCY_KEY_REUSED',
        '相同幂等键已用于不同请求',
      );
    }

    let actorInfo: { actor: string; member: Member; settings: LocalSettings };
    try {
      actorInfo = await loadActor();
    } catch (error) {
      const code = (error as any).code === 'INACTIVE_MEMBER' ? 'INACTIVE_MEMBER' : 'ACTION_VALIDATION_FAILED';
      return fail(action, req.idempotencyKey, code, error instanceof Error ? error.message : String(error));
    }
    const { actor, settings } = actorInfo;
    const payload = req.payload as any;
    const ts = nowIso();

    try {
      let result: DomainActionResult;

      switch (action) {
        case 'task.create': {
          if (payload.owner) await requireActiveMember(payload.owner);
          const id = (await generateTaskId(repoRoot)) as TaskId;
          const task: Task = {
            recordType: 'task',
            schemaVersion: 1,
            id,
            title: payload.title,
            module: payload.module,
            status: 'todo',
            priority: payload.priority,
            participants: payload.participants ?? [],
            dependencies: payload.dependencies ?? [],
            blockingIssueIds: payload.blockingIssueIds ?? [],
            relatedCommits: [],
            description: payload.description ?? '',
            acceptanceCriteria: payload.acceptanceCriteria ?? [],
            completedAcceptanceCriteria: [],
            createdAt: ts,
            updatedAt: ts,
          };
          if (payload.owner) task.owner = payload.owner;
          if (payload.dueAt) task.dueAt = payload.dueAt;
          const env = await store.writeTask(task);
          result = success(action, req.idempotencyKey, [entityFromEnvelope('task', env)]);
          break;
        }
        case 'task.update': {
          const current = await findTask(payload.id);
          const stale = assertRevision(current, req.expectedRevision, action, req.idempotencyKey, 'task');
          if (stale) return stale;
          const task = { ...current!.data };
          if (payload.owner !== undefined) await requireActiveMember(payload.owner);
          if (payload.title !== undefined) task.title = payload.title;
          if (payload.module !== undefined) task.module = payload.module;
          if (payload.priority !== undefined) task.priority = payload.priority;
          if (payload.owner !== undefined) task.owner = payload.owner;
          if (payload.description !== undefined) task.description = payload.description;
          if (payload.acceptanceCriteria !== undefined) task.acceptanceCriteria = payload.acceptanceCriteria;
          if (payload.completedAcceptanceCriteria !== undefined) {
            task.completedAcceptanceCriteria = payload.completedAcceptanceCriteria;
          }
          if (payload.dueAt !== undefined) task.dueAt = payload.dueAt;
          if (payload.participants !== undefined) task.participants = payload.participants;
          if (payload.dependencies !== undefined) task.dependencies = payload.dependencies;
          if (payload.blockingIssueIds !== undefined) task.blockingIssueIds = payload.blockingIssueIds;
          if (payload.relatedCommits !== undefined) task.relatedCommits = payload.relatedCommits;
          task.updatedAt = ts;
          const env = await store.writeTask(task);
          result = success(action, req.idempotencyKey, [entityFromEnvelope('task', env)]);
          break;
        }
        case 'task.setStatus': {
          const current = await findTask(payload.id);
          const stale = assertRevision(current, req.expectedRevision, action, req.idempotencyKey, 'task');
          if (stale) return stale;
          const task = { ...current!.data };
          if (payload.to === 'done' && !setsEqual(task.acceptanceCriteria, task.completedAcceptanceCriteria)) {
            return fail(
              action,
              req.idempotencyKey,
              'ACTION_VALIDATION_FAILED',
              '完成任务前验收条件必须全部勾选且集合相等',
            );
          }
          const from = task.status;
          task.status = payload.to;
          task.updatedAt = ts;
          const env = await store.writeTask(task);
          const eventEnv = await appendSystemEvent({
            entityType: 'task',
            entityId: task.id,
            kind: 'statusChange',
            actor,
            message: payload.message ?? `状态从 ${from} 变更为 ${payload.to}`,
          });
          result = success(action, req.idempotencyKey, [
            entityFromEnvelope('task', env),
            entityFromEnvelope('event', eventEnv),
          ]);
          break;
        }
        case 'task.handoff': {
          const current = await findTask(payload.id);
          const stale = assertRevision(current, req.expectedRevision, action, req.idempotencyKey, 'task');
          if (stale) return stale;
          const task = { ...current!.data };
          await requireActiveMember(payload.toOwner);
          const fromOwner = task.owner ?? '未分配';
          task.owner = payload.toOwner;
          task.updatedAt = ts;
          const env = await store.writeTask(task);
          const eventEnv = await appendSystemEvent({
            entityType: 'task',
            entityId: task.id,
            kind: 'handoff',
            actor,
            message: payload.message ?? `任务从 ${fromOwner} 交接给 ${payload.toOwner}`,
          });
          result = success(action, req.idempotencyKey, [
            entityFromEnvelope('task', env),
            entityFromEnvelope('event', eventEnv),
          ]);
          break;
        }
        case 'issue.create': {
          if (payload.owner) await requireActiveMember(payload.owner);
          const id = (await generateIssueId(repoRoot)) as IssueId;
          const issue: Issue = {
            recordType: 'issue',
            schemaVersion: 1,
            id,
            title: payload.title,
            status: 'open',
            severity: payload.severity,
            blocking: payload.blocking,
            linkedTaskIds: payload.linkedTaskIds ?? [],
            symptoms: payload.symptoms ?? [],
            workaround: payload.workaround ?? '',
            resolution: '',
            relatedCommits: [],
            createdAt: ts,
            updatedAt: ts,
          };
          if (payload.owner) issue.owner = payload.owner;
          if (payload.description) issue.description = payload.description;
          const env = await store.writeIssue(issue);
          result = success(action, req.idempotencyKey, [entityFromEnvelope('issue', env)]);
          break;
        }
        case 'issue.update': {
          const current = await findIssue(payload.id);
          const stale = assertRevision(current, req.expectedRevision, action, req.idempotencyKey, 'issue');
          if (stale) return stale;
          const issue = { ...current!.data };
          if (payload.owner !== undefined) await requireActiveMember(payload.owner);
          if (payload.title !== undefined) issue.title = payload.title;
          if (payload.status !== undefined) issue.status = payload.status;
          if (payload.severity !== undefined) issue.severity = payload.severity;
          if (payload.owner !== undefined) issue.owner = payload.owner;
          if (payload.blocking !== undefined) issue.blocking = payload.blocking;
          if (payload.symptoms !== undefined) issue.symptoms = payload.symptoms;
          if (payload.workaround !== undefined) issue.workaround = payload.workaround;
          if (payload.resolution !== undefined) issue.resolution = payload.resolution;
          if (payload.description !== undefined) issue.description = payload.description;
          if (payload.linkedTaskIds !== undefined) issue.linkedTaskIds = payload.linkedTaskIds;
          if (payload.relatedCommits !== undefined) issue.relatedCommits = payload.relatedCommits;
          issue.updatedAt = ts;
          const env = await store.writeIssue(issue);
          result = success(action, req.idempotencyKey, [entityFromEnvelope('issue', env)]);
          break;
        }
        case 'issue.handoff': {
          const current = await findIssue(payload.id);
          const stale = assertRevision(current, req.expectedRevision, action, req.idempotencyKey, 'issue');
          if (stale) return stale;
          const issue = { ...current!.data };
          await requireActiveMember(payload.toOwner);
          const fromOwner = issue.owner ?? '未分配';
          issue.owner = payload.toOwner;
          issue.updatedAt = ts;
          const env = await store.writeIssue(issue);
          const eventEnv = await appendSystemEvent({
            entityType: 'issue',
            entityId: issue.id,
            kind: 'handoff',
            actor,
            message: payload.message ?? `问题从 ${fromOwner} 交接给 ${payload.toOwner}`,
          });
          result = success(action, req.idempotencyKey, [
            entityFromEnvelope('issue', env),
            entityFromEnvelope('event', eventEnv),
          ]);
          break;
        }
        case 'event.append': {
          if (!EXTERNAL_EVENT_KINDS.has(payload.kind)) {
            return fail(
              action,
              req.idempotencyKey,
              'ACTION_VALIDATION_FAILED',
              `外部渠道不允许追加 ${payload.kind} 事件，仅系统动作可生成 statusChange/handoff`,
            );
          }
          const event: Event = {
            recordType: 'event',
            schemaVersion: 1,
            id: (await generateEventId(repoRoot)) as Event['id'],
            entityType: payload.entityType,
            entityId: payload.entityId,
            kind: payload.kind,
            actor,
            message: payload.message,
            createdAt: ts,
          };
          if (payload.relatedCommit) event.relatedCommit = payload.relatedCommit;
          if (payload.supersedesEventId) event.supersedesEventId = payload.supersedesEventId;
          const env = await store.writeEvent(event);
          result = success(action, req.idempotencyKey, [entityFromEnvelope('event', env)]);
          break;
        }
        case 'idea.create': {
          if (payload.owner) await requireActiveMember(payload.owner);
          const id = (await generateIdeaId(repoRoot)) as IdeaId;
          const idea: Idea = {
            recordType: 'idea',
            schemaVersion: 1,
            id,
            title: payload.title,
            status: 'open',
            author: actor,
            module: payload.module,
            description: payload.description ?? '',
            createdAt: ts,
            updatedAt: ts,
          };
          if (payload.owner) idea.owner = payload.owner;
          const env = await store.writeIdea(idea);
          result = success(action, req.idempotencyKey, [entityFromEnvelope('idea', env)]);
          break;
        }
        case 'idea.update': {
          const current = await findIdea(payload.id);
          const stale = assertRevision(current, req.expectedRevision, action, req.idempotencyKey, 'idea');
          if (stale) return stale;
          const idea = { ...current!.data };
          if (payload.title !== undefined) idea.title = payload.title;
          if (payload.status !== undefined) idea.status = payload.status;
          if (payload.module !== undefined) idea.module = payload.module;
          if (payload.description !== undefined) idea.description = payload.description;
          if (payload.owner !== undefined) {
            await requireActiveMember(payload.owner);
            idea.owner = payload.owner;
          }
          idea.updatedAt = ts;
          const env = await store.writeIdea(idea);
          result = success(action, req.idempotencyKey, [entityFromEnvelope('idea', env)]);
          break;
        }
        case 'idea.promoteToTask': {
          const current = await findIdea(payload.ideaId);
          const stale = assertRevision(current, req.expectedRevision, action, req.idempotencyKey, 'idea');
          if (stale) return stale;
          const idea = current!.data;
          const { snapshot } = await store.buildSnapshot();
          const existingTask = [...snapshot.tasks.values()].find((t) => t.sourceIdeaId === idea.id);
          if (existingTask) {
            const { taskPath } = await import('./paths.js');
            const env = envelope(repoRoot, taskPath(repoRoot, existingTask.id), existingTask);
            result = success(
              action,
              req.idempotencyKey,
              [entityFromEnvelope('task', env)],
              {
                warnings: [
                  {
                    code: 'PROMOTED_TASK_ALREADY_EXISTS',
                    message: '该想法已提升为任务，返回既有任务',
                    id: existingTask.id,
                  },
                ],
              },
            );
            // Treat as recoverable success per plan; still cache receipt.
            break;
          }
          if (payload.owner) await requireActiveMember(payload.owner);
          const id = (await generateTaskId(repoRoot)) as TaskId;
          const task: Task = {
            recordType: 'task',
            schemaVersion: 1,
            id,
            title: payload.title,
            module: payload.module,
            status: 'todo',
            priority: payload.priority,
            participants: [],
            dependencies: [],
            blockingIssueIds: [],
            relatedCommits: [],
            description: payload.description ?? idea.description,
            acceptanceCriteria: payload.acceptanceCriteria ?? [],
            completedAcceptanceCriteria: [],
            sourceIdeaId: idea.id,
            createdAt: ts,
            updatedAt: ts,
          };
          if (payload.owner) task.owner = payload.owner;
          const env = await store.writeTask(task);
          result = success(action, req.idempotencyKey, [entityFromEnvelope('task', env)]);
          break;
        }
        case 'member.update': {
          const current = await findMember(payload.githubUsername);
          const stale = assertRevision(current, req.expectedRevision, action, req.idempotencyKey, 'member');
          if (stale) return stale;
          const member = { ...current!.data };
          if (payload.roles !== undefined) member.roles = payload.roles;
          if (payload.responsibilities !== undefined) member.responsibilities = payload.responsibilities;
          if (payload.status !== undefined) member.status = payload.status;
          member.updatedAt = ts;
          const env = await store.writeMember(member);
          result = success(action, req.idempotencyKey, [entityFromEnvelope('member', env)]);
          break;
        }
        case 'settings.update': {
          const next: LocalSettings = {
            ...settings,
            githubUsername: payload.githubUsername ?? settings.githubUsername,
            port: payload.port ?? settings.port,
            autoFetchIntervalSeconds:
              payload.autoFetchIntervalSeconds ?? settings.autoFetchIntervalSeconds,
            motionLevel: payload.motionLevel ?? settings.motionLevel,
            confirmGitWrites: true,
          };
          await requireActiveMember(next.githubUsername);
          await store.writeLocalSettings(next);
          result = success(action, req.idempotencyKey, []);
          break;
        }
        default:
          return fail(action, req.idempotencyKey, 'ACTION_NOT_SUPPORTED', `不支持的动作: ${action}`);
      }

      await writeReceipt(req.idempotencyKey, { requestHash, result });
      return result;
    } catch (error) {
      const code =
        (error as any).code === 'OWNER_MISMATCH'
          ? 'OWNER_MISMATCH'
          : (error as any).code === 'INACTIVE_MEMBER'
            ? 'INACTIVE_MEMBER'
            : 'ACTION_VALIDATION_FAILED';
      return fail(action, req.idempotencyKey, code, error instanceof Error ? error.message : String(error));
    }
  }

  return {
    async capabilities(channel: Channel): Promise<CapabilityDocument> {
      let actor = "未配置";
      try {
        ({ actor } = await loadActor());
      } catch {
        // 新克隆仓库尚未创建 .本机配置/settings.json 时也必须能读取能力清单。
        // 实际写动作仍会通过 executeInner 调用 loadActor 并拒绝未配置身份。
      }
      return {
        schemaVersion: 1,
        actor,
        actions: DOMAIN_ACTIONS.map((action) => ({
          action,
          label: ACTION_LABELS[action],
          requiresRevision: REQUIRES_REVISION.has(action),
          requiresIdempotencyKey: true as const,
          schemaRef: `action:${action}`,
        })),
        domAutomationAllowed: false,
        directFileMutationAllowed: false,
        gitConfirmationRequired: true,
      };
    },
    actionSchema(action: DomainActionName): object {
      return getActionSchema(action);
    },
    execute(channel, action, request) {
      return withLock(async () => {
        try {
          return await withRepositoryWriteLock(repoRoot, () => executeInner(channel, action, request));
        } catch (error) {
          return fail(
            action,
            String((request as any)?.idempotencyKey ?? 'invalid'),
            'ACTION_VALIDATION_FAILED',
            error instanceof Error ? error.message : String(error),
          );
        }
      });
    },
  };
}
