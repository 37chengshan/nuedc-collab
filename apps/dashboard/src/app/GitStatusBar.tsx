import { formatRelativeTime, shortHash } from "@/lib/format";
import type { GitState } from "@/api/types";
import { canCommit, canPull, canPush } from "@/lib/git-policy";
import { GitSeverityBadge } from "@/components/GitSeverityBadge";
import { Button } from "@/components/Button";
import { ChevronDown, ChevronUp, GitBranch } from "lucide-react";
import { cn } from "@/lib/format";

export function GitStatusBar({
  state,
  onOpenWizard,
  onFetch,
  fetching,
  sidebarCollapsed,
  expanded,
  onToggle,
}: {
  state?: GitState;
  onOpenWizard: (kind: "pull" | "commit" | "push") => void;
  onFetch?: () => void;
  fetching?: boolean;
  sidebarCollapsed: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (!state) {
    return sidebarCollapsed ? (
      <div className="grid h-10 place-items-center text-faint" title="正在读取 Git 状态">
        <GitBranch className="h-4 w-4" />
      </div>
    ) : <p className="px-1 py-2 text-xs text-subtle">正在读取 Git 状态…</p>;
  }

  const pull = canPull(state);
  const commit = canCommit(state);
  const push = canPush(state);

  if (sidebarCollapsed) {
    return (
      <button
        type="button"
        className="relative grid h-10 w-full place-items-center rounded-control text-subtle hover:bg-muted hover:text-body"
        onClick={onToggle}
        aria-label="展开仓库同步"
        title={state.summary || `Git ${state.severity}`}
      >
        <GitBranch className="h-[18px] w-[18px]" />
        <span
          className={cn(
            "absolute end-2 top-2 h-2 w-2 rounded-full ring-2 ring-sidebar",
            state.severity === "conflict" ? "bg-danger" : state.severity === "ahead" ? "bg-orange" : "bg-success",
          )}
        />
      </button>
    );
  }

  return (
    <section aria-label="仓库同步状态" className="min-w-0">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-control px-1 py-1.5 text-start hover:bg-muted"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={expanded ? "收起仓库同步" : "展开仓库同步"}
      >
        <GitSeverityBadge severity={state.severity} />
        <span className="min-w-0 flex-1 truncate text-xs text-subtle">{state.summary || `Git ${state.topology}`}</span>
        {expanded ? <ChevronUp className="h-4 w-4 text-faint" /> : <ChevronDown className="h-4 w-4 text-faint" />}
      </button>

      {expanded ? (
        <div className="mt-2 space-y-2 border-t border-border pt-2">
          <div className="flex items-center gap-2 px-1 font-mono text-[11px] text-faint">
            <span>{shortHash(state.head)}</span>
            <span>{state.branch ?? "无分支"}</span>
            <span className="ms-auto font-body">检查于 {formatRelativeTime(state.lastCheckedAt)}</span>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <Button variant="secondary" size="sm" loading={fetching} onClick={onFetch}>检查</Button>
            <Button variant="secondary" size="sm" disabled={!pull.allowed} title={pull.reason} onClick={() => onOpenWizard("pull")}>拉取</Button>
            <Button variant="secondary" size="sm" disabled={!commit.allowed} title={commit.reason} onClick={() => onOpenWizard("commit")}>提交</Button>
            <Button variant="primary" size="sm" disabled={!push.allowed} title={push.reason} onClick={() => onOpenWizard("push")}>推送</Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
