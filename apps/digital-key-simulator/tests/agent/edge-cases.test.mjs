import assert from "node:assert/strict";
import test from "node:test";

import {
  DigitalKeyCommandRegistry,
  UwbRecorderReadOnlyProxy,
  createDigitalKeyRuntime,
} from "../../src/agent/index.js";

function stateDomain(options = {}) {
  const state = {
    lifecycle: "paused",
    key: { xMm: 0, yMm: 2500 },
  };
  return {
    async query(operation) {
      if (operation === "simulation.state.get") {
        return structuredClone(state);
      }
      if (operation === "lock.snapshot.get") {
        return { state: "locked" };
      }
      throw new Error(`unexpected query ${operation}`);
    },
    async execute(operation, argumentsValue) {
      if (options.failExecute) {
        throw new Error("simulated domain failure");
      }
      if (operation === "simulation.key.setPose") {
        state.key = { ...state.key, ...argumentsValue };
        return structuredClone(state);
      }
      return {};
    },
  };
}

test("注册表从同一 JSON Schema 拒绝缺字段、越界和额外字段", () => {
  const registry = new DigitalKeyCommandRegistry({ mode: "simulation" });

  assert.throws(
    () => registry.validate("simulation.key.setPose", { xMm: 1 }),
    (error) =>
      error.code === "VALIDATION_ERROR" &&
      error.details.path === "/yMm",
  );
  assert.throws(
    () =>
      registry.validate("simulation.lock.setExpectedId", {
        expectedId: 16,
      }),
    (error) => error.code === "VALIDATION_ERROR",
  );
  assert.throws(
    () =>
      registry.validate("simulation.lifecycle.set", {
        state: "running",
        forceOpen: true,
      }),
    (error) =>
      error.code === "VALIDATION_ERROR" &&
      error.details.path === "/forceOpen",
  );
  assert.throws(
    () => new DigitalKeyCommandRegistry({ mode: "hardware-write" }),
    (error) => error.code === "MODE_NOT_SUPPORTED",
  );
});

test("实机代理拒绝改端口并结构化上游网络与响应错误", async () => {
  assert.throws(
    () =>
      new UwbRecorderReadOnlyProxy({
        baseUrl: "http://127.0.0.1:4174",
      }),
    (error) => error.code === "LIVE_PROXY_TARGET_FORBIDDEN",
  );

  const unavailable = new UwbRecorderReadOnlyProxy({
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  await assert.rejects(
    unavailable.query("recorder.status.get"),
    (error) => error.code === "RECORDER_UNAVAILABLE" && error.retryable,
  );

  const invalidJson = new UwbRecorderReadOnlyProxy({
    fetchImpl: async () =>
      new Response("not-json", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      }),
  });
  await assert.rejects(
    invalidJson.query("recorder.sessions.list"),
    (error) => error.code === "RECORDER_INVALID_RESPONSE",
  );

  const upstreamFailure = new UwbRecorderReadOnlyProxy({
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: "SERIAL_BUSY",
            message: "busy",
            retryable: true,
          },
        }),
        {
          status: 409,
          headers: { "Content-Type": "application/json" },
        },
      ),
  });
  await assert.rejects(
    upstreamFailure.query("recorder.status.get"),
    (error) => error.code === "SERIAL_BUSY" && error.status === 409,
  );
});

test("runtime 拒绝错误调用通道、缺 revision 和不匹配计划", async () => {
  const runtime = createDigitalKeyRuntime({
    mode: "simulation",
    domain: stateDomain(),
  });

  await assert.rejects(
    runtime.query({
      operation: "simulation.key.setPose",
      arguments: { xMm: 0, yMm: 800 },
    }),
    (error) => error.code === "QUERY_OPERATION_REQUIRED",
  );
  await assert.rejects(
    runtime.execute({
      operation: "simulation.state.get",
      arguments: {},
      idempotencyKey: "agent-query-via-execute-0001",
    }),
    (error) => error.code === "COMMAND_OPERATION_REQUIRED",
  );
  await assert.rejects(
    runtime.execute({
      operation: "simulation.key.setPose",
      arguments: { xMm: 0, yMm: 800 },
      idempotencyKey: "agent-no-revision-0001",
    }),
    (error) => error.code === "STATE_REVISION_REQUIRED",
  );
  await assert.rejects(
    runtime.execute({
      operation: "simulation.key.setPose",
      arguments: { xMm: 0, yMm: 800 },
      idempotencyKey: "agent-missing-plan-0001",
      planId: "plan_missing",
    }),
    (error) => error.code === "PLAN_NOT_FOUND",
  );

  const plan = await runtime.plan({
    operation: "simulation.key.setPose",
    arguments: { xMm: 0, yMm: 800 },
    idempotencyKey: "agent-plan-mismatch-0001",
  });
  await assert.rejects(
    runtime.execute({
      operation: "simulation.key.setPose",
      arguments: { xMm: 0, yMm: 900 },
      idempotencyKey: "agent-plan-mismatch-0001",
      planId: plan.planId,
    }),
    (error) => error.code === "PLAN_MISMATCH",
  );
  assert.throws(
    () => runtime.operations.get("missing"),
    (error) => error.code === "OPERATION_NOT_FOUND",
  );
});

test("异步领域异常进入 failed operation 并发送 operation.failed", async () => {
  const runtime = createDigitalKeyRuntime({
    mode: "simulation",
    domain: stateDomain({ failExecute: true }),
    operationIdFactory: () => "op_failed_0001",
  });
  const state = await runtime.query({
    operation: "simulation.state.get",
    arguments: {},
  });
  const accepted = await runtime.execute({
    operation: "simulation.scenario.run",
    arguments: { name: "failure" },
    expectedStateRevision: state.stateRevision,
    idempotencyKey: "agent-failed-operation-0001",
  });

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (runtime.operations.get(accepted.operationRecord.id).status === "failed") {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const failed = runtime.operations.get(accepted.operationRecord.id);

  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "INTERNAL_ERROR");
  assert.equal(
    runtime.events
      .list({ operationId: failed.id })
      .at(-1).type,
    "operation.failed",
  );
});
