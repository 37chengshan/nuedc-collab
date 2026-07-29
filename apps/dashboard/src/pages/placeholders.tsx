import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowUpRight,
  CheckCircle2,
  CircleAlert,
  Clock3,
  FileCode2,
  GitCommitHorizontal,
  Lightbulb,
  Plus,
  Users,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";
import { Section } from "@/components/Section";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { TextInput } from "@/components/TextInput";
import { TextArea } from "@/components/TextArea";
import { Select } from "@/components/Select";
import { Badge } from "@/components/Badge";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { LoadingState } from "@/components/LoadingState";
import {
  IdeaStatusPill,
  IssueStatusPill,
  PriorityPill,
  TaskStatusPill,
} from "@/components/StatusPill";
import {
  useCapabilitiesQuery,
  useDesignQuery,
  useDomainAction,
  useGitDiffQuery,
  useGitLogQuery,
  useGitStatusQuery,
  useIdeasQuery,
  useIssuesQuery,
  useMaterialsQuery,
  useMembersQuery,
  useSettingsQuery,
  useTasksQuery,
} from "@/hooks/queries";
import { getDesignContent, getMaterialContent } from "@/api/resources";
import type {
  DesignEntry,
  IdeaRecord,
  IssueRecord,
  IssueSeverity,
  IssueStatus,
  MemberRecord,
  RecordEnvelope,
  TaskPriority,
  TaskRecord,
  TaskStatus,
} from "@/api/types";
import { BOARD_COLUMNS, groupTasks } from "@/lib/task-board";
import {
  cn,
  formatRelativeTime,
  labelIdeaStatus,
  labelIssueStatus,
  labelTaskStatus,
  shortHash,
} from "@/lib/format";
import { useToast } from "@/components/Toast";
import { useGitWizard } from "@/features/git/GitWizardContext";
import { toErrorView } from "@/lib/query-error";

function actionKey(action: string) {
  const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `web-${action}-${suffix}`;
}

function QueryFailure({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <ErrorState
      impact={error instanceof Error ? error.message : "无法读取本地数据"}
      nextStep="确认本地服务已启动，再重新加载。"
      onRetry={retry}
    />
  );
}

function SafeContentPreview({
  content,
  className = "",
}: {
  content: { contentType: string; body?: string } | null | undefined;
  className?: string;
}) {
  if (!content?.body) return null;
  if (content.contentType.includes("text/html")) {
    return (
      <iframe
        title="HTML 沙箱预览"
        sandbox=""
        srcDoc={content.body}
        className={`mt-4 h-[620px] w-full rounded-control border border-border bg-white ${className}`}
      />
    );
  }
  return (
    <pre className={`mt-4 max-h-[620px] whitespace-pre-wrap break-words overflow-auto font-body text-sm leading-7 text-body ${className}`}>
      {content.body}
    </pre>
  );
}

function Stat({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: number | string;
  detail: string;
  tone?: "neutral" | "orange" | "danger" | "success";
}) {
  const color = tone === "orange" ? "text-orange-dark" : tone === "danger" ? "text-danger" : tone === "success" ? "text-success" : "text-ink";
  return (
    <div className="border-b border-border py-4 last:border-b-0 sm:border-b-0 sm:border-e sm:px-5 sm:first:ps-0 sm:last:border-e-0">
      <p className="text-xs font-medium tracking-wide text-faint">{label}</p>
      <p className={`mt-2 font-title text-3xl leading-none ${color}`}>{value}</p>
      <p className="mt-2 text-xs text-subtle">{detail}</p>
    </div>
  );
}

export function WorkbenchPage() {
  const tasks = useTasksQuery();
  const issues = useIssuesQuery();
  const ideas = useIdeasQuery();
  const members = useMembersQuery();
  const git = useGitStatusQuery();
  const log = useGitLogQuery();
  const { openWizard } = useGitWizard();

  if (tasks.isLoading || issues.isLoading || ideas.isLoading || members.isLoading || git.isLoading) {
    return <LoadingState label="正在汇总仓库脉搏…" />;
  }
  if (tasks.isError) return <QueryFailure error={tasks.error} retry={() => void tasks.refetch()} />;

  const taskItems = tasks.data?.items ?? [];
  const issueItems = issues.data?.items ?? [];
  const ideaItems = ideas.data?.items ?? [];
  const activeMembers = (members.data?.items ?? []).filter((item) => item.data.status === "active");
  const openTasks = taskItems.filter((item) => item.data.status !== "done");
  const blockers = issueItems.filter((item) => item.data.blocking && item.data.status !== "resolved");

  return (
    <div className="space-y-7">
      <PageHeader
        title="工作台"
        description="先看仓库状态，再决定今天该做什么。所有数字都来自当前 JSON 与 Git。"
        actions={
          <>
            <Button variant="secondary" onClick={() => openWizard("pull")}>安全拉取</Button>
            <Button onClick={() => openWizard("commit")}>检查并提交</Button>
          </>
        }
        meta={
          <>
            <Badge tone={git.data?.severity === "conflict" ? "danger" : git.data?.severity === "ahead" ? "orange" : "success"}>
              Git · {git.data?.severity ?? "未知"}
            </Badge>
            <Badge>{git.data?.branch ?? "未识别分支"} · {shortHash(git.data?.head)}</Badge>
            <Badge>{activeMembers.length}/3 名 active 成员</Badge>
          </>
        }
      />

      <section className="grid border-y border-border sm:grid-cols-4">
        <Stat label="未完成任务" value={openTasks.length} detail={`${taskItems.filter((item) => item.data.status === "doing").length} 项进行中`} tone="orange" />
        <Stat label="阻塞问题" value={blockers.length} detail={`${issueItems.filter((item) => item.data.status !== "resolved").length} 个未解决`} tone={blockers.length ? "danger" : "success"} />
        <Stat label="开放想法" value={ideaItems.filter((item) => item.effectiveState === "open").length} detail="等待验证或提升为任务" />
        <Stat label="本地提交" value={git.data?.ahead ?? 0} detail={git.data?.summary ?? "仓库状态已读取"} />
      </section>

      {git.data?.summary ? (
        <div className={cn(
          "border-y px-1 py-3",
          git.data.severity === "conflict" ? "border-danger/25 text-danger" : "border-orange/20",
        )}>
          <div className="flex items-start gap-3">
            <GitCommitHorizontal className="mt-0.5 h-5 w-5 shrink-0 text-orange-dark" />
            <div className="min-w-0">
              <p className="font-semibold text-ink">{git.data.summary}</p>
              <p className="mt-1 text-sm text-subtle">
                工作区 {git.data.worktree} · 本地领先 {git.data.ahead} · 远端领先 {git.data.behind}
              </p>
            </div>
          </div>
        </div>
      ) : null}

      <div className="grid gap-7 xl:grid-cols-[1.3fr_0.7fr]">
        <Section title="当前主线" description="优先展示进行中、阻塞和高优先级任务。">
          <div className="divide-y divide-border border-y border-border">
            {openTasks.slice(0, 6).map(({ data }) => (
              <div key={data.id} className="grid gap-2 py-4 sm:grid-cols-[1fr_auto] sm:items-center">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <TaskStatusPill status={data.status} />
                    <PriorityPill priority={data.priority} />
                    <span className="font-mono text-xs text-faint">{data.id}</span>
                  </div>
                  <p className="mt-2 font-medium text-ink">{data.title}</p>
                  <p className="mt-1 text-sm text-subtle">{data.module} · {data.owner ?? "未分配"}</p>
                </div>
                <span className="text-xs text-faint">{formatRelativeTime(data.updatedAt)}</span>
              </div>
            ))}
            {openTasks.length === 0 ? <p className="py-5 text-sm text-subtle">当前没有未完成任务。</p> : null}
          </div>
        </Section>

        <div className="space-y-7">
          <Section title="阻塞与风险">
            <div className="space-y-3">
              {blockers.map(({ data }) => (
                <div key={data.id} className="border-b border-danger/15 py-3 last:border-b-0">
                  <div className="flex items-start gap-3">
                    <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
                    <div>
                      <p className="font-medium text-ink">{data.title}</p>
                      <p className="mt-1 text-xs text-subtle">{data.id} · {data.owner ?? "未分配"}</p>
                    </div>
                  </div>
                </div>
              ))}
              {blockers.length === 0 ? <p className="text-sm text-subtle">没有阻塞主线的问题。</p> : null}
            </div>
          </Section>
          <Section title="最近提交">
            <div className="space-y-3">
              {(log.data?.items ?? []).slice(0, 4).map((commit) => (
                <div key={commit.hash} className="border-b border-border pb-3 last:border-b-0">
                  <p className="text-sm font-medium text-ink">{commit.subject}</p>
                  <p className="mt-1 font-mono text-xs text-faint">{commit.shortHash} · {commit.author}</p>
                </div>
              ))}
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}

function TaskCreateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const mutation = useDomainAction();
  const { push } = useToast();
  const [title, setTitle] = useState("");
  const [module, setModule] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [description, setDescription] = useState("");
  const errorView = mutation.isError ? toErrorView(mutation.error) : null;
  const submit = () => {
    mutation.mutate({
      action: "task.create",
      request: {
        idempotencyKey: actionKey("task.create"),
        payload: { title: title.trim(), module: module.trim(), priority, description: description.trim() },
      },
    }, {
      onSuccess: () => {
        push({ title: "任务已创建", description: title, tone: "success" });
        setTitle(""); setModule(""); setDescription(""); onClose();
      },
    });
  };
  return (
    <Dialog open={open} onClose={onClose} title="新建任务" description="一项工作一个 JSON；标题使用动词 + 对象。"
      footer={<><Button variant="secondary" onClick={onClose}>取消</Button><Button loading={mutation.isPending} disabled={!title.trim() || !module.trim()} onClick={submit}>创建任务</Button></>}>
      <TextInput label="标题" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：完成电机空载测试" autoFocus />
      <TextInput label="模块" value={module} onChange={(event) => setModule(event.target.value)} placeholder="小车 / 视觉 / 电源" />
      <Select label="优先级" value={priority} onChange={(event) => setPriority(event.target.value as TaskPriority)}
        options={[{ value: "low", label: "低" }, { value: "medium", label: "中" }, { value: "high", label: "高" }, { value: "critical", label: "紧急" }]} />
      <TextArea label="说明" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="写清产出、边界与验收证据。" />
      {errorView ? <ErrorState impact={errorView.impact} nextStep={errorView.nextStep} details={errorView.details} /> : null}
    </Dialog>
  );
}

function TaskDetailDialog({ envelope, onClose }: { envelope: RecordEnvelope<TaskRecord> | null; onClose: () => void }) {
  const mutation = useDomainAction();
  const { push } = useToast();
  const [status, setStatus] = useState<TaskStatus>(envelope?.data.status ?? "todo");
  if (!envelope) return null;
  const task = envelope.data;
  const errorView = mutation.isError ? toErrorView(mutation.error) : null;
  const update = () => mutation.mutate({
    action: "task.setStatus",
    request: {
      idempotencyKey: actionKey("task.setStatus"),
      expectedRevision: envelope.revision,
      payload: { id: task.id, to: status, message: `网页将状态更新为 ${labelTaskStatus(status)}` },
    },
  }, {
    onSuccess: () => { push({ title: "任务状态已更新", tone: "success" }); onClose(); },
  });
  return (
    <Dialog open title={task.title} description={`${task.id} · ${task.module}`} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>关闭</Button><Button loading={mutation.isPending} onClick={update}>更新状态</Button></>}>
      <div className="flex flex-wrap gap-2"><TaskStatusPill status={task.status} /><PriorityPill priority={task.priority} /><Badge>{task.owner ?? "未分配"}</Badge></div>
      <p className="text-sm text-body">{task.description || "暂无说明。"}</p>
      <Select label="状态" value={status} onChange={(event) => setStatus(event.target.value as TaskStatus)}
        options={[
          { value: "todo", label: "待开始" }, { value: "doing", label: "进行中" }, { value: "blocked", label: "阻塞" },
          { value: "review", label: "待验证" }, { value: "done", label: "已完成" },
        ]} />
      <div>
        <p className="text-sm font-medium text-ink">验收条件</p>
        <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-subtle">
          {task.acceptanceCriteria.length ? task.acceptanceCriteria.map((item) => <li key={item}>{item}</li>) : <li>尚未填写</li>}
        </ul>
      </div>
      {errorView ? <ErrorState impact={errorView.impact} nextStep={errorView.nextStep} details={errorView.details} /> : null}
    </Dialog>
  );
}

export function TasksPage() {
  const query = useTasksQuery();
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<RecordEnvelope<TaskRecord> | null>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const closeCreate = () => {
    setCreating(false);
    window.setTimeout(() => createButtonRef.current?.focus(), 0);
  };
  if (query.isLoading) return <LoadingState label="正在读取任务 JSON…" />;
  if (query.isError) return <QueryFailure error={query.error} retry={() => void query.refetch()} />;
  const items = query.data?.items ?? [];
  const groups = groupTasks(items.map((item) => item.data));
  const byId = new Map(items.map((item) => [item.data.id, item]));
  return (
    <div className="space-y-7">
      <PageHeader title="任务" description="四列看板用于稳定扫描；阻塞任务保留在“进行中”并用红色状态标识。"
        actions={<Button ref={createButtonRef} leftIcon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>新建任务</Button>}
        meta={<><Badge>{items.length} 项任务</Badge><Badge tone="orange">{items.filter((item) => item.data.status === "doing").length} 项进行中</Badge></>} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {BOARD_COLUMNS.map((column) => (
          <section key={column.id} aria-labelledby={`column-${column.id}`} className="min-w-0">
            <div className="mb-3 flex items-center justify-between border-b border-border pb-2">
              <h2 id={`column-${column.id}`} className="text-sm font-semibold text-ink">{column.title}</h2>
              <span className="font-mono text-xs text-faint">{groups[column.id].length}</span>
            </div>
            <div className="space-y-3">
              {groups[column.id].map((task) => (
                <button key={task.id} type="button" onClick={() => setSelected(byId.get(task.id) ?? null)}
                  className="w-full border-b border-border px-1 py-3 text-start transition-colors duration-hover last:border-b-0 hover:bg-muted/60">
                  <div className="flex flex-wrap gap-2"><TaskStatusPill status={task.status} /><PriorityPill priority={task.priority} /></div>
                  <p className="mt-3 font-medium leading-5 text-ink">{task.title}</p>
                  <p className="mt-2 text-xs text-subtle">{task.module} · {task.owner ?? "未分配"}</p>
                  <p className="mt-3 truncate font-mono text-[11px] text-faint">{task.id}</p>
                </button>
              ))}
              {groups[column.id].length === 0 ? <div className="border-b border-dashed border-border px-1 py-4 text-sm text-faint">暂无任务</div> : null}
            </div>
          </section>
        ))}
      </div>
      <TaskCreateDialog open={creating} onClose={closeCreate} />
      <TaskDetailDialog envelope={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function IssueCreateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const mutation = useDomainAction();
  const { push } = useToast();
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState("medium");
  const [symptom, setSymptom] = useState("");
  const [blocking, setBlocking] = useState(false);
  const submit = () => mutation.mutate({
    action: "issue.create",
    request: { idempotencyKey: actionKey("issue.create"), payload: { title: title.trim(), severity, blocking, symptoms: symptom.trim() ? [symptom.trim()] : [] } },
  }, {
    onSuccess: () => { push({ title: "问题已报告", tone: "success" }); onClose(); setTitle(""); setSymptom(""); },
  });
  return (
    <Dialog open={open} onClose={onClose} title="报告问题" description="记录可复现现象，不要把猜测原因写成事实。"
      footer={<><Button variant="secondary" onClick={onClose}>取消</Button><Button disabled={!title.trim()} loading={mutation.isPending} onClick={submit}>创建问题</Button></>}>
      <TextInput label="标题" autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：电机 B 通道无输出" />
      <Select label="严重度" value={severity} onChange={(event) => setSeverity(event.target.value)}
        options={[{ value: "low", label: "低" }, { value: "medium", label: "中" }, { value: "high", label: "高" }, { value: "critical", label: "紧急" }]} />
      <TextArea label="症状" value={symptom} onChange={(event) => setSymptom(event.target.value)} placeholder="条件、现象、频率、已排除项。" />
      <label className="flex items-center gap-3 rounded-control border border-border p-3 text-sm">
        <input type="checkbox" checked={blocking} onChange={(event) => setBlocking(event.target.checked)} />
        阻塞当前比赛主线
      </label>
    </Dialog>
  );
}

function IssueDetailDialog({
  envelope,
  members,
  onClose,
}: {
  envelope: RecordEnvelope<IssueRecord>;
  members: Array<RecordEnvelope<MemberRecord>>;
  onClose: () => void;
}) {
  const updateMutation = useDomainAction();
  const handoffMutation = useDomainAction();
  const eventMutation = useDomainAction();
  const { push } = useToast();
  const issue = envelope.data;
  const [status, setStatus] = useState<IssueStatus>(issue.status);
  const [severity, setSeverity] = useState<IssueSeverity>(issue.severity);
  const [blocking, setBlocking] = useState(issue.blocking);
  const [symptoms, setSymptoms] = useState(issue.symptoms.join("\n"));
  const [workaround, setWorkaround] = useState(issue.workaround);
  const [resolution, setResolution] = useState(issue.resolution);
  const [description, setDescription] = useState(issue.description ?? "");
  const [toOwner, setToOwner] = useState(issue.owner ?? members[0]?.data.githubUsername ?? "");
  const [eventKind, setEventKind] = useState<"comment" | "progress" | "testResult">("progress");
  const [eventMessage, setEventMessage] = useState("");

  const updateIssue = (payload: Record<string, unknown>, successTitle: string) => {
    updateMutation.mutate({
      action: "issue.update",
      request: {
        idempotencyKey: actionKey("issue.update"),
        expectedRevision: envelope.revision,
        payload: { id: issue.id, ...payload },
      },
    }, {
      onSuccess: () => {
        push({ title: successTitle, tone: "success" });
        onClose();
      },
    });
  };

  const save = () => {
    if (status === "resolved" && !resolution.trim()) {
      push({ title: "解决问题前请填写解决结论", tone: "warning" });
      return;
    }
    updateIssue({
      status,
      severity,
      blocking,
      symptoms: symptoms.split("\n").map((item) => item.trim()).filter(Boolean),
      workaround: workaround.trim(),
      resolution: resolution.trim(),
      description: description.trim(),
    }, "问题已更新");
  };

  const quickStatus = (nextStatus: IssueStatus) => {
    if (nextStatus === "resolved" && !resolution.trim()) {
      push({ title: "先填写解决结论，再标记已解决", tone: "warning" });
      return;
    }
    updateIssue({
      status: nextStatus,
      ...(nextStatus === "resolved" ? { resolution: resolution.trim(), blocking: false } : {}),
    }, nextStatus === "resolved" ? "问题已解决" : nextStatus === "investigating" ? "已开始排查" : "问题已重新打开");
  };

  const handoff = () => {
    if (!toOwner || toOwner === issue.owner) return;
    handoffMutation.mutate({
      action: "issue.handoff",
      request: {
        idempotencyKey: actionKey("issue.handoff"),
        expectedRevision: envelope.revision,
        payload: {
          id: issue.id,
          toOwner,
          message: `网页将问题交接给 ${toOwner}`,
        },
      },
    }, {
      onSuccess: () => {
        push({ title: `问题已交接给 ${toOwner}`, tone: "success" });
        onClose();
      },
    });
  };

  const appendEvent = () => {
    if (!eventMessage.trim()) return;
    eventMutation.mutate({
      action: "event.append",
      request: {
        idempotencyKey: actionKey("event.append"),
        payload: {
          entityType: "issue",
          entityId: issue.id,
          kind: eventKind,
          message: eventMessage.trim(),
        },
      },
    }, {
      onSuccess: () => {
        push({ title: "处理记录已追加", tone: "success" });
        setEventMessage("");
      },
    });
  };

  const activeMembers = members.filter((member) => member.data.status === "active");
  const mutationError = updateMutation.error ?? handoffMutation.error ?? eventMutation.error;
  const errorView = mutationError ? toErrorView(mutationError) : null;
  const busy = updateMutation.isPending || handoffMutation.isPending || eventMutation.isPending;

  return (
    <Dialog
      open
      title={issue.title}
      description={`${issue.id} · 创建于 ${formatRelativeTime(issue.createdAt)}`}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>关闭</Button>
          {issue.status === "resolved" ? (
            <Button variant="secondary" loading={updateMutation.isPending} onClick={() => quickStatus("open")}>重新打开</Button>
          ) : (
            <>
              {issue.status !== "investigating" ? (
                <Button variant="secondary" loading={updateMutation.isPending} onClick={() => quickStatus("investigating")}>开始排查</Button>
              ) : null}
              <Button variant="secondary" loading={updateMutation.isPending} onClick={() => quickStatus("resolved")}>标记已解决</Button>
            </>
          )}
          <Button loading={updateMutation.isPending} onClick={save}>保存修改</Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Select
          label="状态"
          value={status}
          onChange={(event) => setStatus(event.target.value as IssueStatus)}
          options={[
            { value: "open", label: "待处理" },
            { value: "investigating", label: "排查中" },
            { value: "blocked", label: "受阻" },
            { value: "resolved", label: "已解决" },
          ]}
        />
        <Select
          label="严重度"
          value={severity}
          onChange={(event) => setSeverity(event.target.value as IssueSeverity)}
          options={[
            { value: "low", label: "低" },
            { value: "medium", label: "中" },
            { value: "high", label: "高" },
            { value: "critical", label: "紧急" },
          ]}
        />
      </div>

      <label className="flex items-center justify-between gap-4 border-y border-border py-3 text-sm">
        <span>
          <strong className="font-medium text-ink">阻塞比赛主线</strong>
          <span className="mt-0.5 block text-xs text-subtle">开启后会出现在工作台的阻塞与风险区域。</span>
        </span>
        <input type="checkbox" checked={blocking} onChange={(event) => setBlocking(event.target.checked)} />
      </label>

      <TextArea label="现象与复现条件（每行一条）" value={symptoms} onChange={(event) => setSymptoms(event.target.value)} />
      <TextArea label="补充说明" value={description} onChange={(event) => setDescription(event.target.value)} />
      <TextArea label="临时方案" value={workaround} onChange={(event) => setWorkaround(event.target.value)} placeholder="没有可用临时方案时可留空。" />
      <TextArea label="解决结论" value={resolution} onChange={(event) => setResolution(event.target.value)} placeholder="标记已解决前必须写清修复和复测结果。" />

      <section className="border-t border-border pt-4" aria-labelledby="issue-handoff-title">
        <h3 id="issue-handoff-title" className="text-sm font-semibold text-ink">负责人交接</h3>
        <p className="mt-1 text-xs text-subtle">owner 仅用于分工展示，任何 active 成员仍可继续操作。</p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <Select
            label="交接给"
            value={toOwner}
            onChange={(event) => setToOwner(event.target.value)}
            options={activeMembers.map((member) => ({
              value: member.data.githubUsername,
              label: member.data.githubUsername,
            }))}
          />
          <Button
            className="sm:mt-[26px]"
            variant="secondary"
            disabled={!toOwner || toOwner === issue.owner}
            loading={handoffMutation.isPending}
            onClick={handoff}
          >
            交接负责人
          </Button>
        </div>
      </section>

      <section className="border-t border-border pt-4" aria-labelledby="issue-event-title">
        <h3 id="issue-event-title" className="text-sm font-semibold text-ink">追加处理记录</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-[180px_1fr]">
          <Select
            label="记录类型"
            value={eventKind}
            onChange={(event) => setEventKind(event.target.value as typeof eventKind)}
            options={[
              { value: "progress", label: "排查进展" },
              { value: "comment", label: "补充说明" },
              { value: "testResult", label: "复测结果" },
            ]}
          />
          <TextArea label="记录内容" value={eventMessage} onChange={(event) => setEventMessage(event.target.value)} />
        </div>
        <div className="mt-3 flex justify-end">
          <Button variant="secondary" disabled={!eventMessage.trim()} loading={eventMutation.isPending} onClick={appendEvent}>
            追加记录
          </Button>
        </div>
      </section>

      {errorView ? <ErrorState impact={errorView.impact} nextStep={errorView.nextStep} details={errorView.details} /> : null}
      {busy ? <p className="sr-only" role="status">正在保存问题操作</p> : null}
    </Dialog>
  );
}

export function IssuesPage() {
  const query = useIssuesQuery();
  const members = useMembersQuery();
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<RecordEnvelope<IssueRecord> | null>(null);
  if (query.isLoading || members.isLoading) return <LoadingState label="正在读取问题记录…" />;
  if (query.isError) return <QueryFailure error={query.error} retry={() => void query.refetch()} />;
  if (members.isError) return <QueryFailure error={members.error} retry={() => void members.refetch()} />;
  const items = query.data?.items ?? [];
  return (
    <div className="space-y-7">
      <PageHeader title="问题" description="按阻塞性和严重度排列；关闭问题前必须写清解决与复测证据。"
        actions={<Button leftIcon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>报告问题</Button>}
        meta={<><Badge tone="danger">{items.filter((item) => item.data.blocking && item.data.status !== "resolved").length} 个 blocker</Badge><Badge>{items.length} 条记录</Badge></>} />
      <div className="overflow-hidden rounded-panel border border-border bg-panel">
        <div className="hidden grid-cols-[auto_1fr_110px_130px_120px_44px] gap-4 border-b border-border bg-muted px-4 py-3 text-xs font-semibold text-subtle md:grid">
          <span>状态</span><span>问题</span><span>严重度</span><span>负责人</span><span>更新时间</span><span className="sr-only">操作</span>
        </div>
        <div className="divide-y divide-border">
          {items.map((item) => {
            const data = item.data;
            return (
              <button
                key={data.id}
                type="button"
                className="grid w-full gap-3 px-4 py-4 text-start transition-colors hover:bg-muted/55 md:grid-cols-[auto_1fr_110px_130px_120px_44px] md:items-center"
                onClick={() => setSelected(item)}
                aria-label={`查看问题：${data.title}`}
              >
                <IssueStatusPill status={data.status} />
                <div className="min-w-0">
                  <p className="font-medium text-ink">{data.title}</p>
                  <p className="mt-1 text-xs text-subtle">{data.id}{data.blocking ? " · 阻塞主线" : ""}</p>
                  {data.symptoms[0] ? <p className="mt-2 text-sm text-subtle md:hidden">{data.symptoms[0]}</p> : null}
                </div>
                <Badge tone={data.severity === "critical" ? "danger" : data.severity === "high" ? "warning" : "neutral"}>{data.severity}</Badge>
                <span className="text-sm text-subtle">{data.owner ?? "未分配"}</span>
                <span className="text-xs text-faint">{formatRelativeTime(data.updatedAt)}</span>
                <ArrowUpRight className="h-4 w-4 text-faint" aria-hidden />
              </button>
            );
          })}
          {items.length === 0 ? <EmptyState title="暂无问题" description="赛前自检与比赛调试中发现异常时立即记录。" /> : null}
        </div>
      </div>
      <IssueCreateDialog open={creating} onClose={() => setCreating(false)} />
      {selected ? (
        <IssueDetailDialog
          key={selected.data.id}
          envelope={selected}
          members={members.data?.items ?? []}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}

function IdeaCreateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const mutation = useDomainAction();
  const { push } = useToast();
  const [title, setTitle] = useState("");
  const [module, setModule] = useState("");
  const [description, setDescription] = useState("");
  const submit = () => mutation.mutate({
    action: "idea.create",
    request: { idempotencyKey: actionKey("idea.create"), payload: { title: title.trim(), module: module.trim(), description: description.trim() } },
  }, {
    onSuccess: () => { push({ title: "想法已记录", tone: "success" }); onClose(); setTitle(""); setModule(""); setDescription(""); },
  });
  return (
    <Dialog open={open} onClose={onClose} title="创建想法" description="先记录假设和验证方式，不直接当成最终方案。"
      footer={<><Button variant="secondary" onClick={onClose}>取消</Button><Button disabled={!title.trim() || !module.trim()} loading={mutation.isPending} onClick={submit}>创建想法</Button></>}>
      <TextInput label="标题" autoFocus value={title} onChange={(event) => setTitle(event.target.value)} />
      <TextInput label="模块" value={module} onChange={(event) => setModule(event.target.value)} />
      <TextArea label="说明" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="目标、假设、验证条件和风险。" />
    </Dialog>
  );
}

function IdeaDetailDialog({ envelope, onClose }: { envelope: RecordEnvelope<IdeaRecord> | null; onClose: () => void }) {
  const mutation = useDomainAction();
  const { push } = useToast();
  if (!envelope) return null;
  const idea = envelope.data;
  const promote = () => mutation.mutate({
    action: "idea.promoteToTask",
    request: {
      idempotencyKey: actionKey("idea.promoteToTask"),
      expectedRevision: envelope.revision,
      payload: { ideaId: idea.id, title: idea.title, module: idea.module, priority: "medium", description: idea.description, acceptanceCriteria: ["完成一次可复现验证"] },
    },
  }, { onSuccess: () => { push({ title: "想法已提升为任务", tone: "success" }); onClose(); } });
  return (
    <Dialog open title={idea.title} description={`${idea.id} · ${idea.module}`} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>关闭</Button><Button loading={mutation.isPending} onClick={promote}>提升为任务</Button></>}>
      <div className="flex flex-wrap gap-2"><IdeaStatusPill status={envelope.effectiveState ?? idea.status} /><Badge>{idea.author}</Badge></div>
      <p className="text-sm leading-6 text-body">{idea.description || "暂无说明。"}</p>
    </Dialog>
  );
}

export function IdeasPage() {
  const query = useIdeasQuery();
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<RecordEnvelope<IdeaRecord> | null>(null);
  if (query.isLoading) return <LoadingState label="正在读取想法…" />;
  if (query.isError) return <QueryFailure error={query.error} retry={() => void query.refetch()} />;
  return (
    <div className="space-y-7">
      <PageHeader title="想法" description="想法池是低成本探索区；只有明确验证目标后才提升为任务。"
        actions={<Button leftIcon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>新建想法</Button>} />
      <div className="grid border-y border-border md:grid-cols-2 xl:grid-cols-3">
        {(query.data?.items ?? []).map((item) => (
          <button key={item.data.id} type="button" onClick={() => setSelected(item)}
            className="border-b border-border p-4 text-start transition-colors duration-hover hover:bg-muted/55 md:border-e xl:[&:nth-child(3n)]:border-e-0">
            <div className="flex items-start justify-between gap-3">
              <Lightbulb className="h-5 w-5 shrink-0 text-orange" />
              <IdeaStatusPill status={item.effectiveState ?? item.data.status} />
            </div>
            <p className="mt-4 font-title text-lg leading-6 text-ink">{item.data.title}</p>
            <p className="mt-2 line-clamp-3 text-sm leading-6 text-subtle">{item.data.description || "暂无说明。"}</p>
            <p className="mt-4 text-xs text-faint">{item.data.module} · {item.data.author}</p>
          </button>
        ))}
      </div>
      <IdeaCreateDialog open={creating} onClose={() => setCreating(false)} />
      <IdeaDetailDialog envelope={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

export function HistoryPage() {
  const log = useGitLogQuery();
  const [selected, setSelected] = useState<string | undefined>();
  const diff = useGitDiffQuery(selected);
  if (log.isLoading) return <LoadingState label="正在读取提交历史…" />;
  if (log.isError) return <QueryFailure error={log.error} retry={() => void log.refetch()} />;
  return (
    <div className="space-y-7">
      <PageHeader title="提交历史" description="提交是协作证据；diff 只读展示，与推送动作完全分离。" />
      <div className="grid gap-6 xl:grid-cols-[0.8fr_1.2fr]">
        <div className="divide-y divide-border border-y border-border">
          {(log.data?.items ?? []).map((commit) => (
            <button key={commit.hash} type="button" onClick={() => setSelected(commit.hash)}
              className="grid w-full grid-cols-[auto_1fr] gap-3 py-4 text-start hover:bg-muted/60">
              <GitCommitHorizontal className="mt-0.5 h-4 w-4 text-orange" />
              <div className="min-w-0">
                <p className="font-medium text-ink">{commit.subject}</p>
                <p className="mt-1 font-mono text-xs text-faint">{commit.shortHash} · {commit.author} · {formatRelativeTime(commit.committedAt)}</p>
              </div>
            </button>
          ))}
        </div>
        <Card className="min-w-0 shadow-none">
          <div className="flex items-center justify-between border-b border-border pb-3">
            <h2 className="text-sm font-semibold text-ink">只读 Diff</h2>
            <Badge>{selected ? shortHash(selected) : "工作区"}</Badge>
          </div>
          {diff.isLoading ? <LoadingState className="mt-4" label="读取差异…" /> : null}
          {diff.data ? (
            <div className="mt-4 space-y-4">
              <ul className="space-y-2">
                {diff.data.files.map((file) => <li key={file.path} className="font-mono text-xs text-body">{file.status} {file.path}</li>)}
              </ul>
              <pre className="max-h-[520px] overflow-auto rounded-control bg-[#211d1a] p-4 font-mono text-xs leading-5 text-[#f6eee8]">{diff.data.patch || "没有文本补丁。"}</pre>
            </div>
          ) : <p className="mt-4 text-sm text-subtle">选择一个提交查看差异。</p>}
        </Card>
      </div>
    </div>
  );
}

export function MaterialsPage() {
  const materials = useMaterialsQuery();
  const [selected, setSelected] = useState<string | null>(null);
  const content = useQuery({
    queryKey: ["material-content", selected],
    queryFn: () => getMaterialContent(selected!),
    enabled: Boolean(selected),
  });
  if (materials.isLoading) return <LoadingState label="正在索引参考资料…" />;
  if (materials.isError) return <QueryFailure error={materials.error} retry={() => void materials.refetch()} />;
  return (
    <div className="space-y-7">
      <PageHeader title="参考资料" description="焊接教程、硬件资料与外部仓库统一索引；来源和验证状态始终可见。" />
      <div className="grid gap-6 xl:grid-cols-[0.75fr_1.25fr]">
        <div className="space-y-3">
          {(materials.data?.items ?? []).map((item) => (
            <button key={item.id} type="button" onClick={() => setSelected(item.relativePath)}
              className="w-full border-b border-border px-1 py-3 text-start transition-colors hover:bg-muted/55">
              <div className="flex items-start gap-3">
                <FileCode2 className="mt-0.5 h-5 w-5 shrink-0 text-orange" />
                <div className="min-w-0">
                  <p className="font-medium text-ink">{item.title}</p>
                  <p className="mt-1 text-xs text-subtle">{item.sourceLabel} · {item.modules.join(" / ")}</p>
                  <div className="mt-3"><Badge tone={item.verificationStatus === "verified" ? "success" : "warning"}>{item.verificationStatus}</Badge></div>
                </div>
              </div>
            </button>
          ))}
        </div>
        <Card className="min-w-0 shadow-none">
          <h2 className="border-b border-border pb-3 text-sm font-semibold text-ink">安全预览</h2>
          {content.isLoading ? <LoadingState className="mt-4" /> : null}
          {content.isError ? <QueryFailure error={content.error} retry={() => void content.refetch()} /> : null}
          {content.data?.body ? <SafeContentPreview content={content.data} /> : <p className="mt-4 text-sm text-subtle">选择资料查看文本内容；HTML 只允许沙箱预览。</p>}
        </Card>
      </div>
    </div>
  );
}

export function DesignPage() {
  const design = useDesignQuery();
  const [selected, setSelected] = useState<DesignEntry | null>(null);
  const content = useQuery({
    queryKey: ["design-content", selected?.relativePath],
    queryFn: () => getDesignContent(selected!.relativePath),
    enabled: Boolean(selected),
  });
  if (design.isLoading) return <LoadingState label="正在读取总体设计…" />;
  if (design.isError) return <QueryFailure error={design.error} retry={() => void design.refetch()} />;
  return (
    <div className="space-y-7">
      <PageHeader title="总体设计" description="题目公布前只展示准备状态与接口画布；不会把预选硬件写成最终方案。" />
      <div className="grid gap-6 xl:grid-cols-[0.7fr_1.3fr]">
        <div className="space-y-3">
          {(design.data?.entries ?? []).map((entry) => (
            <button key={entry.id} type="button" onClick={() => setSelected(entry)}
              className="w-full border-b border-border px-1 py-3 text-start transition-colors hover:bg-muted/55">
              <Badge>{entry.category}</Badge>
              <p className="mt-3 font-medium text-ink">{entry.title}</p>
              <p className="mt-1 break-all font-mono text-xs text-faint">{entry.relativePath}</p>
            </button>
          ))}
        </div>
        <div className="space-y-6">
          <Card className="shadow-none">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <h2 className="text-sm font-semibold text-ink">系统画布</h2>
              <Badge tone="orange">准备阶段</Badge>
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {(design.data?.canvas?.nodes ?? []).map((node) => (
                <div key={node.id} className="rounded-panel border border-border bg-muted/50 p-4">
                  <p className="font-title text-lg text-ink">{node.title ?? node.label ?? node.id}</p>
                  <p className="mt-2 text-sm text-subtle">{node.responsibility}</p>
                  <p className="mt-3 text-xs text-faint">{node.inputs.join("、") || "待定义"} → {node.outputs.join("、") || "待定义"}</p>
                </div>
              ))}
              {!design.data?.canvas?.nodes?.length ? <p className="text-sm text-subtle">题目公布后填写系统节点。</p> : null}
            </div>
          </Card>
          {selected ? (
            <Card className="shadow-none">
              <h2 className="text-sm font-semibold text-ink">{selected.title}</h2>
              {content.isLoading ? <LoadingState className="mt-4" /> : null}
              {content.data?.body ? <SafeContentPreview content={content.data} className="max-h-80" /> : null}
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function SettingsPage() {
  const settings = useSettingsQuery();
  const capabilities = useCapabilitiesQuery();
  const members = useMembersQuery();
  if (settings.isLoading || capabilities.isLoading || members.isLoading) return <LoadingState label="正在读取本机设置与 Agent 能力…" />;
  return (
    <div className="space-y-7">
      <PageHeader title="设置" description="本机身份不进 Git；Agent 能力来自协议，Git 写确认不可关闭。" />
      <div className="grid gap-6 xl:grid-cols-2">
        <Card className="shadow-none">
          <div className="flex items-center gap-3 border-b border-border pb-3">
            <Users className="h-5 w-5 text-orange" />
            <h2 className="text-sm font-semibold text-ink">本机与成员</h2>
          </div>
          <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
            <div><dt className="text-faint">GitHub username</dt><dd className="mt-1 font-mono text-ink">{settings.data?.data.githubUsername ?? "未配置"}</dd></div>
            <div><dt className="text-faint">本地端口</dt><dd className="mt-1 font-mono text-ink">{settings.data?.data.port ?? 3210}</dd></div>
            <div><dt className="text-faint">自动检查间隔</dt><dd className="mt-1 text-ink">{settings.data?.data.autoFetchIntervalSeconds ?? 60} 秒</dd></div>
            <div><dt className="text-faint">动效级别</dt><dd className="mt-1 text-ink">{settings.data?.data.motionLevel ?? "system"}</dd></div>
          </dl>
          <div className="mt-5 rounded-control border border-success/20 bg-success-soft p-3 text-sm text-success">
            Git 写确认开启，无法由网页或 Agent 绕过。
          </div>
          <div className="mt-5 space-y-2">
            {(members.data?.items ?? []).map((member) => (
              <div key={member.data.githubUsername} className="flex items-center justify-between border-t border-border py-3">
                <span className="font-mono text-sm text-ink">{member.data.githubUsername}</span>
                <Badge tone={member.data.status === "active" ? "success" : "neutral"}>{member.data.status}</Badge>
              </div>
            ))}
          </div>
        </Card>
        <Card className="shadow-none">
          <div className="flex items-center gap-3 border-b border-border pb-3">
            <CheckCircle2 className="h-5 w-5 text-orange" />
            <h2 className="text-sm font-semibold text-ink">Agent-native 能力</h2>
          </div>
          <p className="mt-4 text-sm leading-6 text-subtle">所有页面写操作都映射到同一协议动作；不允许 DOM 自动化或直接写 JSON。</p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {(capabilities.data?.actions ?? []).map((action) => (
              <div key={action.name} className="rounded-control border border-border bg-muted/45 px-3 py-2">
                <p className="font-mono text-xs font-semibold text-ink">{action.name}</p>
                <p className="mt-1 text-[11px] text-faint">{action.requiresRevision ? "需要 revision" : "创建动作"} · 幂等</p>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
