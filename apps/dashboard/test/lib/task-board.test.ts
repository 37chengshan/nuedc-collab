import { describe, expect, it } from "vitest";
import { groupTasks, statusToColumn } from "@/lib/task-board";
import type { TaskRecord } from "@/api/types";

function task(id: string, status: TaskRecord["status"]): TaskRecord {
  return {
    recordType: "task", schemaVersion: 1, id, title: id, module: "测试", status,
    priority: "medium", participants: [], dependencies: [], blockingIssueIds: [],
    relatedCommits: [], description: "", acceptanceCriteria: [],
    completedAcceptanceCriteria: [], createdAt: "2026-07-29T10:00:00+08:00",
    updatedAt: "2026-07-29T10:00:00+08:00",
  };
}

describe("task board", () => {
  it("把 blocked 放在进行中列但保留状态", () => {
    expect(statusToColumn("blocked")).toBe("doing");
    const grouped = groupTasks([task("T-1", "blocked"), task("T-2", "done")]);
    expect(grouped.doing[0]?.status).toBe("blocked");
    expect(grouped.done).toHaveLength(1);
  });
});
