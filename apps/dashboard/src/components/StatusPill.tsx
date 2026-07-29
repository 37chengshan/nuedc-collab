import { Badge, type BadgeTone } from "./Badge";
import { labelIdeaStatus, labelIssueStatus, labelPriority, labelTaskStatus } from "@/lib/format";

export function TaskStatusPill({ status }: { status: string }) {
  const tone: BadgeTone =
    status === "done" ? "success" : status === "blocked" ? "danger" : status === "review" ? "info" : status === "doing" ? "orange" : "neutral";
  return <Badge tone={tone}>{labelTaskStatus(status)}</Badge>;
}

export function IssueStatusPill({ status }: { status: string }) {
  const tone: BadgeTone =
    status === "resolved" ? "success" : status === "blocked" ? "danger" : status === "investigating" ? "warning" : "orange";
  return <Badge tone={tone}>{labelIssueStatus(status)}</Badge>;
}

export function IdeaStatusPill({ status }: { status: string }) {
  const tone: BadgeTone = status === "converted" ? "success" : status === "discarded" ? "neutral" : "info";
  return <Badge tone={tone}>{labelIdeaStatus(status)}</Badge>;
}

export function PriorityPill({ priority }: { priority: string }) {
  const tone: BadgeTone =
    priority === "critical" ? "danger" : priority === "high" ? "warning" : priority === "medium" ? "orange" : "neutral";
  return <Badge tone={tone}>{labelPriority(priority)}</Badge>;
}
