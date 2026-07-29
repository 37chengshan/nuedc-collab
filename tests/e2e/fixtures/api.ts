import { expect, type Page } from "@playwright/test";

type RecordEnvelope<T extends Record<string, unknown>> = {
  data: T;
  relativePath: string;
  revision: string;
};

type ActionRequest = {
  action: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
};

const now = "2026-07-29T09:30:00+08:00";

export type DashboardFixture = {
  requests: ActionRequest[];
  task: RecordEnvelope<Record<string, unknown>>;
  issue: RecordEnvelope<Record<string, unknown>>;
  idea: RecordEnvelope<Record<string, unknown>>;
};

function json(body: unknown, status = 200) {
  return {
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(body),
  };
}

function envelope(id: string, type: string, data: Record<string, unknown>) {
  return {
    data: { recordType: type, schemaVersion: 1, id, ...data },
    relativePath: `比赛管理/${type}/${id}.json`,
    revision: "a".repeat(64),
  };
}

export async function installDashboardApi(page: Page): Promise<DashboardFixture> {
  const fixture: DashboardFixture = {
    requests: [],
    task: envelope("T-20260729-TEST", "task", {
      title: "检查电源轨",
      module: "电源",
      status: "todo",
      priority: "high",
      owner: "tester",
      participants: ["tester"],
      dependencies: [],
      blockingIssueIds: [],
      relatedCommits: [],
      description: "确认五路电源稳定。",
      acceptanceCriteria: ["测量五路电压"],
      completedAcceptanceCriteria: [],
      createdAt: now,
      updatedAt: now,
    }),
    issue: envelope("I-20260729-TEST", "issue", {
      title: "串口偶发丢帧",
      status: "open",
      severity: "high",
      owner: "tester",
      blocking: true,
      linkedTaskIds: ["T-20260729-TEST"],
      symptoms: ["连续传输时偶发超时"],
      workaround: "降低波特率",
      resolution: "",
      relatedCommits: [],
      createdAt: now,
      updatedAt: now,
    }),
    idea: envelope("A-20260729-TEST", "idea", {
      title: "增加电源自检",
      status: "open",
      author: "tester",
      owner: "tester",
      module: "电源",
      description: "开机时上报各路电压。",
      createdAt: now,
      updatedAt: now,
    }),
  };

  await page.route(/^https?:\/\/[^/]+\/api\/.*/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === "/api/health") {
      await route.fulfill({
        ...json({ ok: true, actor: "tester", sessionRequired: true, localAuthToken: "e2e-local-token" }),
        headers: { "X-Local-Auth": "e2e-local-token" },
      });
      return;
    }

    if (path === "/api/tasks" && request.method() === "GET") {
      await route.fulfill(json({ items: [fixture.task], warnings: [] }));
      return;
    }
    if (path === "/api/issues" && request.method() === "GET") {
      await route.fulfill(json({ items: [fixture.issue], warnings: [] }));
      return;
    }
    if (path === "/api/ideas" && request.method() === "GET") {
      await route.fulfill(json({ items: [fixture.idea], warnings: [] }));
      return;
    }
    if (path === "/api/events") {
      await route.fulfill(json({ items: [], warnings: [] }));
      return;
    }
    if (path === "/api/members") {
      await route.fulfill(json({
        items: [envelope("tester", "member", {
          githubUsername: "tester",
          roles: ["硬件"],
          responsibilities: ["电源"],
          status: "active",
          createdAt: now,
          updatedAt: now,
        })],
        warnings: [],
      }));
      return;
    }
    if (path === "/api/settings") {
      await route.fulfill(json(envelope("settings", "settings", {
        githubUsername: "tester",
        port: 3210,
        autoFetchIntervalSeconds: 60,
        motionLevel: "system",
        confirmGitWrites: true,
      })));
      return;
    }
    if (path === "/api/capabilities") {
      await route.fulfill(json({
        protocolVersion: 1,
        actor: "tester",
        actions: [
          "task.create", "task.update", "task.setStatus", "task.handoff",
          "issue.create", "issue.update", "issue.handoff", "event.append",
          "idea.create", "idea.update", "idea.promoteToTask", "member.update", "settings.update",
        ].map((name) => ({
          name,
          description: `${name} capability`,
          requiresRevision: !name.endsWith(".create"),
          requiresIdempotencyKey: true,
          schemaRef: `/api/schemas/actions/${name}`,
        })),
        domAutomationAllowed: false,
        directFileMutationAllowed: false,
        gitConfirmationRequired: true,
      }));
      return;
    }
    if (path.startsWith("/api/schemas/actions/")) {
      await route.fulfill(json({ type: "object", additionalProperties: false }));
      return;
    }
    if (path === "/api/materials") {
      await route.fulfill(json({
        items: [{
          id: "welding-tutorial",
          title: "焊接与调试教程",
          type: "tutorial",
          relativePath: "参考资料/焊接与调试/README.md",
          sourceLabel: "团队整理",
          modules: ["焊接"],
          verificationStatus: "verified",
          updatedAt: now,
          sizeBytes: 2048,
          previewMode: "text",
        }, {
          id: "welding-html",
          title: "主板焊接教程 HTML",
          type: "tutorial",
          relativePath: "参考资料/焊接与调试/主板教程.html",
          sourceLabel: "团队整理",
          modules: ["焊接"],
          verificationStatus: "verified",
          updatedAt: now,
          sizeBytes: 4096,
          previewMode: "sandboxHtml",
        }],
        warnings: [],
      }));
      return;
    }
    if (path === "/api/materials/content") {
      if (url.searchParams.get("path")?.endsWith(".html")) {
        await route.fulfill(json({
          path: url.searchParams.get("path"),
          contentType: "text/html; charset=utf-8",
          body: "<!doctype html><html><body><main>受限 HTML 教程</main></body></html>",
        }));
        return;
      }
      await route.fulfill(json({
        path: url.searchParams.get("path"),
        contentType: "text/markdown",
        body: "# 焊接与调试教程\n\n先检查焊点。",
      }));
      return;
    }
    if (path === "/api/design") {
      await route.fulfill(json({
        entries: [{
          id: "system-overview",
          title: "系统总体方案",
          category: "总体方案",
          relativePath: "比赛设计/总体方案/系统画布.json",
          format: "json",
          updatedAt: now,
          previewMode: "text",
        }],
        canvas: {
          sourcePath: "比赛设计/总体方案/系统画布.json",
          nodes: [{
            id: "vision",
            title: "视觉模块",
            responsibility: "识别目标",
            inputs: ["图像"],
            outputs: ["坐标"],
            status: "planned",
            x: 0,
            y: 0,
          }],
          edges: [],
        },
        context: { issueIds: [], materialIds: ["welding-tutorial"], decisionEventIds: [] },
        warnings: [],
      }));
      return;
    }
    if (path === "/api/design/content") {
      await route.fulfill(json({
        path: url.searchParams.get("path"),
        contentType: "application/json",
        body: "{\"nodes\":[]}",
      }));
      return;
    }
    if (path === "/api/git/status") {
      await route.fulfill(json({
        worktree: "dirty",
        topology: "ahead",
        connection: "online",
        head: "1".repeat(40),
        remoteHead: "0".repeat(40),
        ahead: 1,
        behind: 0,
        branch: "main",
        severity: "ahead",
        lastCheckedAt: now,
        dirtyFiles: ["比赛管理/任务/T-20260729-TEST.json"],
        summary: "有 1 个待提交改动",
      }));
      return;
    }
    if (path === "/api/git/log") {
      await route.fulfill(json({
        items: [{
          hash: "1".repeat(40),
          shortHash: "1111111",
          author: "tester",
          committedAt: now,
          subject: "feat: 初始化协作看板",
          files: ["README.md"],
        }],
        warnings: [],
      }));
      return;
    }
    if (path === "/api/git/diff") {
      await route.fulfill(json({
        files: [{ path: "README.md", status: "M", additions: 2, deletions: 1 }],
        patch: "@@ -1 +1 @@\n-旧内容\n+新内容",
        changesHash: "b".repeat(64),
      }));
      return;
    }
    if (path === "/api/git/fetch") {
      await route.fulfill(json({
        ok: true,
        operation: "fetch",
        summary: "远端状态已检查",
        state: { worktree: "dirty", topology: "ahead", connection: "online", severity: "ahead" },
      }));
      return;
    }
    if (path.startsWith("/api/git/") && request.method() === "POST") {
      const payload = request.postDataJSON() as Record<string, unknown>;
      if (payload.confirmed !== true) {
        await route.fulfill(json({
          code: "GIT_CONFIRMATION_REQUIRED",
          impact: "Git 写操作必须经过人工五步确认。",
          nextStep: "返回确认页复核状态后再执行。",
        }, 400));
        return;
      }
      await route.fulfill(json({
        ok: true,
        operation: path.split("/").at(-1),
        summary: "确认后的 Git 操作已完成",
        state: { worktree: "clean", topology: "synced", connection: "online", severity: "clean" },
      }));
      return;
    }
    if (path.startsWith("/api/actions/") && request.method() === "POST") {
      const body = request.postDataJSON() as { idempotencyKey?: string; payload?: Record<string, unknown> };
      const action = decodeURIComponent(path.split("/").at(-1) || "");
      fixture.requests.push({
        action,
        payload: body.payload || {},
        idempotencyKey: body.idempotencyKey || "",
      });

      if (action === "task.setStatus") {
        fixture.task.data.status = body.payload?.status || body.payload?.nextStatus || "doing";
      }
      await route.fulfill(json({
        ok: true,
        action,
        idempotencyKey: body.idempotencyKey,
        idempotentReplay: false,
        entities: [{
          recordType: action.startsWith("issue.") ? "issue" : action.startsWith("idea.") ? "idea" : "task",
          id: action.startsWith("issue.") ? fixture.issue.data.id : action.startsWith("idea.") ? fixture.idea.data.id : fixture.task.data.id,
          relativePath: "比赛管理/任务/T-20260729-TEST.json",
          revision: "c".repeat(64),
          updatedAt: now,
        }],
        warnings: [],
        nextActions: [],
      }));
      return;
    }

    await route.fulfill(json({ code: "NOT_FOUND", impact: `未配置 E2E fixture: ${path}` }, 404));
  });

  return fixture;
}

export async function expectAction(fixture: DashboardFixture, action: string) {
  await expect.poll(() => fixture.requests.some((request) => request.action === action)).toBe(true);
}
