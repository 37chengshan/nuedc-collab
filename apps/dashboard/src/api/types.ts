export const ACTION_NAMES = [
  "task.create",
  "task.update",
  "task.setStatus",
  "task.handoff",
  "issue.create",
  "issue.update",
  "issue.handoff",
  "event.append",
  "idea.create",
  "idea.update",
  "idea.promoteToTask",
  "member.update",
  "settings.update",
] as const;

export type DomainActionName = (typeof ACTION_NAMES)[number];

export const ROUTE_PATHS = [
  "/",
  "/tasks",
  "/issues",
  "/ideas",
  "/history",
  "/materials",
  "/design",
  "/settings",
] as const;

export type RoutePath = (typeof ROUTE_PATHS)[number];

export interface WarningItem {
  code: string;
  message: string;
  target?: string;
}

export interface RecordEnvelope<T = Record<string, unknown>> {
  data: T;
  relativePath: string;
  revision: string;
  effectiveState?: string;
}

export interface ListResponse<T> {
  items: Array<RecordEnvelope<T>>;
  warnings: WarningItem[];
}

export interface ActionRequest {
  idempotencyKey: string;
  expectedRevision?: string;
  payload: Record<string, unknown>;
}

export interface ActionEntityRef {
  recordType: "task" | "issue" | "idea" | "event" | "member" | "settings";
  id: string;
  relativePath: string;
  revision: string;
  updatedAt?: string;
}

export interface NextAction {
  action: DomainActionName | "git.commit" | "git.pull" | "git.push" | string;
  label: string;
  confirmationPolicy: "none" | "human";
}

export interface ActionSuccess {
  ok: true;
  action: DomainActionName;
  idempotencyKey: string;
  idempotentReplay: boolean;
  entities: ActionEntityRef[];
  warnings: WarningItem[];
  nextActions: NextAction[];
}

export interface ActionFailure {
  ok: false;
  code:
    | "ACTION_VALIDATION_FAILED"
    | "ACTION_NOT_SUPPORTED"
    | "STALE_ENTITY"
    | "IDEMPOTENCY_KEY_REUSED"
    | "OWNER_MISMATCH"
    | "INACTIVE_MEMBER"
    | "PROMOTED_TASK_ALREADY_EXISTS"
    | string;
  action: DomainActionName;
  idempotencyKey: string;
  error: { impact: string; nextStep: string; details: string };
  latestEntity?: RecordEnvelope;
  warnings: WarningItem[];
  nextActions: NextAction[];
}

export interface CapabilitiesAction {
  name: DomainActionName;
  description: string;
  requiresRevision: boolean;
  requiresIdempotencyKey: true;
  schemaRef: string;
}

export interface CapabilitiesResponse {
  protocolVersion: 1;
  actor: string;
  actions: CapabilitiesAction[];
  domAutomationAllowed: false;
  directFileMutationAllowed: false;
  gitConfirmationRequired: true;
}

export interface GitState {
  worktree: "clean" | "dirty" | "conflict";
  topology: "unborn" | "noRemote" | "synced" | "ahead" | "behind" | "diverged";
  connection: "online" | "networkError" | "authError";
  head: string | null;
  remoteHead: string | null;
  ahead: number;
  behind: number;
  branch?: string;
  severity:
    | "conflict"
    | "unborn"
    | "noRemote"
    | "networkError"
    | "authError"
    | "diverged"
    | "behind"
    | "ahead"
    | "dirty"
    | "clean";
  lastCheckedAt: string;
  dirtyFiles?: string[];
  conflictFiles?: string[];
  summary?: string;
}

export type GitWizardKind = "pull" | "commit" | "push";
export type GitWizardStep = "view" | "fill" | "review" | "confirm" | "result";

export interface LocalSettings {
  schemaVersion?: 1;
  githubUsername: string;
  port: number;
  autoFetchIntervalSeconds: number;
  motionLevel: "system" | "none" | "reduced" | "standard";
  confirmGitWrites: true;
}

export type TaskStatus = "todo" | "doing" | "blocked" | "review" | "done";
export type TaskPriority = "low" | "medium" | "high" | "critical";
export type TaskBoardColumn = "todo" | "doing" | "review" | "done";

export interface TaskRecord {
  recordType: "task";
  schemaVersion: 1;
  id: string;
  title: string;
  module: string;
  status: TaskStatus;
  priority: TaskPriority;
  owner?: string;
  participants: string[];
  dependencies: string[];
  blockingIssueIds: string[];
  relatedCommits: string[];
  description: string;
  acceptanceCriteria: string[];
  completedAcceptanceCriteria: string[];
  sourceIdeaId?: string;
  dueAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type IssueStatus = "open" | "investigating" | "blocked" | "resolved";
export type IssueSeverity = "low" | "medium" | "high" | "critical";

export interface IssueRecord {
  recordType: "issue";
  schemaVersion: 1;
  id: string;
  title: string;
  status: IssueStatus;
  severity: IssueSeverity;
  owner?: string;
  blocking: boolean;
  linkedTaskIds: string[];
  symptoms: string[];
  workaround: string;
  resolution: string;
  description?: string;
  relatedCommits: string[];
  createdAt: string;
  updatedAt: string;
}

export type IdeaStatus = "open" | "discarded";

export interface IdeaRecord {
  recordType: "idea";
  schemaVersion: 1;
  id: string;
  title: string;
  status: IdeaStatus;
  author: string;
  owner?: string;
  module: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export type EventKind = "comment" | "progress" | "statusChange" | "handoff" | "decision" | "testResult";

export interface EventRecord {
  recordType: "event";
  schemaVersion: 1;
  id: string;
  entityType: "task" | "issue" | "idea";
  entityId: string;
  kind: EventKind;
  actor: string;
  message: string;
  relatedCommit?: string;
  supersedesEventId?: string;
  createdAt: string;
}

export interface MemberRecord {
  recordType: "member";
  schemaVersion: 1;
  githubUsername: string;
  roles: string[];
  responsibilities: string[];
  status: "active" | "inactive";
  createdAt: string;
  updatedAt: string;
}

export interface MaterialItem {
  id: string;
  title: string;
  type: "notice" | "hardware" | "tutorial" | "externalRepository" | "document";
  relativePath: string;
  sourceLabel: string;
  versionLabel?: string;
  modules: string[];
  verificationStatus: "verified" | "pending" | "archived" | "outdated";
  updatedAt: string;
  sizeBytes: number;
  sha256?: string;
  previewMode: "text" | "sandboxHtml" | "image" | "pdf" | "downloadOnly";
}

export interface MaterialsResponse {
  items: MaterialItem[];
  warnings: WarningItem[];
}

export interface DesignEntry {
  id: string;
  title: string;
  category: "赛题分析" | "总体方案" | "接口约定" | "测试记录" | "可视化页面";
  relativePath: string;
  format: "markdown" | "html" | "json";
  updatedAt: string;
  previewMode?: "text" | "sandboxHtml" | "image" | "pdf" | "downloadOnly";
}

export interface DesignCanvasNode {
  id: string;
  title?: string;
  label?: string;
  responsibility: string;
  inputs: string[];
  outputs: string[];
  status: string;
  x: number;
  y: number;
}

export interface DesignCanvasEdge {
  id?: string;
  from: string;
  to: string;
  label?: string;
}

export interface DesignCanvas {
  sourcePath?: string;
  nodes: DesignCanvasNode[];
  edges: DesignCanvasEdge[];
}

export interface DesignResponse {
  entries: DesignEntry[];
  canvas: DesignCanvas | null;
  context: {
    issueIds: string[];
    materialIds: string[];
    decisionEventIds: string[];
  };
  warnings: WarningItem[];
}

export interface DesignContentResponse {
  path: string;
  contentType: string;
  body: string;
}

export interface CommitItem {
  hash: string;
  shortHash: string;
  author: string;
  committedAt: string;
  subject: string;
  body?: string;
  files?: string[];
  relatedTaskIds?: string[];
}

export interface GitLogResponse {
  items: CommitItem[];
  warnings?: WarningItem[];
}

export interface GitDiffResponse {
  files: Array<{ path: string; status: string; additions?: number; deletions?: number }>;
  patch?: string;
  changesHash?: string;
}

export interface HealthResponse {
  ok: true;
  actor?: string;
  sessionRequired?: boolean;
  localAuthToken?: string;
  version?: string;
}

export interface GitWriteRequest {
  confirmed: true;
  expectedHead: string | null;
  expectedRemoteHead?: string | null;
  expectedChangesHash?: string;
  files?: string[];
  message?: string;
}

export interface GitWriteResult {
  ok: boolean;
  operation: "pull" | "commit" | "push" | "fetch";
  state: GitState;
  summary: string;
  technicalDetails?: string;
  code?: string;
  impact?: string;
  nextStep?: string;
}
