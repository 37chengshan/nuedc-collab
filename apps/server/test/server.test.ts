import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { startServer } from "../src/index.js";

const execFileAsync = promisify(execFile);

type Started = Awaited<ReturnType<typeof startServer>>;

interface TestContext {
  repoRoot: string;
  remoteRoot: string;
  server: Started;
  baseUrl: string;
}

let ctx: TestContext;

beforeEach(async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "nuedc-server-repo-"));
  const remoteRoot = await mkdtemp(path.join(tmpdir(), "nuedc-server-remote-"));
  await setupRepo(repoRoot, remoteRoot);
  const server = await startServer({ repoRoot, port: 0 });
  ctx = {
    repoRoot,
    remoteRoot,
    server,
    baseUrl: `http://${server.host}:${server.port}`,
  };
});

afterEach(async () => {
  await ctx.server.close();
  await rm(ctx.repoRoot, { recursive: true, force: true });
  await rm(ctx.remoteRoot, { recursive: true, force: true });
});

describe("NUEDC 本地 API 服务", () => {
  test("health 发放本地 token，非法 Host/Origin/鉴权会被拒绝", async () => {
    const invalidHost = await rawRequest(`${ctx.baseUrl}/api/health`, {
      headers: { Host: "example.com" },
    });
    expect(invalidHost.status).toBeGreaterThanOrEqual(400);

    const invalidOrigin = await fetch(`${ctx.baseUrl}/api/tasks`, {
      headers: { Origin: "https://example.com" },
    });
    expect(invalidOrigin.status).toBe(403);

    const health = await fetch(`${ctx.baseUrl}/api/health`);
    expect(health.ok).toBe(true);
    const healthBody = (await health.json()) as { localAuthToken: string };
    const token = health.headers.get("x-local-auth") ?? healthBody.localAuthToken;
    expect(token).toBeTruthy();

    const invalidAuth = await fetch(`${ctx.baseUrl}/api/tasks`, {
      headers: { Origin: ctx.baseUrl, "X-Local-Auth": "definitely-wrong" },
    });
    expect(invalidAuth.status).toBe(401);
    await expect(invalidAuth.json()).resolves.toMatchObject({ code: "LOCAL_AUTH_REQUIRED" });
  });

  test("capabilities 暴露领域动作，通用 actions 拒绝 git.*，task.create 会落盘", async () => {
    const token = await getToken();

    const capabilities = await fetchJson<{
      protocolVersion: number;
      actor: string;
      gitConfirmationRequired: boolean;
      actions: Array<{ name: string }>;
    }>(`${ctx.baseUrl}/api/capabilities`, token);
    expect(capabilities).toMatchObject({
      protocolVersion: 1,
      actor: "tester",
      gitConfirmationRequired: true,
    });
    expect(capabilities.actions.map((item: { name: string }) => item.name)).toContain("task.create");
    expect(capabilities.actions.map((item: { name: string }) => item.name)).not.toContain("git.commit");

    const schema = await fetchJson<Record<string, unknown>>(`${ctx.baseUrl}/api/schemas/actions/task.create`, token);
    expect(schema).toMatchObject({ type: "object" });

    const rejectGitAction = await fetch(`${ctx.baseUrl}/api/actions/git.push`, {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify({ idempotencyKey: "agent-action-20260729-0001", payload: {} }),
    });
    expect(rejectGitAction.status).toBe(404);
    await expect(rejectGitAction.json()).resolves.toMatchObject({ code: "ACTION_NOT_SUPPORTED" });

    const before = await readdir(path.join(ctx.repoRoot, "比赛管理/任务"));
    const createTask = await fetch(`${ctx.baseUrl}/api/actions/task.create`, {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify({
        idempotencyKey: "agent-action-20260729-0002",
        payload: {
          title: "新增电源自检任务",
          module: "电源",
          priority: "high",
        },
      }),
    });
    expect(createTask.status).toBe(200);
    await expect(createTask.json()).resolves.toMatchObject({
      ok: true,
      action: "task.create",
      entities: [{ recordType: "task" }],
    });
    const after = await readdir(path.join(ctx.repoRoot, "比赛管理/任务"));
    expect(after.length).toBe(before.length + 1);
  });

  test("materials/design 内容读取阻止路径逃逸，HTML 以 sandbox 形式返回", async () => {
    const token = await getToken();

    const materials = await fetchJson<{ items: Array<{ relativePath: string }> }>(`${ctx.baseUrl}/api/materials`, token);
    expect(materials.items.some((item: { relativePath: string }) => item.relativePath === "参考资料/硬件资料/demo.html")).toBe(true);

    const html = await fetch(`${ctx.baseUrl}/api/materials/content?path=${encodeURIComponent("参考资料/硬件资料/demo.html")}`, {
      headers: { "X-Local-Auth": token },
    });
    expect(html.status).toBe(200);
    await expect(html.json()).resolves.toMatchObject({
      path: "参考资料/硬件资料/demo.html",
      contentType: "text/html; charset=utf-8",
      body: expect.stringContaining("<iframe sandbox=\"\""),
    });
    const htmlBody = (await (await fetch(`${ctx.baseUrl}/api/materials/content?path=${encodeURIComponent("参考资料/硬件资料/demo.html")}`, {
      headers: { "X-Local-Auth": token },
    })).json()) as { body: string };
    expect(htmlBody.body).toContain("&lt;script&gt;");

    const invalidMaterial = await fetch(`${ctx.baseUrl}/api/materials/content?path=${encodeURIComponent("../README.md")}`, {
      headers: { "X-Local-Auth": token },
    });
    expect(invalidMaterial.status).toBe(400);
    await expect(invalidMaterial.json()).resolves.toMatchObject({ code: "INVALID_PATH" });

    const design = await fetchJson<{ canvas: { sourcePath: string } | null }>(`${ctx.baseUrl}/api/design`, token);
    expect(design.canvas).toMatchObject({ sourcePath: "比赛设计/总体方案/系统画布.json" });

    const invalidDesign = await fetch(`${ctx.baseUrl}/api/design/content?path=${encodeURIComponent("../../etc/passwd")}`, {
      headers: { "X-Local-Auth": token },
    });
    expect(invalidDesign.status).toBe(400);
    await expect(invalidDesign.json()).resolves.toMatchObject({ code: "INVALID_PATH" });
  });

  test("Git 写操作要求 confirmed:true，陈旧确认态返回 409", async () => {
    const token = await getToken();

    const fetchResult = await fetch(`${ctx.baseUrl}/api/git/fetch`, {
      method: "POST",
      headers: { "X-Local-Auth": token },
    });
    expect(fetchResult.status).toBe(200);
    await expect(fetchResult.json()).resolves.toMatchObject({
      ok: true,
      operation: "fetch",
      state: { connection: "online" },
    });

    const unconfirmed = await fetch(`${ctx.baseUrl}/api/git/push`, {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify({}),
    });
    expect(unconfirmed.status).toBe(400);
    await expect(unconfirmed.json()).resolves.toMatchObject({ code: "GIT_CONFIRMATION_REQUIRED" });

    const stale = await fetch(`${ctx.baseUrl}/api/git/push`, {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify({
        confirmed: true,
        expectedHead: "0".repeat(40),
        expectedRemoteHead: "0".repeat(40),
      }),
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      code: "STALE_GIT_STATE",
      state: { topology: "synced" },
    });
  });
});

async function getToken(): Promise<string> {
  const response = await fetch(`${ctx.baseUrl}/api/health`);
  const body = (await response.json()) as { localAuthToken: string };
  return response.headers.get("x-local-auth") ?? body.localAuthToken;
}

function jsonHeaders(token: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Local-Auth": token,
  };
}

async function fetchJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, { headers: { "X-Local-Auth": token } });
  expect(response.ok).toBe(true);
  return (await response.json()) as T;
}

async function rawRequest(
  url: string,
  options: { headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string }> {
  const parsed = new URL(url);
  const { request } = await import("node:http");
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        headers: options.headers,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function setupRepo(repoRoot: string, remoteRoot: string): Promise<void> {
  await execGit(["init", "--initial-branch=main", repoRoot]);
  await execGit(["-C", repoRoot, "config", "user.name", "Tester"]);
  await execGit(["-C", repoRoot, "config", "user.email", "tester@example.com"]);
  await execGit(["init", "--bare", "--initial-branch=main", remoteRoot]);

  await mkdir(path.join(repoRoot, "比赛管理/任务"), { recursive: true });
  await mkdir(path.join(repoRoot, "比赛管理/问题"), { recursive: true });
  await mkdir(path.join(repoRoot, "比赛管理/想法"), { recursive: true });
  await mkdir(path.join(repoRoot, "比赛管理/事件"), { recursive: true });
  await mkdir(path.join(repoRoot, "比赛管理/成员"), { recursive: true });
  await mkdir(path.join(repoRoot, ".本机配置"), { recursive: true });
  await mkdir(path.join(repoRoot, "比赛文档/协作手册"), { recursive: true });
  await mkdir(path.join(repoRoot, "参考资料/硬件资料"), { recursive: true });
  await mkdir(path.join(repoRoot, "比赛设计/总体方案"), { recursive: true });

  await writeJson(path.join(repoRoot, ".本机配置/settings.json"), {
    schemaVersion: 1,
    githubUsername: "tester",
    port: 3210,
    autoFetchIntervalSeconds: 60,
    motionLevel: "system",
    confirmGitWrites: true,
  });
  await writeJson(path.join(repoRoot, "比赛管理/成员/tester.json"), {
    recordType: "member",
    schemaVersion: 1,
    githubUsername: "tester",
    roles: ["hardware"],
    responsibilities: ["电源"],
    status: "active",
    createdAt: "2026-07-29T09:00:00+08:00",
    updatedAt: "2026-07-29T09:00:00+08:00",
  });
  await writeJson(path.join(repoRoot, "比赛管理/任务/T-20260729-AAAA.json"), {
    recordType: "task",
    schemaVersion: 1,
    id: "T-20260729-AAAA",
    title: "检查供电",
    module: "电源",
    status: "todo",
    priority: "high",
    owner: "tester",
    participants: ["tester"],
    dependencies: [],
    blockingIssueIds: [],
    relatedCommits: [],
    description: "检查供电稳定性",
    acceptanceCriteria: ["测量 5V 电压"],
    completedAcceptanceCriteria: [],
    createdAt: "2026-07-29T09:00:00+08:00",
    updatedAt: "2026-07-29T09:00:00+08:00",
  });
  await writeJson(path.join(repoRoot, "比赛管理/问题/I-20260729-BBBB.json"), {
    recordType: "issue",
    schemaVersion: 1,
    id: "I-20260729-BBBB",
    title: "串口丢帧",
    status: "open",
    severity: "high",
    owner: "tester",
    blocking: true,
    linkedTaskIds: ["T-20260729-AAAA"],
    symptoms: ["偶发超时"],
    workaround: "降低发送频率",
    resolution: "",
    relatedCommits: [],
    createdAt: "2026-07-29T09:00:00+08:00",
    updatedAt: "2026-07-29T09:00:00+08:00",
  });
  await writeJson(path.join(repoRoot, "比赛管理/想法/A-20260729-CCCC.json"), {
    recordType: "idea",
    schemaVersion: 1,
    id: "A-20260729-CCCC",
    title: "加入上电自检",
    status: "open",
    author: "tester",
    owner: "tester",
    module: "电源",
    description: "上电时检测电压",
    createdAt: "2026-07-29T09:00:00+08:00",
    updatedAt: "2026-07-29T09:00:00+08:00",
  });
  await writeJson(path.join(repoRoot, "比赛管理/事件/E-20260729-090000-DDDD.json"), {
    recordType: "event",
    schemaVersion: 1,
    id: "E-20260729-090000-DDDD",
    entityType: "task",
    entityId: "T-20260729-AAAA",
    kind: "decision",
    actor: "tester",
    message: "确认先做供电自检",
    createdAt: "2026-07-29T09:00:00+08:00",
  });

  await writeFile(path.join(repoRoot, "比赛文档/协作手册/README.md"), "# 协作手册\n");
  await writeFile(
    path.join(repoRoot, "参考资料/硬件资料/demo.html"),
    "<!doctype html><html><body><script>window.secret='x'</script><h1>硬件资料</h1></body></html>",
  );
  await writeJson(path.join(repoRoot, "比赛设计/总体方案/系统画布.json"), {
    schemaVersion: 1,
    nodes: [
      {
        id: "power",
        label: "供电模块",
        responsibility: "稳定供电",
        inputs: ["电池"],
        outputs: ["5V"],
        status: "planned",
        x: 0,
        y: 0,
      },
    ],
    edges: [],
    context: {
      linkedIssueIds: ["I-20260729-BBBB"],
      linkedEventIds: ["E-20260729-090000-DDDD"],
      linkedMaterialIds: ["material-demo"],
    },
    updatedAt: "2026-07-29T09:00:00+08:00",
  });

  await execGit(["-C", repoRoot, "add", "."]);
  await execGit(["-C", repoRoot, "commit", "-m", "init fixture"]);
  await execGit(["-C", repoRoot, "remote", "add", "origin", remoteRoot]);
  await execGit(["-C", repoRoot, "push", "-u", "origin", "main"]);
}

async function writeJson(filePath: string, payload: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function execGit(args: string[]): Promise<void> {
  await execFileAsync("git", args, { env: { ...process.env, NO_COLOR: "1" } });
}
