export type TaskStatus = 'todo' | 'doing' | 'blocked' | 'review' | 'done';
export type IssueStatus = 'open' | 'investigating' | 'blocked' | 'resolved';
export type IdeaStatus = 'open' | 'discarded';
export type EventKind =
  | 'comment'
  | 'progress'
  | 'statusChange'
  | 'handoff'
  | 'decision'
  | 'testResult';
export type EntityType = 'task' | 'issue' | 'idea';
export type Priority = 'low' | 'medium' | 'high' | 'critical';
export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type MemberRole =
  | 'coordinator'
  | 'hardware'
  | 'firmware'
  | 'vision'
  | 'mechanical'
  | 'testing'
  | 'documentation';
export type MemberStatus = 'active' | 'inactive';
export type MotionLevel = 'system' | 'none' | 'reduced' | 'standard';
export type Channel = 'web' | 'server' | 'cli' | 'agent';

export type TaskId = `T-${string}`;
export type IssueId = `I-${string}`;
export type IdeaId = `A-${string}`;
export type EventId = `E-${string}`;

export type DomainActionName =
  | 'task.create'
  | 'task.update'
  | 'task.setStatus'
  | 'task.handoff'
  | 'issue.create'
  | 'issue.update'
  | 'issue.handoff'
  | 'event.append'
  | 'idea.create'
  | 'idea.update'
  | 'idea.promoteToTask'
  | 'member.update'
  | 'settings.update';

export interface Task {
  recordType: 'task';
  schemaVersion: 1;
  id: TaskId;
  title: string;
  module: string;
  status: TaskStatus;
  priority: Priority;
  owner?: string;
  participants: string[];
  dependencies: TaskId[];
  blockingIssueIds: IssueId[];
  relatedCommits: string[];
  description: string;
  acceptanceCriteria: string[];
  completedAcceptanceCriteria: string[];
  sourceIdeaId?: IdeaId;
  dueAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  recordType: 'issue';
  schemaVersion: 1;
  id: IssueId;
  title: string;
  status: IssueStatus;
  severity: Severity;
  owner?: string;
  blocking: boolean;
  linkedTaskIds: TaskId[];
  symptoms: string[];
  workaround: string;
  resolution: string;
  relatedCommits: string[];
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Idea {
  recordType: 'idea';
  schemaVersion: 1;
  id: IdeaId;
  title: string;
  status: IdeaStatus;
  author: string;
  owner?: string;
  module: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface Event {
  recordType: 'event';
  schemaVersion: 1;
  id: EventId;
  entityType: EntityType;
  entityId: string;
  kind: EventKind;
  actor: string;
  message: string;
  relatedCommit?: string;
  supersedesEventId?: EventId;
  createdAt: string;
}

export interface Member {
  recordType: 'member';
  schemaVersion: 1;
  githubUsername: string;
  roles: MemberRole[];
  responsibilities: string[];
  status: MemberStatus;
  createdAt: string;
  updatedAt: string;
}

export interface LocalSettings {
  schemaVersion: 1;
  githubUsername: string;
  port: number;
  autoFetchIntervalSeconds: number;
  motionLevel: MotionLevel;
  confirmGitWrites: true;
}

export interface ProtocolWarning {
  code: string;
  message: string;
  path?: string;
  id?: string;
}

export interface RecordEnvelope<T> {
  data: T;
  relativePath: string;
  revision: string;
}

export interface IdeaEnvelope extends RecordEnvelope<Idea> {
  effectiveState: 'open' | 'converted' | 'discarded';
}

export interface LoadResult<T> {
  items: T[];
  invalidFiles: Array<{ path: string; error: string }>;
  warnings: ProtocolWarning[];
}

export interface ActionCapability {
  action: DomainActionName;
  label: string;
  requiresRevision: boolean;
  requiresIdempotencyKey: true;
  schemaRef: string;
}

export interface CapabilityDocument {
  schemaVersion: 1;
  actor: string;
  actions: ActionCapability[];
  domAutomationAllowed: false;
  directFileMutationAllowed: false;
  gitConfirmationRequired: true;
}

export interface DomainActionRequest {
  idempotencyKey: string;
  expectedRevision?: string;
  payload: unknown;
}

export interface DomainActionResult {
  ok: boolean;
  action: DomainActionName;
  idempotencyKey: string;
  idempotentReplay: boolean;
  entities: Array<{
    recordType: 'task' | 'issue' | 'idea' | 'event' | 'member';
    id: string;
    relativePath: string;
    revision: string;
    updatedAt?: string;
  }>;
  warnings: ProtocolWarning[];
  nextActions: Array<{
    action: string;
    label: string;
    confirmationPolicy: 'human' | 'none';
  }>;
  error?: {
    code:
      | 'ACTION_VALIDATION_FAILED'
      | 'ACTION_NOT_SUPPORTED'
      | 'STALE_ENTITY'
      | 'IDEMPOTENCY_KEY_REUSED'
      | 'OWNER_MISMATCH'
      | 'INACTIVE_MEMBER'
      | 'PROMOTED_TASK_ALREADY_EXISTS';
    message: string;
  };
}

export interface DomainActionService {
  capabilities(channel: Channel): Promise<CapabilityDocument>;
  actionSchema(action: DomainActionName): object;
  execute(
    channel: Channel,
    action: DomainActionName,
    request: DomainActionRequest,
  ): Promise<DomainActionResult>;
}

export interface ProtocolRepository {
  listTasks(): Promise<LoadResult<RecordEnvelope<Task>>>;
  listIssues(): Promise<LoadResult<RecordEnvelope<Issue>>>;
  listIdeas(): Promise<LoadResult<IdeaEnvelope>>;
  listEvents(): Promise<LoadResult<RecordEnvelope<Event>>>;
  listMembers(): Promise<LoadResult<RecordEnvelope<Member>>>;
  readLocalSettings(): Promise<LocalSettings>;
  writeLocalSettings(settings: LocalSettings): Promise<void>;
}

export interface ProtocolRuntime {
  repository: ProtocolRepository;
  actions: DomainActionService;
}
