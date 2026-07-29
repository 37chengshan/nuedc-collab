import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProtocolRepository, DomainRecordStore } from "../src/repository.js";
import { createProtocolRuntime } from "../src/index.js";
import { atomicWriteJson } from "../src/fs.js";
import { isTaskId, isIssueId, isIdeaId, isEventId, generateTaskId, nowIso } from "../src/ids.js";
import { computeRevision, stableStringify } from "../src/json.js";
import { resolveRepoPath } from "../src/paths.js";
import { validateTask, validateLocalSettings, systemCanvasSchema } from "../src/schemas.js";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const fixtures: string[] = [];

async function makeRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "nuedc-protocol-"));
  fixtures.push(root);
  const store = new DomainRecordStore(root);
  await store.ensureStructure();
  await store.writeMember({
    recordType: "member",
    schemaVersion: 1,
    githubUsername: "37chengshan",
    roles: ["coordinator"],
    responsibilities: [],
    status: "active",
    createdAt: "2026-07-28T20:00:00+08:00",
    updatedAt: "2026-07-28T20:00:00+08:00",
  });
  await store.writeLocalSettings({
    schemaVersion: 1,
    githubUsername: "37chengshan",
    port: 3210,
    autoFetchIntervalSeconds: 60,
    motionLevel: "system",
    confirmGitWrites: true,
  });
  return root;
}

afterEach(async () => {
  while (fixtures.length) {
    const root = fixtures.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("ids", () => {
  it("生成可读 ID 并匹配校验", async () => {
    const root = await makeRepo();
    const taskId = await generateTaskId(root);
    expect(isTaskId(taskId)).toBe(true);
    expect(isIssueId("I-20260728-91BC")).toBe(true);
    expect(isIdeaId("A-20260728-K3M7")).toBe(true);
    expect(isEventId("E-20260728-201500-7D2A")).toBe(true);
    expect(nowIso()).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

describe("json/revision", () => {
  it("规范化 JSON 与 revision 稳定", () => {
    const a = { b: 1, a: 2 };
    const b = { a: 2, b: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(computeRevision(a)).toBe(computeRevision(b));
    expect(computeRevision(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("paths", () => {
  it("拒绝路径逃逸", () => {
    expect(() => resolveRepoPath(process.cwd(), "..", "etc")).toThrow(/路径逃逸/);
  });
});

describe("schemas", () => {
  it("校验任务与本机设置", () => {
    expect(
      validateTask({
        recordType: "task",
        schemaVersion: 1,
        id: "T-20260728-A3F2",
        title: "检查小车五路电源",
        module: "小车主板",
        status: "todo",
        priority: "high",
        participants: [],
        dependencies: [],
        blockingIssueIds: [],
        relatedCommits: [],
        description: "",
        acceptanceCriteria: [],
        completedAcceptanceCriteria: [],
        createdAt: "2026-07-28T20:00:00+08:00",
        updatedAt: "2026-07-28T20:00:00+08:00",
      }),
    ).toBe(true);
    expect(
      validateLocalSettings({
        schemaVersion: 1,
        githubUsername: "37chengshan",
        port: 3210,
        autoFetchIntervalSeconds: 60,
        motionLevel: "system",
        confirmGitWrites: true,
      }),
    ).toBe(true);
    expect(
      validateLocalSettings({
        schemaVersion: 1,
        githubUsername: "37chengshan",
        port: 3210,
        autoFetchIntervalSeconds: 60,
        motionLevel: "system",
        confirmGitWrites: false,
      }),
    ).toBe(false);
  });
});

describe("repository facade", () => {
  it("只读门面不暴露写方法，并能隔离坏文件", async () => {
    const root = await makeRepo();
    const store = new DomainRecordStore(root);
    await store.writeTask({
      recordType: "task",
      schemaVersion: 1,
      id: "T-20260728-A3F2",
      title: "检查小车五路电源",
      module: "小车主板",
      status: "todo",
      priority: "high",
      participants: [],
      dependencies: [],
      blockingIssueIds: [],
      relatedCommits: [],
      description: "",
      acceptanceCriteria: [],
      completedAcceptanceCriteria: [],
      createdAt: "2026-07-28T20:00:00+08:00",
      updatedAt: "2026-07-28T20:00:00+08:00",
    });
    await writeFile(path.join(root, "比赛管理/任务/broken.json"), "{not-json", "utf8");
    const repo = await createProtocolRepository(root);
    expect("createTask" in repo).toBe(false);
    expect("updateEvent" in repo).toBe(false);
    const tasks = await repo.listTasks();
    expect(tasks.items).toHaveLength(1);
    expect(tasks.invalidFiles.some((f) => f.path.includes("broken.json"))).toBe(true);
  });

  it("事件不可变且想法 effectiveState 可派生", async () => {
    const root = await makeRepo();
    const store = new DomainRecordStore(root);
    await store.writeIdea({
      recordType: "idea",
      schemaVersion: 1,
      id: "A-20260728-K3M7",
      title: "使用双速视觉链路降低控制延迟",
      status: "open",
      author: "37chengshan",
      module: "K230 视觉",
      description: "高频输出粗坐标，低频输出完整识别结果。",
      createdAt: "2026-07-28T20:20:00+08:00",
      updatedAt: "2026-07-28T20:20:00+08:00",
    });
    await store.writeTask({
      recordType: "task",
      schemaVersion: 1,
      id: "T-20260728-B4C1",
      title: "实现双速视觉链路",
      module: "K230 视觉",
      status: "todo",
      priority: "medium",
      participants: [],
      dependencies: [],
      blockingIssueIds: [],
      relatedCommits: [],
      description: "",
      acceptanceCriteria: [],
      completedAcceptanceCriteria: [],
      sourceIdeaId: "A-20260728-K3M7",
      createdAt: "2026-07-28T20:30:00+08:00",
      updatedAt: "2026-07-28T20:30:00+08:00",
    });
    await store.writeEvent({
      recordType: "event",
      schemaVersion: 1,
      id: "E-20260728-201500-7D2A",
      entityType: "task",
      entityId: "T-20260728-B4C1",
      kind: "comment",
      actor: "37chengshan",
      message: "先记录方案边界",
      createdAt: "2026-07-28T20:15:00+08:00",
    });
    await expect(
      store.writeEvent({
        recordType: "event",
        schemaVersion: 1,
        id: "E-20260728-201500-7D2A",
        entityType: "task",
        entityId: "T-20260728-B4C1",
        kind: "comment",
        actor: "37chengshan",
        message: "重复写入应失败",
        createdAt: "2026-07-28T20:16:00+08:00",
      }),
    ).rejects.toThrow(/不可变/);
    const repo = await createProtocolRepository(root);
    const ideas = await repo.listIdeas();
    expect(ideas.items[0]?.effectiveState).toBe("converted");
    expect(ideas.items[0]?.data.status).toBe("open");
  });

  it("仓库样例全部有效且画布反映当前 B 题数字系统方案", async () => {
    const projectRoot = path.resolve(process.cwd(), "../..");
    // when running from packages/protocol, cwd is package root
    const root = path.resolve(process.cwd(), "../..");
    const runtime = await createProtocolRuntime(root);
    expect((await runtime.repository.listTasks()).invalidFiles).toEqual([]);
    expect((await runtime.repository.listIssues()).invalidFiles).toEqual([]);
    expect((await runtime.repository.listIdeas()).items[0]?.data.id).toBe("A-20260728-K3M7");
    expect((await runtime.repository.listMembers()).items[0]?.data.githubUsername).toBe("37chengshan");
    const canvasRaw = await (await import("node:fs/promises")).readFile(
      path.join(root, "比赛设计/总体方案/系统画布.json"),
      "utf8",
    );
    expect(canvasRaw).toContain("B 题数字系统总体链路");
    expect(canvasRaw).toContain("PA27 ADC 采样");
    expect(canvasRaw).not.toContain("K230 视觉能力");
    const ajv = new (Ajv as any)({ allErrors: true, strict: false });
    (addFormats as any)(ajv);
    const ok = ajv.validate(systemCanvasSchema, JSON.parse(canvasRaw));
    expect(ok).toBe(true);
  });
});
