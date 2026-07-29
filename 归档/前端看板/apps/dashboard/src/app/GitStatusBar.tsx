import { formatRelativeTime, shortHash } from "@/lib/format";
import type { GitState } from "@/api/types";
import { canCommit, canPull, canPush } from "@/lib/git-policy";
import { GitSeverityBadge } from "@/components/GitSeverityBadge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";

export function GitStatusBar({
  state,
  onOpenWizard,
  onFetch,
  fetching,
}: {
  state?: GitState;
  onOpenWizard: (kind: "pull" | "commit" | "push") => void;
  onFetch?: () => void;
  fetching?: boolean;
}) {
  if (!state) {
    return (
      <Card className="border-border bg-surface py-3">
        <p className="text-sm text-subtle">正在读取 Git 状态…</p>
      </Card>
    );
  }

  const pull = canPull(state);
  const commit = canCommit(state);
  const push = canPush(state);

  return (
    <Card className="flex flex-col gap-3 border-border bg-surface py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <GitSeverityBadge severity={state.severity} />
          <span className="font-mono text-xs text-subtle">{shortHash(state.head)}</span>
          {state.branch ? <span className="text-xs text-subtle">{state.branch}</span> : null}
          <span className="text-xs text-faint">检查于 {formatRelativeTime(state.lastCheckedAt)}</span>
        </div>
        <p className="text-sm text-body">{state.summary || `工作区 ${state.worktree} · 拓扑 ${state.topology} · 连接 ${state.connection}`}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" loading={fetching} onClick={onFetch}>
          检查远端
        </Button>
        <Button variant="secondary" size="sm" disabled={!pull.allowed} title={pull.reason} onClick={() => onOpenWizard("pull")}>
          拉取
        </Button>
        <Button variant="secondary" size="sm" disabled={!commit.allowed} title={commit.reason} onClick={() => onOpenWizard("commit")}>
          提交
        </Button>
        <Button variant="primary" size="sm" disabled={!push.allowed} title={push.reason} onClick={() => onOpenWizard("push")}>
          推送
        </Button>
      </div>
    </Card>
  );
}
