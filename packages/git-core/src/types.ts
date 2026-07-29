export type WorktreeState = 'clean' | 'dirty' | 'conflict';
export type TopologyState =
  | 'unborn'
  | 'noRemote'
  | 'synced'
  | 'ahead'
  | 'behind'
  | 'diverged';
export type ConnectionState = 'online' | 'networkError' | 'authError';

export type GitSeverity =
  | 'conflict'
  | 'unborn'
  | 'noRemote'
  | 'networkError'
  | 'authError'
  | 'diverged'
  | 'behind'
  | 'ahead'
  | 'dirty'
  | 'clean';

export interface GitState {
  worktree: WorktreeState;
  topology: TopologyState;
  connection: ConnectionState;
  head: string | null;
  remoteHead: string | null;
  ahead: number;
  behind: number;
  branch: string | null;
  remoteName: 'origin' | null;
  severity: GitSeverity;
  dirtyPaths: string[];
  conflictPaths: string[];
  lastCheckedAt: string;
}

export type GitErrorCode =
  | 'STALE_GIT_STATE'
  | 'PREEXISTING_STAGED_CHANGES'
  | 'DIVERGED_HISTORY'
  | 'NETWORK_ERROR'
  | 'GIT_AUTH_ERROR'
  | 'NO_REMOTE'
  | 'UNBORN_HEAD'
  | 'GIT_OUTPUT_TOO_LARGE'
  | 'GIT_COMMAND_FAILED'
  | 'INVALID_GIT_REQUEST'
  | 'DIRTY_WORKTREE'
  | 'CONFLICT_PRESENT';

export class GitError extends Error {
  readonly code: GitErrorCode;
  readonly technicalDetails: string;

  constructor(code: GitErrorCode, message: string, technicalDetails = '') {
    super(message);
    this.name = 'GitError';
    this.code = code;
    this.technicalDetails = technicalDetails;
  }
}

export type GitOperationName =
  | 'status'
  | 'revParseHead'
  | 'revParseRemote'
  | 'revList'
  | 'log'
  | 'diff'
  | 'diffCached'
  | 'lsFiles'
  | 'hashObject'
  | 'fetch'
  | 'mergeFfOnly'
  | 'add'
  | 'commit'
  | 'push'
  | 'show'
  | 'symbolicRef';

export interface GitInvocation {
  args: string[];
  options: {
    shell: false;
    env: Record<string, string>;
    timeoutMs: number;
    maxOutputBytes: number;
  };
}

export interface SelectedChange {
  path: string;
  status: string;
  contentHash: string;
}

export interface PullRequest {
  expectedHead: string;
  expectedRemoteHead: string;
  confirmed: true;
}

export interface CommitRequest {
  files: string[];
  message: string;
  expectedHead: string;
  expectedChangesHash: string;
  confirmed: true;
}

export interface PushRequest {
  expectedHead: string;
  expectedRemoteHead: string;
  confirmed: true;
}

export interface GitOperationResult {
  ok: true;
  state: GitState;
  commit?: string;
  message?: string;
}

export interface GitLogEntry {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  committedAt: string;
  parents: string[];
}

export interface GitDiffFile {
  path: string;
  status: string;
  patch?: string;
}

export interface GitCore {
  inspect(options?: { connection?: ConnectionState }): Promise<GitState>;
  listChanges(): Promise<SelectedChange[]>;
  listLog(limit?: number): Promise<GitLogEntry[]>;
  readDiff(options?: { commit?: string; path?: string }): Promise<GitDiffFile[]>;
  fetch(): Promise<GitState>;
  pullFastForward(request: PullRequest): Promise<GitOperationResult>;
  commitSelected(request: CommitRequest): Promise<GitOperationResult>;
  push(request: PushRequest): Promise<GitOperationResult>;
}
