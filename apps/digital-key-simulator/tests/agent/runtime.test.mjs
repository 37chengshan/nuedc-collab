import assert from "node:assert/strict";
import test from "node:test";

import { createDigitalKeyRuntime } from "../../src/agent/index.js";

function createDomain() {
  const calls = [];
  const state = {
    lifecycle: "paused",
    key: {
      active: true,
      keyAddress: 0x1113,
      xMm: 0,
      yMm: 2500,
    },
    expectedId: 3,
    lock: {
      state: "locked",
      authorized: false,
    },
  };

  return {
    calls,
    async query(operation, argumentsValue) {
      calls.push({ phase: "query", operation, arguments: argumentsValue });
      if (operation === "simulation.state.get") {
        return structuredClone(state);
      }
      if (operation === "lock.snapshot.get") {
        return structuredClone(state.lock);
      }
      throw new Error(`unexpected query ${operation}`);
    },
    async execute(operation, argumentsValue, context) {
      calls.push({ phase: "execute", operation, arguments: argumentsValue });
      if (operation === "simulation.lifecycle.set") {
        state.lifecycle = argumentsValue.state;
        return structuredClone(state);
      }
      if (operation === "simulation.key.setPose") {
        state.key = { ...state.key, ...argumentsValue };
        state.lock = {
          state: argumentsValue.yMm <= 1000 ? "unlocked" : "locked",
          authorized: argumentsValue.yMm <= 1000,
        };
        return structuredClone(state);
      }
      if (operation === "simulation.lock.setExpectedId") {
        state.expectedId = argumentsValue.expectedId;
        return structuredClone(state);
      }
      if (operation === "simulation.scenario.run") {
        context.emit("scenario.progress", { completed: 1, total: 1 });
        state.lifecycle = "paused";
        return { name: argumentsValue.name, passed: true };
      }
      if (operation === "diagnostics.run.start") {
        context.emit("diagnostics.progress", { completed: 1, total: 1 });
        return { healthy: true };
      }
      throw new Error(`unexpected execute ${operation}`);
    },
  };
}

async function waitForOperation(runtime, operationId) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const operation = runtime.operations.get(operationId);
    if (["succeeded", "failed"].includes(operation.status)) {
      return operation;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("operation did not finish");
}

test("query 返回稳定 stateRevision，且接受 UI 约定 body", async () => {
  const runtime = createDigitalKeyRuntime({
    mode: "simulation",
    domain: createDomain(),
  });
  const request = {
    operation: "simulation.state.get",
    arguments: {},
    requestId: "request-query-0001",
  };

  const first = await runtime.query(request);
  const second = await runtime.query(request);

  assert.equal(first.requestId, request.requestId);
  assert.equal(first.operation, request.operation);
  assert.equal(first.data.lifecycle, "paused");
  assert.match(first.stateRevision, /^[0-9a-f]{64}$/);
  assert.equal(first.stateRevision, second.stateRevision);
});

test("默认 runtime 延迟接入真实数字钥匙领域模块", async () => {
  const runtime = createDigitalKeyRuntime({ mode: "simulation" });
  const plan = await runtime.plan({
    operation: "simulation.key.setPose",
    arguments: {
      active: true,
      keyAddress: 0x1113,
      xMm: 0,
      yMm: 1200,
      timeMs: 100,
    },
    idempotencyKey: "agent-default-domain-0001",
  });
  await runtime.execute({
    operation: "simulation.key.setPose",
    arguments: {
      active: true,
      keyAddress: 0x1113,
      xMm: 0,
      yMm: 1200,
      timeMs: 100,
    },
    idempotencyKey: "agent-default-domain-0001",
    planId: plan.planId,
  });
  const lock = await runtime.query({
    operation: "lock.snapshot.get",
    arguments: {},
  });

  assert.equal(lock.data.state, "unlocked");
  assert.equal(lock.data.authorized, true);
});

test("排队中的异步操作可以取消且不会执行领域副作用", async () => {
  const domain = createDomain();
  const runtime = createDigitalKeyRuntime({ mode: "simulation", domain });
  const current = await runtime.query({
    operation: "simulation.state.get",
    arguments: {},
  });
  const command = {
    operation: "simulation.scenario.run",
    arguments: { name: "fixed-seed-entry", seed: 7 },
    expectedStateRevision: current.stateRevision,
    idempotencyKey: "cancel-scenario-0001",
  };
  const plan = await runtime.plan(command);
  const accepted = await runtime.execute({
    ...command,
    planId: plan.planId,
  });
  const operationId = accepted.operationRecord.id;

  const cancelled = runtime.operations.cancel(operationId);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(cancelled.status, "cancelled");
  assert.equal(runtime.operations.get(operationId).status, "cancelled");
  assert.equal(
    domain.calls.some(
      (call) =>
        call.phase === "execute" &&
        call.operation === "simulation.scenario.run",
    ),
    false,
  );
});

test("workbench 模式同时路由仿真领域与 4173 只读代理", async () => {
  const liveCalls = [];
  const runtime = createDigitalKeyRuntime({
    mode: "workbench",
    domain: createDomain(),
    liveProxy: {
      async query(operation, argumentsValue) {
        liveCalls.push({ operation, argumentsValue });
        return { connected: true, port: "COM6" };
      },
    },
  });

  const simulation = await runtime.query({
    operation: "simulation.state.get",
    arguments: {},
  });
  const live = await runtime.query({
    operation: "recorder.status.get",
    arguments: {},
  });

  assert.equal(simulation.data.lifecycle, "paused");
  assert.equal(live.data.port, "COM6");
  assert.deepEqual(liveCalls, [
    { operation: "recorder.status.get", argumentsValue: {} },
  ]);
});

test("故障配置通过 Agent 命令进入服务端状态并改变测量", async () => {
  const runtime = createDigitalKeyRuntime({ mode: "simulation" });
  const current = await runtime.query({
    operation: "simulation.state.get",
    arguments: {},
  });
  const command = {
    operation: "simulation.faults.set",
    arguments: { profile: "anchor" },
    expectedStateRevision: current.stateRevision,
    idempotencyKey: "fault-profile-anchor-0001",
  };
  const plan = await runtime.plan(command);
  const result = await runtime.execute({
    ...command,
    planId: plan.planId,
  });

  assert.equal(result.data.faultProfile, "anchor");
  assert.equal(result.data.snapshot.measurement.channels[1].valid, false);
  assert.equal(result.data.snapshot.measurement.channels[1].fault, "disabled");
});

test("plan 和 execute dryRun 只校验与预览，不产生状态写入", async () => {
  const domain = createDomain();
  const runtime = createDigitalKeyRuntime({ mode: "simulation", domain });
  const current = await runtime.query({
    operation: "simulation.state.get",
    arguments: {},
  });
  const request = {
    operation: "simulation.key.setPose",
    arguments: { xMm: 120, yMm: 800 },
    requestId: "request-plan-0001",
    expectedStateRevision: current.stateRevision,
    idempotencyKey: "agent-pose-plan-0001",
  };

  const plan = await runtime.plan(request);
  const dryRun = await runtime.execute({ ...request, dryRun: true });

  assert.equal(plan.dryRun, true);
  assert.match(plan.planId, /^plan_/);
  assert.equal(dryRun.dryRun, true);
  assert.equal(plan.changesState, true);
  assert.equal(
    domain.calls.filter((call) => call.phase === "execute").length,
    0,
  );
});

test("execute 可使用 planId 继承计划时捕获的 revision", async () => {
  const domain = createDomain();
  const runtime = createDigitalKeyRuntime({ mode: "simulation", domain });
  const plan = await runtime.plan({
    operation: "simulation.key.setPose",
    arguments: { xMm: 0, yMm: 700 },
    requestId: "request-plan-id-0001",
    idempotencyKey: "agent-plan-id-execute-0001",
  });

  const result = await runtime.execute({
    operation: "simulation.key.setPose",
    arguments: { xMm: 0, yMm: 700 },
    requestId: "request-plan-id-execute-0001",
    idempotencyKey: "agent-plan-id-execute-0001",
    planId: plan.planId,
  });

  assert.equal(result.idempotentReplay, false);
  assert.match(result.stateRevision, /^[0-9a-f]{64}$/);
  assert.equal(
    domain.calls.filter((call) => call.phase === "execute").length,
    1,
  );
});

test("execute 校验 revision，并用幂等键保证副作用只发生一次", async () => {
  const domain = createDomain();
  const runtime = createDigitalKeyRuntime({ mode: "simulation", domain });
  const current = await runtime.query({
    operation: "simulation.state.get",
    arguments: {},
  });
  const request = {
    operation: "simulation.key.setPose",
    arguments: { xMm: 0, yMm: 700 },
    requestId: "request-execute-0001",
    expectedStateRevision: current.stateRevision,
    idempotencyKey: "agent-pose-execute-0001",
  };

  const first = await runtime.execute(request);
  const replay = await runtime.execute(request);

  assert.equal(first.idempotentReplay, false);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(first.stateRevision, replay.stateRevision);
  assert.equal(
    domain.calls.filter(
      (call) =>
        call.phase === "execute" &&
        call.operation === "simulation.key.setPose",
    ).length,
    1,
  );
  assert.equal(
    runtime.events.list({ type: "state.changed" }).length,
    1,
  );

  await assert.rejects(
    runtime.execute({
      operation: "simulation.lifecycle.set",
      arguments: { state: "running" },
      expectedStateRevision: current.stateRevision,
      idempotencyKey: "agent-lifecycle-execute-0001",
    }),
    (error) =>
      error.code === "REVISION_CONFLICT" &&
      error.details.actualStateRevision === first.stateRevision,
  );
});

test("同一幂等键不能绑定不同请求", async () => {
  const runtime = createDigitalKeyRuntime({
    mode: "simulation",
    domain: createDomain(),
  });
  const current = await runtime.query({
    operation: "simulation.state.get",
    arguments: {},
  });
  const base = {
    operation: "simulation.key.setPose",
    expectedStateRevision: current.stateRevision,
    idempotencyKey: "agent-pose-reuse-0001",
  };

  await runtime.execute({
    ...base,
    arguments: { xMm: 0, yMm: 700 },
  });
  await assert.rejects(
    runtime.execute({
      ...base,
      arguments: { xMm: 0, yMm: 800 },
    }),
    (error) => error.code === "IDEMPOTENCY_KEY_REUSED",
  );
});

test("长任务可通过 operations 查询，并通过事件流观察进度和状态变化", async () => {
  const runtime = createDigitalKeyRuntime({
    mode: "simulation",
    domain: createDomain(),
    operationIdFactory: () => "op_scenario_0001",
  });
  const current = await runtime.query({
    operation: "simulation.state.get",
    arguments: {},
  });

  const accepted = await runtime.execute({
    operation: "simulation.scenario.run",
    arguments: { name: "fixed-seed-entry", seed: 20260730 },
    expectedStateRevision: current.stateRevision,
    idempotencyKey: "agent-scenario-run-0001",
  });
  const finished = await waitForOperation(
    runtime,
    accepted.operationRecord.id,
  );

  assert.equal(accepted.accepted, true);
  assert.equal(finished.status, "succeeded");
  assert.deepEqual(finished.result, {
    name: "fixed-seed-entry",
    passed: true,
  });
  assert.deepEqual(
    runtime.events
      .list({ operationId: finished.id })
      .map((event) => event.type),
    [
      "operation.queued",
      "operation.started",
      "scenario.progress",
      "state.changed",
      "operation.succeeded",
    ],
  );
});
