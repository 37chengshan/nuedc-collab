import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getGitDiff,
  getGitStatus,
  postGitCommit,
  postGitPull,
  postGitPush,
} from "@/api/resources";
import type { GitState, GitWizardKind, GitWizardStep, GitWriteResult } from "@/api/types";
import { ApiError } from "@/api/http";
import { canCommit, canPull, canPush } from "@/lib/git-policy";
import { shortHash } from "@/lib/format";
import { Dialog } from "@/components/Dialog";
import { Button } from "@/components/Button";
import { TextArea } from "@/components/TextArea";
import { LoadingState } from "@/components/LoadingState";
import { ErrorState } from "@/components/ErrorState";
import { Badge } from "@/components/Badge";
import { useToast } from "@/components/Toast";

const STEPS: GitWizardStep[] = ["view", "fill", "review", "confirm", "result"];

const TITLES: Record<GitWizardKind, string> = {
  pull: "快进拉取",
  commit: "创建本地提交",
  push: "推送到 origin/main",
};

const CONFIRM_LABEL: Record<GitWizardKind, string> = {
  pull: "确认快进拉取",
  commit: "确认创建本地提交",
  push: "确认推送到 origin/main",
};

function stepLabel(step: GitWizardStep): string {
  return ({ view: "查看", fill: "填写", review: "复核", confirm: "确认", result: "结果" } as const)[step];
}

export function GitConfirmWizard({
  kind,
  open,
  onClose,
}: {
  kind: GitWizardKind;
  open: boolean;
  onClose: () => void;
}) {
  const { push } = useToast();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<GitWizardStep>("view");
  const [snapshot, setSnapshot] = useState<GitState | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [result, setResult] = useState<{
    ok: boolean;
    code?: string;
    impact?: string;
    nextStep?: string;
    summary?: string;
    state?: GitState;
  } | null>(null);

  const statusQuery = useQuery({
    queryKey: ["git-status", "wizard", kind],
    queryFn: getGitStatus,
    enabled: open,
    retry: false,
  });

  const diffQuery = useQuery({
    queryKey: ["git-diff", "wizard", kind],
    queryFn: () => getGitDiff(),
    enabled: open && (kind === "commit" || step === "view"),
    retry: false,
  });

  useEffect(() => {
    if (!open) return;
    setStep("view");
    setFiles([]);
    setMessage("");
    setAcknowledged(false);
    setResult(null);
    setSnapshot(null);
  }, [open, kind]);

  useEffect(() => {
    if (statusQuery.data && !snapshot) setSnapshot(statusQuery.data);
  }, [statusQuery.data, snapshot]);

  const dirtyFiles = useMemo(() => {
    const fromState = snapshot?.dirtyFiles || [];
    const fromDiff = (diffQuery.data?.files || []).map((f) => f.path);
    return Array.from(new Set([...fromState, ...fromDiff]));
  }, [snapshot, diffQuery.data]);

  useEffect(() => {
    if (kind === "commit" && dirtyFiles.length && files.length === 0 && step === "fill") {
      setFiles(dirtyFiles.slice(0, 200));
    }
  }, [kind, dirtyFiles, files.length, step]);

  const policy = useMemo(() => {
    if (!snapshot) return { allowed: false, reason: "正在读取 Git 状态…" };
    if (kind === "pull") return canPull(snapshot);
    if (kind === "commit") return canCommit(snapshot);
    return canPush(snapshot);
  }, [kind, snapshot]);

  const writeMutation = useMutation({
    mutationFn: async () => {
      if (!snapshot) throw new Error("缺少 Git 快照");
      const body = {
        confirmed: true as const,
        expectedHead: snapshot.head,
        expectedRemoteHead: snapshot.remoteHead,
        expectedChangesHash: diffQuery.data?.changesHash,
        files: kind === "commit" ? files : undefined,
        message: kind === "commit" ? message.trim() : undefined,
      };
      if (kind === "pull") return postGitPull(body);
      if (kind === "commit") return postGitCommit(body);
      return postGitPush(body);
    },
    onSuccess: (data: GitWriteResult) => {
      setResult({
        ok: data.ok !== false,
        code: data.code,
        impact: data.impact,
        nextStep: data.nextStep,
        summary: data.summary,
        state: data.state,
      });
      setStep("result");
      void queryClient.invalidateQueries({ queryKey: ["git-status"] });
      void queryClient.invalidateQueries({ queryKey: ["git-log"] });
      if (data.ok !== false) {
        push({ title: `${TITLES[kind]}成功`, description: data.summary, tone: "success" });
      }
    },
    onError: (err: unknown) => {
      const api = err instanceof ApiError ? err : null;
      setResult({
        ok: false,
        code: api?.code || "GIT_WRITE_FAILED",
        impact: api?.impact || (err as Error)?.message || "Git 写操作失败",
        nextStep: api?.nextStep || "关闭向导并重新查看摘要，不要自动重试",
      });
      setStep("result");
      push({
        title: `${TITLES[kind]}已停止`,
        description: api?.impact || "请按结果页指引处理",
        tone: "danger",
      });
    },
  });

  const goNext = () => {
    const idx = STEPS.indexOf(step);
    if (idx < 0 || idx >= STEPS.length - 1) return;
    const next = STEPS[idx + 1]!;
    if (next === "result") return;
    if (step === "fill" && kind === "commit") {
      if (files.length < 1 || files.length > 200) {
        push({ title: "请选择 1—200 个文件", tone: "warning" });
        return;
      }
      if (message.trim().length < 1 || message.trim().length > 500) {
        push({ title: "提交说明需 1—500 字", tone: "warning" });
        return;
      }
    }
    if (step === "confirm") {
      if (!acknowledged) {
        push({ title: "请先勾选“我已阅读影响”", tone: "warning" });
        return;
      }
      writeMutation.mutate();
      return;
    }
    setStep(next);
  };

  const goBack = () => {
    const idx = STEPS.indexOf(step);
    if (idx <= 0 || step === "result") return;
    setStep(STEPS[idx - 1]!);
  };

  const toggleFile = (path: string) => {
    setFiles((prev) => (prev.includes(path) ? prev.filter((p) => p !== path) : prev.length >= 200 ? prev : [...prev, path]));
  };

  return (
    <Dialog
      open={open}
      title={TITLES[kind]}
      description="查看 → 填写 → 复核 → 确认 → 结果。写操作仅在确认步发送，且必须带 confirmed 与期望状态。"
      onClose={onClose}
      size="lg"
      footer={
        step === "result" ? (
          <Button variant="primary" onClick={onClose}>
            关闭向导
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              取消
            </Button>
            {step !== "view" ? (
              <Button variant="ghost" onClick={goBack} disabled={writeMutation.isPending}>
                上一步
              </Button>
            ) : null}
            <Button
              variant="primary"
              loading={writeMutation.isPending}
              disabled={step === "view" && !policy.allowed}
              onClick={goNext}
            >
              {step === "confirm" ? CONFIRM_LABEL[kind] : step === "review" ? "进入确认" : "下一步"}
            </Button>
          </>
        )
      }
    >
      <ol className="flex flex-wrap gap-2" aria-label="Git 确认步骤">
        {STEPS.map((s) => (
          <li key={s}>
            <Badge tone={s === step ? "orange" : STEPS.indexOf(s) < STEPS.indexOf(step) ? "success" : "neutral"}>
              {stepLabel(s)}
            </Badge>
          </li>
        ))}
      </ol>

      {statusQuery.isLoading && !snapshot ? <LoadingState label="正在加载 Git 状态…" /> : null}
      {statusQuery.isError ? (
        <ErrorState
          impact={(statusQuery.error as Error)?.message || "无法读取 Git 状态"}
          nextStep="确认本地服务已启动后重试"
          onRetry={() => void statusQuery.refetch()}
        />
      ) : null}

      {snapshot && step === "view" ? (
        <div className="space-y-3">
          <p className="text-sm text-body">
            工作区 <strong>{snapshot.worktree}</strong> · 拓扑 <strong>{snapshot.topology}</strong> · 连接{" "}
            <strong>{snapshot.connection}</strong>
          </p>
          <p className="font-mono text-xs text-subtle">
            HEAD {shortHash(snapshot.head)} · remote {shortHash(snapshot.remoteHead)} · ahead {snapshot.ahead} / behind{" "}
            {snapshot.behind}
          </p>
          {!policy.allowed ? (
            <ErrorState title="当前不可执行" impact={policy.reason || "条件不满足"} nextStep="关闭向导并先处理前置条件" />
          ) : (
            <p className="text-sm text-success">条件满足，可继续填写与确认。</p>
          )}
          {diffQuery.data?.files?.length ? (
            <div className="max-h-48 overflow-auto rounded-control border border-border bg-surface p-3">
              <p className="mb-2 text-sm font-medium text-ink">改动文件（只读）</p>
              <ul className="space-y-1 font-mono text-xs text-body">
                {diffQuery.data.files.map((f) => (
                  <li key={f.path}>
                    {f.status} {f.path}
                    {f.additions != null ? ` +${f.additions}` : ""}
                    {f.deletions != null ? ` -${f.deletions}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {step === "fill" ? (
        <div className="space-y-4">
          {kind === "commit" ? (
            <>
              <div className="max-h-56 overflow-auto rounded-control border border-border bg-surface p-3">
                <p className="mb-2 text-sm font-medium text-ink">选择要提交的文件（1—200）</p>
                {dirtyFiles.length === 0 ? (
                  <p className="text-sm text-subtle">没有检测到改动文件。</p>
                ) : (
                  <ul className="space-y-2">
                    {dirtyFiles.map((path) => (
                      <li key={path}>
                        <label className="flex items-start gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="mt-1"
                            checked={files.includes(path)}
                            onChange={() => toggleFile(path)}
                          />
                          <span className="break-all font-mono text-xs">{path}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <TextArea
                label="提交说明"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                maxLength={500}
                hint={`${message.trim().length}/500`}
                placeholder="用一句中文说明这次本地提交的目的"
              />
            </>
          ) : (
            <div className="rounded-control border border-border bg-surface p-4 text-sm text-body">
              <p>目标固定为 <strong className="font-mono">origin/main</strong>，不支持自由分支输入。</p>
              <p className="mt-2 text-subtle">
                将使用当前快照 expectedHead={shortHash(snapshot?.head)} / expectedRemoteHead=
                {shortHash(snapshot?.remoteHead)}。
              </p>
            </div>
          )}
        </div>
      ) : null}

      {step === "review" || step === "confirm" ? (
        <div className="space-y-3 text-sm text-body">
          <p>操作：{TITLES[kind]}</p>
          <p>影响范围：{kind === "commit" ? `${files.length} 个文件` : kind === "pull" ? `落后 ${snapshot?.behind ?? 0} 个提交` : `领先 ${snapshot?.ahead ?? 0} 个提交`}</p>
          <p className="font-mono text-xs">
            expectedHead={snapshot?.head || "null"}
            <br />
            expectedRemoteHead={snapshot?.remoteHead || "null"}
            <br />
            expectedChangesHash={diffQuery.data?.changesHash || "（无）"}
          </p>
          {kind === "commit" ? <p>说明：{message.trim() || "（空）"}</p> : null}
          <p className="text-subtle">可逆性：提交可在本地回退；推送与快进拉取需额外协作处理。失败时不会自动重试。</p>
          {step === "confirm" ? (
            <label className="flex items-start gap-2 rounded-control border border-border bg-orange-soft/40 p-3">
              <input
                type="checkbox"
                className="mt-1"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              <span>我已阅读影响，并理解冲突 / STALE 时需人工处理、不会自动重试。</span>
            </label>
          ) : null}
        </div>
      ) : null}

      {step === "result" && result ? (
        <div className="space-y-3">
          {result.ok ? (
            <div className="rounded-panel border border-success/30 bg-success-soft/50 p-4">
              <p className="font-medium text-success">已完成</p>
              <p className="mt-1 text-sm text-body">{result.summary || "Git 写操作成功"}</p>
              {result.state ? (
                <p className="mt-2 font-mono text-xs text-subtle">
                  新状态：{result.state.worktree}/{result.state.topology}/{result.state.connection} · HEAD{" "}
                  {shortHash(result.state.head)}
                </p>
              ) : null}
            </div>
          ) : (
            <ErrorState
              title={result.code || "操作已停止"}
              impact={result.impact || "Git 状态可能已变化"}
              nextStep={result.nextStep || "关闭向导并重新查看摘要"}
            />
          )}
          <p className="text-sm text-subtle">本向导不会提供“自动重试”。</p>
        </div>
      ) : null}
    </Dialog>
  );
}
