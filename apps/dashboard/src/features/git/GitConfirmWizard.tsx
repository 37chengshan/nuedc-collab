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
import { queryKeys } from "@/hooks/queries";

const STEPS: GitWizardStep[] = ["view", "fill", "review", "confirm", "result"];

const TITLES: Record<GitWizardKind, string> = {
  pull: "快进拉取",
  commit: "创建本地提交",
  push: "推送到 origin/main",
};

const CONFIRM_LABEL: Record<GitWizardKind, string> = {
  pull: "确认拉取",
  commit: "确认提交",
  push: "确认推送",
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
  const [refreshing, setRefreshing] = useState(false);
  const [result, setResult] = useState<{
    ok: boolean;
    code?: string;
    impact?: string;
    nextStep?: string;
    summary?: string;
    state?: GitState;
  } | null>(null);

  const statusQuery = useQuery({
    queryKey: queryKeys.gitStatus,
    queryFn: getGitStatus,
    enabled: open,
    retry: false,
  });

  const diffQuery = useQuery({
    queryKey: ["git", "diff", "wizard", kind],
    queryFn: () => getGitDiff(),
    enabled: open && (kind === "commit" || step === "view"),
    retry: false,
  });

  useEffect(() => {
    if (!open) return;
    setStep("view");
    setFiles([]);
    setMessage("");
    setRefreshing(false);
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

  const policy = useMemo(() => {
    if (!snapshot) return { allowed: false, reason: "正在读取 Git 状态…" };
    if (kind === "pull") return canPull(snapshot);
    if (kind === "commit") return canCommit(snapshot);
    return canPush(snapshot);
  }, [kind, snapshot]);

  const writeMutation = useMutation({
    mutationFn: async ({
      latestSnapshot,
      changesHash,
    }: {
      latestSnapshot: GitState;
      changesHash?: string;
    }) => {
      const body = {
        confirmed: true as const,
        expectedHead: latestSnapshot.head,
        expectedRemoteHead: latestSnapshot.remoteHead,
        expectedChangesHash: changesHash,
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
      if (kind === "pull") {
        void queryClient.invalidateQueries();
      } else {
        void queryClient.invalidateQueries({ queryKey: ["git"] });
      }
      if (data.ok !== false) {
        push({ title: `${TITLES[kind]}成功`, description: data.summary, tone: "success" });
      }
    },
    onError: (err: unknown) => {
      const api = err instanceof ApiError ? err : null;
      const payload = api?.payload as GitWriteResult | undefined;
      setResult({
        ok: false,
        code: api?.code || "GIT_WRITE_FAILED",
        impact: api?.impact || (err as Error)?.message || "Git 写操作失败",
        nextStep: api?.nextStep || "关闭向导并重新查看摘要，不要自动重试",
        state: payload?.state,
      });
      setStep("result");
      push({
        title: `${TITLES[kind]}已停止`,
        description: api?.impact || "请按结果页指引处理",
        tone: "danger",
      });
    },
  });

  const confirmWrite = async () => {
    setRefreshing(true);
    try {
      const [latestSnapshot, latestDiff] = await Promise.all([
        getGitStatus(),
        kind === "commit" ? getGitDiff({ files }) : Promise.resolve(null),
      ]);
      if (kind === "commit") {
        const currentPaths = new Set((latestDiff?.files ?? []).map((file) => file.path));
        const missingFiles = files.filter((file) => !currentPaths.has(file));
        if (missingFiles.length > 0) {
          setSnapshot(latestSnapshot);
          setResult({
            ok: false,
            code: "STALE_GIT_STATE",
            impact: `有 ${missingFiles.length} 个选中文件已不在当前改动中，本次提交没有执行。`,
            nextStep: "返回文件选择，确认最新改动后再次提交。",
            state: latestSnapshot,
          });
          setStep("result");
          return;
        }
        if (!latestDiff?.changesHash) {
          throw new Error("无法生成选中文件的最新摘要");
        }
      }
      setSnapshot(latestSnapshot);
      writeMutation.mutate({
        latestSnapshot,
        ...(latestDiff?.changesHash ? { changesHash: latestDiff.changesHash } : {}),
      });
    } catch (err) {
      const api = err instanceof ApiError ? err : null;
      setResult({
        ok: false,
        code: api?.code || "GIT_REFRESH_FAILED",
        impact: api?.impact || (err as Error)?.message || "无法刷新 Git 状态",
        nextStep: api?.nextStep || "检查本地服务和仓库状态后，点击刷新重试。",
      });
      setStep("result");
    } finally {
      setRefreshing(false);
    }
  };

  const refreshAndReturn = async () => {
    setRefreshing(true);
    try {
      const [latestSnapshot, latestDiff] = await Promise.all([
        getGitStatus(),
        kind === "commit" ? getGitDiff() : Promise.resolve(null),
      ]);
      setSnapshot(latestSnapshot);
      if (kind === "commit") {
        const currentPaths = new Set((latestDiff?.files ?? []).map((file) => file.path));
        const validFiles = files.filter((file) => currentPaths.has(file));
        setFiles(validFiles);
        setStep(validFiles.length === files.length && validFiles.length > 0 ? "confirm" : "fill");
      } else {
        setStep("confirm");
      }
      setResult(null);
      push({
        title: "Git 状态已刷新",
        description: kind === "commit" ? "提交说明和仍有效的文件选择已保留。" : "请再次确认最新状态。",
        tone: "success",
      });
      void queryClient.invalidateQueries({ queryKey: ["git"] });
    } catch (err) {
      const api = err instanceof ApiError ? err : null;
      setResult({
        ok: false,
        code: api?.code || "GIT_REFRESH_FAILED",
        impact: api?.impact || (err as Error)?.message || "无法刷新 Git 状态",
        nextStep: api?.nextStep || "检查本地服务和仓库状态后再次刷新。",
      });
    } finally {
      setRefreshing(false);
    }
  };

  const goNext = () => {
    const idx = STEPS.indexOf(step);
    if (idx < 0 || idx >= STEPS.length - 1) return;
    if (step === "confirm") {
      void confirmWrite();
      return;
    }
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
  const busy = refreshing || writeMutation.isPending;
  const canRefreshResult =
    step === "result" &&
    result?.ok === false &&
    (result.code === "STALE_GIT_STATE" || result.code === "GIT_REFRESH_FAILED");

  return (
    <Dialog
      open={open}
      title={TITLES[kind]}
      description="填写并复核后，最后一步直接点击确认；执行前会刷新最新 Git 状态。"
      onClose={onClose}
      size="lg"
      footer={
        step === "result" ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              关闭向导
            </Button>
            {canRefreshResult ? (
              <Button variant="primary" loading={refreshing} onClick={() => void refreshAndReturn()}>
                刷新状态并重新确认
              </Button>
            ) : null}
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              取消
            </Button>
            {step !== "view" ? (
              <Button variant="ghost" onClick={goBack} disabled={busy}>
                上一步
              </Button>
            ) : null}
            <Button
              variant="primary"
              loading={busy}
              disabled={step === "view" && !policy.allowed}
              onClick={goNext}
            >
              {step === "confirm" ? CONFIRM_LABEL[kind] : "下一步"}
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
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-ink">选择要提交的文件（1—200）</p>
                    <p className="mt-0.5 text-xs text-subtle">默认不勾选，避免混入其他成员或其他操作产生的改动。</p>
                  </div>
                  {dirtyFiles.length > 0 ? (
                    <div className="flex gap-1">
                      <Button type="button" size="sm" variant="ghost" onClick={() => setFiles(dirtyFiles.slice(0, 200))}>
                        全选
                      </Button>
                      <Button type="button" size="sm" variant="ghost" disabled={files.length === 0} onClick={() => setFiles([])}>
                        清空
                      </Button>
                    </div>
                  ) : null}
                </div>
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
            <div className="rounded-control border border-orange/30 bg-orange-soft/40 p-3">
              <p className="font-medium text-ink">点击“{CONFIRM_LABEL[kind]}”后执行</p>
              <p className="mt-1 text-xs leading-5 text-subtle">
                系统会先刷新 HEAD 和文件摘要。若期间状态变化，本次操作停止，并可保留当前填写内容重新确认。
              </p>
            </div>
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
          <p className="text-sm text-subtle">
            写操作不会自动重试；状态过期时可刷新最新状态，并由你再次点击确认。
          </p>
        </div>
      ) : null}
    </Dialog>
  );
}
