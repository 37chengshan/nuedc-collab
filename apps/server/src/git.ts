import {
  GitError,
  createGitCore,
  hashSelectedChanges,
  type ConnectionState,
  type GitCore,
  type GitState as CoreGitState,
} from "@nuedc/git-core";

export interface ApiGitState {
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

export interface GitWriteResult {
  ok: boolean;
  operation: "pull" | "commit" | "push" | "fetch";
  state: ApiGitState;
  summary: string;
  technicalDetails?: string;
  code?: string;
  impact?: string;
  nextStep?: string;
}

function summarizeGitState(state: CoreGitState): string {
  if (state.worktree === "conflict") return `存在 ${state.conflictPaths.length} 个冲突文件`;
  if (state.topology === "diverged") return "本地与远端历史已分叉";
  if (state.topology === "behind") return `落后远端 ${state.behind} 个提交`;
  if (state.topology === "ahead") return `领先远端 ${state.ahead} 个提交`;
  if (state.topology === "noRemote") return "未配置 origin/main";
  if (state.topology === "unborn") return "仓库尚无提交";
  if (state.worktree === "dirty") return `工作区有 ${state.dirtyPaths.length} 个改动`;
  if (state.connection === "authError") return "Git 认证失败";
  if (state.connection === "networkError") return "Git 网络异常";
  return "仓库状态正常";
}

export function mapGitState(state: CoreGitState): ApiGitState {
  return {
    worktree: state.worktree,
    topology: state.topology,
    connection: state.connection,
    head: state.head,
    remoteHead: state.remoteHead,
    ahead: state.ahead,
    behind: state.behind,
    ...(state.branch ? { branch: state.branch } : {}),
    severity: state.severity,
    lastCheckedAt: state.lastCheckedAt,
    ...(state.dirtyPaths.length > 0 ? { dirtyFiles: state.dirtyPaths } : {}),
    ...(state.conflictPaths.length > 0 ? { conflictFiles: state.conflictPaths } : {}),
    summary: summarizeGitState(state),
  };
}

function gitErrorMeta(code: GitError["code"]): { status: number; impact: string; nextStep: string } {
  switch (code) {
    case "STALE_GIT_STATE":
      return {
        status: 409,
        impact: "确认后文件或 Git 状态发生了变化，本次操作没有执行。",
        nextStep: "点击“刷新状态并重新确认”。提交说明和文件选择会保留，刷新后再次点击确认即可。",
      };
    case "PREEXISTING_STAGED_CHANGES":
      return { status: 409, impact: "索引区已有暂存内容，当前操作被拒绝。", nextStep: "先处理已有暂存内容，再重新执行确认流程。" };
    case "DIVERGED_HISTORY":
      return { status: 409, impact: "本地与远端历史已分叉，禁止自动继续。", nextStep: "停止自动操作，改为人工处理分叉。" };
    case "DIRTY_WORKTREE":
      return { status: 409, impact: "工作区不干净，当前 Git 写操作被拒绝。", nextStep: "先提交、清理或放弃改动后再重试。" };
    case "CONFLICT_PRESENT":
      return { status: 409, impact: "工作区存在冲突，自动 Git 写操作已停止。", nextStep: "先人工解决冲突并确认状态。" };
    case "NETWORK_ERROR":
      return { status: 503, impact: "Git 网络不可用，远端状态不可信。", nextStep: "检查网络后重新执行 fetch/pull/push。" };
    case "GIT_AUTH_ERROR":
      return { status: 401, impact: "Git 认证失败，无法安全访问远端。", nextStep: "检查凭据或 SSH 登录状态后重试。" };
    case "NO_REMOTE":
      return { status: 400, impact: "仓库未配置可用远端。", nextStep: "先配置 origin/main，再执行该操作。" };
    case "UNBORN_HEAD":
      return { status: 409, impact: "仓库还没有初始提交，当前操作不成立。", nextStep: "先创建首个提交，再继续。" };
    case "GIT_OUTPUT_TOO_LARGE":
      return { status: 413, impact: "Git 输出过大，服务拒绝直接返回。", nextStep: "缩小范围后重新查询。" };
    case "INVALID_GIT_REQUEST":
      return { status: 400, impact: "Git 请求参数不合法或不满足安全前提。", nextStep: "检查确认字段、文件列表和当前状态后重试。" };
    case "GIT_COMMAND_FAILED":
    default:
      return { status: 500, impact: "Git 命令执行失败。", nextStep: "查看技术详情并人工检查仓库状态。" };
  }
}

async function inspectSafe(git: GitCore, connection?: ConnectionState): Promise<CoreGitState> {
  try {
    return await git.inspect(connection ? { connection } : undefined);
  } catch {
    return {
      worktree: "dirty",
      topology: "noRemote",
      connection: connection ?? "networkError",
      head: null,
      remoteHead: null,
      ahead: 0,
      behind: 0,
      branch: null,
      remoteName: null,
      severity: connection === "authError" ? "authError" : "networkError",
      dirtyPaths: [],
      conflictPaths: [],
      lastCheckedAt: new Date().toISOString(),
    };
  }
}

export function createGitApi(repoRoot: string) {
  const git = createGitCore({ repoRoot });

  return {
    core: git,
    async status(): Promise<ApiGitState> {
      return mapGitState(await git.inspect());
    },
    async log() {
      const items = await git.listLog(50);
      return {
        items: items.map((item) => ({
          hash: item.sha,
          shortHash: item.shortSha,
          author: item.authorName,
          committedAt: item.committedAt,
          subject: item.subject,
        })),
        warnings: [],
      };
    },
    async diff(commit?: string, selectedFiles?: string[]) {
      const diffFiles = await git.readDiff(commit ? { commit } : undefined);
      if (!commit) {
        const changes = await git.listChanges();
        const selected = selectedFiles ? changes.filter((change) => selectedFiles.includes(change.path)) : changes;
        const patch = selectedFiles ? undefined : diffFiles.find((file) => typeof file.patch === "string")?.patch;
        return {
          files: selected.map((file) => ({ path: file.path, status: file.status })),
          ...(patch ? { patch } : {}),
          changesHash: hashSelectedChanges(selected),
        };
      }
      const patch = diffFiles.find((file) => typeof file.patch === "string")?.patch;
      return {
        files: diffFiles
          .filter((file) => !selectedFiles || selectedFiles.includes(file.path))
          .map((file) => ({ path: file.path, status: file.status })),
        ...(patch ? { patch } : {}),
      };
    },
    async fetch(): Promise<GitWriteResult> {
      try {
        const state = await git.fetch();
        return {
          ok: true,
          operation: "fetch",
          state: mapGitState(state),
          summary: "远端状态已刷新",
        };
      } catch (error) {
        throw await mapGitError(git, "fetch", error);
      }
    },
    async pull(request: { confirmed?: true; expectedHead?: string | null; expectedRemoteHead?: string | null }): Promise<GitWriteResult> {
      if (request.confirmed !== true) {
        const state = await inspectSafe(git);
        return {
          ok: false,
          operation: "pull",
          state: mapGitState(state),
          code: "GIT_CONFIRMATION_REQUIRED",
          impact: "Git 写操作必须经过人工五步确认。",
          nextStep: "返回确认页复核 HEAD、远端状态和工作区后再执行。",
          summary: "缺少 confirmed: true，已拒绝执行",
        };
      }
      try {
        const result = await git.pullFastForward({
          confirmed: true,
          expectedHead: requireSha(request.expectedHead, "expectedHead"),
          expectedRemoteHead: requireSha(request.expectedRemoteHead, "expectedRemoteHead"),
        });
        return {
          ok: true,
          operation: "pull",
          state: mapGitState(result.state),
          summary: result.message ?? "快进拉取成功",
        };
      } catch (error) {
        throw await mapGitError(git, "pull", error);
      }
    },
    async commit(request: {
      confirmed?: true;
      expectedHead?: string | null;
      expectedChangesHash?: string;
      files?: string[];
      message?: string;
    }): Promise<GitWriteResult> {
      if (request.confirmed !== true) {
        const state = await inspectSafe(git);
        return {
          ok: false,
          operation: "commit",
          state: mapGitState(state),
          code: "GIT_CONFIRMATION_REQUIRED",
          impact: "Git 写操作必须经过人工五步确认。",
          nextStep: "返回确认页复核文件、摘要和提交信息后再执行。",
          summary: "缺少 confirmed: true，已拒绝执行",
        };
      }
      try {
        const result = await git.commitSelected({
          confirmed: true,
          expectedHead: requireSha(request.expectedHead, "expectedHead"),
          expectedChangesHash: requireDigest(request.expectedChangesHash, "expectedChangesHash"),
          files: Array.isArray(request.files) ? request.files : [],
          message: typeof request.message === "string" ? request.message : "",
        });
        return {
          ok: true,
          operation: "commit",
          state: mapGitState(result.state),
          summary: result.message ?? "提交成功",
        };
      } catch (error) {
        throw await mapGitError(git, "commit", error);
      }
    },
    async push(request: { confirmed?: true; expectedHead?: string | null; expectedRemoteHead?: string | null }): Promise<GitWriteResult> {
      if (request.confirmed !== true) {
        const state = await inspectSafe(git);
        return {
          ok: false,
          operation: "push",
          state: mapGitState(state),
          code: "GIT_CONFIRMATION_REQUIRED",
          impact: "Git 写操作必须经过人工五步确认。",
          nextStep: "返回确认页复核 HEAD、远端 HEAD 和工作区后再执行。",
          summary: "缺少 confirmed: true，已拒绝执行",
        };
      }
      try {
        const result = await git.push({
          confirmed: true,
          expectedHead: requireSha(request.expectedHead, "expectedHead"),
          expectedRemoteHead: requireSha(request.expectedRemoteHead, "expectedRemoteHead"),
        });
        return {
          ok: true,
          operation: "push",
          state: mapGitState(result.state),
          summary: result.message ?? "推送成功",
        };
      } catch (error) {
        throw await mapGitError(git, "push", error);
      }
    },
  };
}

function requireSha(value: string | null | undefined, field: string): string {
  if (!value || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new GitError("INVALID_GIT_REQUEST", `${field} 必须是 40 位十六进制 SHA。`);
  }
  return value;
}

function requireDigest(value: string | undefined, field: string): string {
  if (!value || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new GitError("INVALID_GIT_REQUEST", `${field} 必须是 64 位十六进制摘要。`);
  }
  return value;
}

async function mapGitError(
  git: GitCore,
  operation: GitWriteResult["operation"],
  error: unknown,
): Promise<{ status: number; body: GitWriteResult }> {
  if (error instanceof GitError) {
    const connection = (error as { state?: CoreGitState }).state?.connection;
    const state = (error as { state?: CoreGitState }).state ?? (await inspectSafe(git, connection));
    const meta = gitErrorMeta(error.code);
    return {
      status: meta.status,
      body: {
        ok: false,
        operation,
        state: mapGitState(state),
        code: error.code,
        impact: meta.impact,
        nextStep: meta.nextStep,
        summary: error.message,
        ...(error.technicalDetails ? { technicalDetails: error.technicalDetails } : {}),
      },
    };
  }

  const state = await inspectSafe(git);
  return {
    status: 500,
    body: {
      ok: false,
      operation,
      state: mapGitState(state),
      code: "GIT_COMMAND_FAILED",
      impact: "Git 操作发生未预期异常。",
      nextStep: "查看服务端技术详情并人工检查仓库状态。",
      summary: error instanceof Error ? error.message : String(error),
    },
  };
}
