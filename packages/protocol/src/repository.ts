import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteJson, ensureDir, fileExists, readJsonFile } from './fs.js';
import { computeRevision } from './json.js';
import {
  getValidationError,
  validateEvent,
  validateIdea,
  validateIssue,
  validateLocalSettings,
  validateMember,
  validateTask,
} from './schemas.js';
import {
  detectTaskDependencyCycle,
  emptySnapshot,
  type ReferenceSnapshot,
  validateEventReferences,
  validateIdeaReferences,
  validateIssueReferences,
  validateTaskReferences,
} from './references.js';
import {
  eventPath,
  ideaPath,
  issuePath,
  localSettingsPath,
  memberPath,
  RELATIVE_DIRS,
  resolveRepoPath,
  taskPath,
  toPosixRelative,
} from './paths.js';
import type {
  Event,
  Idea,
  IdeaEnvelope,
  Issue,
  LoadResult,
  LocalSettings,
  Member,
  ProtocolRepository,
  ProtocolWarning,
  RecordEnvelope,
  Task,
} from './types.js';

async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => path.join(dir, e.name))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function envelope<T>(repoRoot: string, absolutePath: string, data: T): RecordEnvelope<T> {
  return {
    data,
    relativePath: toPosixRelative(repoRoot, absolutePath),
    revision: computeRevision(data),
  };
}

export class DomainRecordStore {
  constructor(readonly repoRoot: string) {}

  async ensureStructure(): Promise<void> {
    await Promise.all(
      [
        RELATIVE_DIRS.tasks,
        RELATIVE_DIRS.issues,
        RELATIVE_DIRS.ideas,
        RELATIVE_DIRS.events,
        RELATIVE_DIRS.members,
        RELATIVE_DIRS.templates,
        RELATIVE_DIRS.localSettings,
        RELATIVE_DIRS.actionReceipts,
      ].map((d) => ensureDir(resolveRepoPath(this.repoRoot, d))),
    );
  }

  async buildSnapshot(): Promise<{
    snapshot: ReferenceSnapshot;
    invalidFiles: Array<{ path: string; error: string }>;
  }> {
    const snapshot = emptySnapshot();
    const invalidFiles: Array<{ path: string; error: string }> = [];

    const loaders: Array<{
      dir: string;
      kind: 'task' | 'issue' | 'idea' | 'event' | 'member';
      validate: (data: unknown) => boolean;
      put: (data: any) => void;
      expectedName: (data: any) => string;
      schemaKey: 'task' | 'issue' | 'idea' | 'event' | 'member';
    }> = [
      {
        dir: resolveRepoPath(this.repoRoot, RELATIVE_DIRS.tasks),
        kind: 'task',
        schemaKey: 'task',
        validate: validateTask,
        put: (d: Task) => snapshot.tasks.set(d.id, d),
        expectedName: (d: Task) => `${d.id}.json`,
      },
      {
        dir: resolveRepoPath(this.repoRoot, RELATIVE_DIRS.issues),
        kind: 'issue',
        schemaKey: 'issue',
        validate: validateIssue,
        put: (d: Issue) => snapshot.issues.set(d.id, d),
        expectedName: (d: Issue) => `${d.id}.json`,
      },
      {
        dir: resolveRepoPath(this.repoRoot, RELATIVE_DIRS.ideas),
        kind: 'idea',
        schemaKey: 'idea',
        validate: validateIdea,
        put: (d: Idea) => snapshot.ideas.set(d.id, d),
        expectedName: (d: Idea) => `${d.id}.json`,
      },
      {
        dir: resolveRepoPath(this.repoRoot, RELATIVE_DIRS.events),
        kind: 'event',
        schemaKey: 'event',
        validate: validateEvent,
        put: (d: Event) => snapshot.events.set(d.id, d),
        expectedName: (d: Event) => `${d.id}.json`,
      },
      {
        dir: resolveRepoPath(this.repoRoot, RELATIVE_DIRS.members),
        kind: 'member',
        schemaKey: 'member',
        validate: validateMember,
        put: (d: Member) => snapshot.members.set(d.githubUsername, d),
        expectedName: (d: Member) => `${d.githubUsername}.json`,
      },
    ];

    for (const loader of loaders) {
      const files = await listJsonFiles(loader.dir);
      for (const file of files) {
        const rel = toPosixRelative(this.repoRoot, file);
        try {
          const data = await readJsonFile(file);
          if (!loader.validate(data)) {
            invalidFiles.push({
              path: rel,
              error: getValidationError(loader.schemaKey, data) ?? 'Schema 校验失败',
            });
            continue;
          }
          const base = path.basename(file);
          if (base !== loader.expectedName(data)) {
            invalidFiles.push({
              path: rel,
              error: `文件名与记录 ID 不一致，期望 ${loader.expectedName(data)}`,
            });
            continue;
          }
          loader.put(data);
        } catch (error) {
          invalidFiles.push({
            path: rel,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return { snapshot, invalidFiles };
  }

  async writeTask(task: Task): Promise<RecordEnvelope<Task>> {
    return this.writeRecord(
      'task',
      task,
      taskPath(this.repoRoot, task.id),
      (s) => validateTaskReferences(task, s),
    );
  }

  async writeIssue(issue: Issue): Promise<RecordEnvelope<Issue>> {
    return this.writeRecord(
      'issue',
      issue,
      issuePath(this.repoRoot, issue.id),
      (s) => validateIssueReferences(issue, s),
    );
  }

  async writeIdea(idea: Idea): Promise<RecordEnvelope<Idea>> {
    return this.writeRecord(
      'idea',
      idea,
      ideaPath(this.repoRoot, idea.id),
      (s) => validateIdeaReferences(idea, s),
    );
  }

  async writeEvent(event: Event): Promise<RecordEnvelope<Event>> {
    const absolute = eventPath(this.repoRoot, event.id);
    if (await fileExists(absolute)) {
      throw new Error(`事件不可变，已存在: ${event.id}`);
    }
    return this.writeRecord(
      'event',
      event,
      absolute,
      (s) => validateEventReferences(event, s),
    );
  }

  async writeMember(member: Member): Promise<RecordEnvelope<Member>> {
    const absolute = memberPath(this.repoRoot, member.githubUsername);
    if (!validateMember(member)) {
      throw new Error(getValidationError('member', member) ?? '成员 Schema 校验失败');
    }
    await atomicWriteJson(absolute, member);
    return envelope(this.repoRoot, absolute, member);
  }

  private async writeRecord<T extends Task | Issue | Idea | Event>(
    kind: 'task' | 'issue' | 'idea' | 'event',
    data: T,
    absolute: string,
    refCheck: (snapshot: ReferenceSnapshot) => { errors: string[]; warnings: ProtocolWarning[] },
  ): Promise<RecordEnvelope<T>> {
    const validators = {
      task: validateTask,
      issue: validateIssue,
      idea: validateIdea,
      event: validateEvent,
    } as const;
    if (!validators[kind](data as never)) {
      throw new Error(getValidationError(kind, data) ?? 'Schema 校验失败');
    }
    const { snapshot } = await this.buildSnapshot();
    if (kind === 'task') snapshot.tasks.set((data as Task).id, data as Task);
    if (kind === 'issue') snapshot.issues.set((data as Issue).id, data as Issue);
    if (kind === 'idea') snapshot.ideas.set((data as Idea).id, data as Idea);
    if (kind === 'event') snapshot.events.set((data as Event).id, data as Event);

    const { errors } = refCheck(snapshot);
    if (kind === 'task') {
      errors.push(...detectTaskDependencyCycle(snapshot));
    }
    if (errors.length > 0) {
      throw new Error(errors.join('; '));
    }
    await atomicWriteJson(absolute, data);
    return envelope(this.repoRoot, absolute, data);
  }

  async readLocalSettings(): Promise<LocalSettings> {
    const file = localSettingsPath(this.repoRoot);
    if (!(await fileExists(file))) {
      throw new Error('本机设置不存在: .本机配置/settings.json');
    }
    const data = await readJsonFile(file);
    if (!validateLocalSettings(data)) {
      throw new Error(getValidationError('localSettings', data) ?? '本机设置 Schema 校验失败');
    }
    return data;
  }

  async writeLocalSettings(settings: LocalSettings): Promise<void> {
    if (!validateLocalSettings(settings)) {
      throw new Error(getValidationError('localSettings', settings) ?? '本机设置 Schema 校验失败');
    }
    await atomicWriteJson(localSettingsPath(this.repoRoot), settings);
  }
}

export async function createProtocolRepository(repoRoot: string): Promise<ProtocolRepository> {
  const store = new DomainRecordStore(repoRoot);
  await store.ensureStructure();

  return {
    async listTasks() {
      const { snapshot, invalidFiles } = await store.buildSnapshot();
      const warnings: ProtocolWarning[] = [];
      const items: RecordEnvelope<Task>[] = [];
      for (const task of [...snapshot.tasks.values()].sort((a, b) => a.id.localeCompare(b.id))) {
        warnings.push(...validateTaskReferences(task, snapshot).warnings);
        items.push(envelope(repoRoot, taskPath(repoRoot, task.id), task));
      }
      for (const err of detectTaskDependencyCycle(snapshot)) {
        warnings.push({ code: 'TASK_DEPENDENCY_CYCLE', message: err });
      }
      return { items, invalidFiles, warnings };
    },
    async listIssues() {
      const { snapshot, invalidFiles } = await store.buildSnapshot();
      const warnings: ProtocolWarning[] = [];
      const items: RecordEnvelope<Issue>[] = [];
      for (const issue of [...snapshot.issues.values()].sort((a, b) => a.id.localeCompare(b.id))) {
        warnings.push(...validateIssueReferences(issue, snapshot).warnings);
        items.push(envelope(repoRoot, issuePath(repoRoot, issue.id), issue));
      }
      return { items, invalidFiles, warnings };
    },
    async listIdeas() {
      const { snapshot, invalidFiles } = await store.buildSnapshot();
      const warnings: ProtocolWarning[] = [];
      const converted = new Set<string>();
      for (const task of snapshot.tasks.values()) {
        if (task.sourceIdeaId) converted.add(task.sourceIdeaId);
      }
      const items: IdeaEnvelope[] = [];
      for (const idea of [...snapshot.ideas.values()].sort((a, b) => a.id.localeCompare(b.id))) {
        warnings.push(...validateIdeaReferences(idea, snapshot).warnings);
        const effectiveState = converted.has(idea.id)
          ? 'converted'
          : idea.status === 'discarded'
            ? 'discarded'
            : 'open';
        items.push({
          ...envelope(repoRoot, ideaPath(repoRoot, idea.id), idea),
          effectiveState,
        });
      }
      return { items, invalidFiles, warnings };
    },
    async listEvents() {
      const { snapshot, invalidFiles } = await store.buildSnapshot();
      const warnings: ProtocolWarning[] = [];
      const items: RecordEnvelope<Event>[] = [];
      for (const event of [...snapshot.events.values()].sort((a, b) => a.id.localeCompare(b.id))) {
        warnings.push(...validateEventReferences(event, snapshot).warnings);
        items.push(envelope(repoRoot, eventPath(repoRoot, event.id), event));
      }
      return { items, invalidFiles, warnings };
    },
    async listMembers() {
      const { snapshot, invalidFiles } = await store.buildSnapshot();
      const items: RecordEnvelope<Member>[] = [];
      for (const member of [...snapshot.members.values()].sort((a, b) =>
        a.githubUsername.localeCompare(b.githubUsername),
      )) {
        items.push(envelope(repoRoot, memberPath(repoRoot, member.githubUsername), member));
      }
      return { items, invalidFiles, warnings: [] };
    },
    readLocalSettings: () => store.readLocalSettings(),
    writeLocalSettings: (settings) => store.writeLocalSettings(settings),
  };
}

export { envelope };
