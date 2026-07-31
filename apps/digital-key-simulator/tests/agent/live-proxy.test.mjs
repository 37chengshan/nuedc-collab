import assert from "node:assert/strict";
import test from "node:test";

import {
  UwbRecorderReadOnlyProxy,
  createDigitalKeyRuntime,
} from "../../src/agent/index.js";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify({ ok: status < 400, data }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("实机代理只向 4173 发起监看、串口与持续标定受控请求", async () => {
  const calls = [];
  const proxy = new UwbRecorderReadOnlyProxy({
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({ source: new URL(url).pathname });
    },
  });

  await proxy.query("recorder.status.get", {});
  await proxy.query("device.ports.list", {});
  await proxy.query("recorder.position.get", {});
  await proxy.query("recorder.calibration.get", {});
  await proxy.query("recorder.measurements.list", {
    limit: 20,
    device: 2,
    sinceMs: 5000,
    sessionId: "session-1",
  });
  await proxy.query("recorder.sessions.list", {});
  await proxy.query("calibration.candidate.get", {});
  await proxy.execute("device.serial.connect", {
    path: "COM6",
    baudRate: 115200,
  });
  await proxy.execute("device.serial.disconnect", {});
  await proxy.execute("calibration.setup.configure", {
    setupRevision: "setup-r1",
    lock: { xMm: 0, yMm: 0, zMm: 0 },
    anchors: [
      { id: "A1", xMm: -125, yMm: 40, zMm: 0 },
      { id: "A2", xMm: 125, yMm: 40, zMm: 0 },
    ],
  });
  await proxy.execute("calibration.point.capture", {
    setupRevision: "setup-r1",
    xMm: 0,
    yMm: 1000,
    zMm: 0,
  });
  await proxy.execute("calibration.model.activate", {
    setupRevision: "setup-r1",
    candidateVersion: "candidate-1",
  });
  await proxy.execute("calibration.model.rollback", {
    setupRevision: "setup-r1",
  });

  assert.deepEqual(
    calls.map((call) => new URL(call.url).origin),
    Array.from({ length: 13 }, () => "http://127.0.0.1:4173"),
  );
  assert.ok(calls.slice(0, 7).every((call) => call.options.method === "GET"));
  assert.ok(calls.slice(7).every((call) => call.options.method === "POST"));
  assert.equal(new URL(calls[0].url).pathname, "/api/status");
  assert.equal(new URL(calls[1].url).pathname, "/api/ports");
  assert.equal(new URL(calls[2].url).pathname, "/api/position");
  assert.equal(new URL(calls[3].url).pathname, "/api/calibration/final");
  assert.equal(new URL(calls[4].url).pathname, "/api/measurements");
  assert.equal(new URL(calls[5].url).pathname, "/api/sessions");
  assert.equal(
    new URL(calls[6].url).pathname,
    "/api/calibration/continuous",
  );
  assert.equal(new URL(calls[7].url).pathname, "/api/connect");
  assert.equal(new URL(calls[8].url).pathname, "/api/disconnect");
  assert.equal(
    new URL(calls[9].url).pathname,
    "/api/calibration/continuous/setup",
  );
  assert.equal(
    new URL(calls[10].url).pathname,
    "/api/calibration/continuous/points:capture",
  );
  assert.equal(
    new URL(calls[11].url).pathname,
    "/api/calibration/continuous/models:activate",
  );
  assert.equal(
    new URL(calls[12].url).pathname,
    "/api/calibration/continuous/models:rollback",
  );
  assert.equal(new URL(calls[4].url).searchParams.get("device"), "2");
  assert.equal(calls[7].options.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[7].options.body), {
    path: "COM6",
    baudRate: 115200,
  });
  assert.deepEqual(JSON.parse(calls[8].options.body), {});
  assert.equal(
    JSON.parse(calls[10].options.body).setupRevision,
    "setup-r1",
  );
});

test("串口连接和断开沿用 plan、revision、dry-run、幂等与状态读回", async () => {
  const calls = [];
  let status = {
    connected: false,
    port: null,
    baudRate: null,
    eventSequence: 0,
  };
  const runtime = createDigitalKeyRuntime({
    mode: "live",
    liveProxy: {
      async query(operation) {
        calls.push(["query", operation]);
        if (operation === "device.ports.list") {
          return [{ path: "COM6", manufacturer: "STMicroelectronics" }];
        }
        if (operation === "recorder.status.get") {
          return structuredClone(status);
        }
        throw new Error(`unexpected query: ${operation}`);
      },
      async execute(operation, argumentsValue) {
        calls.push(["execute", operation, argumentsValue]);
        if (operation === "device.serial.connect") {
          status = {
            ...status,
            connected: true,
            port: argumentsValue.path,
            baudRate: argumentsValue.baudRate,
            eventSequence: 1,
          };
          return structuredClone(status);
        }
        if (operation === "device.serial.disconnect") {
          status = {
            ...status,
            connected: false,
            port: null,
            baudRate: null,
            eventSequence: 2,
          };
          return structuredClone(status);
        }
        throw new Error(`unexpected execute: ${operation}`);
      },
    },
  });

  const ports = await runtime.query({
    operation: "device.ports.list",
    arguments: {},
  });
  assert.equal(ports.data[0].path, "COM6");

  const connectRequest = {
    operation: "device.serial.connect",
    arguments: { path: "COM6", baudRate: 115200 },
    idempotencyKey: "serial-connect-live-0001",
  };
  const connectPlan = await runtime.plan(connectRequest);
  const connectDryRun = await runtime.execute({
    ...connectRequest,
    dryRun: true,
  });
  assert.equal(connectPlan.dryRun, true);
  assert.equal(connectDryRun.dryRun, true);
  assert.equal(
    calls.filter(
      ([kind, operation]) =>
        kind === "execute" && operation === "device.serial.connect",
    ).length,
    0,
  );

  const connected = await runtime.execute({
    ...connectRequest,
    planId: connectPlan.planId,
  });
  const replay = await runtime.execute({
    ...connectRequest,
    planId: connectPlan.planId,
  });
  assert.equal(connected.data.connected, true);
  assert.equal(connected.idempotentReplay, false);
  assert.equal(replay.idempotentReplay, true);
  assert.notEqual(
    connected.stateRevision,
    connectPlan.expectedStateRevision,
  );
  assert.equal(connected.stateRevision, replay.stateRevision);
  assert.equal(
    calls.filter(
      ([kind, operation]) =>
        kind === "execute" && operation === "device.serial.connect",
    ).length,
    1,
  );

  await assert.rejects(
    runtime.execute({
      operation: "device.serial.disconnect",
      arguments: {},
      idempotencyKey: "serial-disconnect-stale-0001",
      expectedStateRevision: connectPlan.expectedStateRevision,
    }),
    (error) => error.code === "REVISION_CONFLICT",
  );
  assert.equal(
    calls.filter(
      ([kind, operation]) =>
        kind === "execute" && operation === "device.serial.disconnect",
    ).length,
    0,
  );

  const disconnectPlan = await runtime.plan({
    operation: "device.serial.disconnect",
    arguments: {},
    idempotencyKey: "serial-disconnect-live-0001",
    expectedStateRevision: connected.stateRevision,
  });
  const disconnected = await runtime.execute({
    operation: "device.serial.disconnect",
    arguments: {},
    idempotencyKey: "serial-disconnect-live-0001",
    planId: disconnectPlan.planId,
  });
  assert.equal(disconnected.data.connected, false);
  assert.notEqual(disconnected.stateRevision, connected.stateRevision);
  assert.ok(
    calls.filter(
      ([kind, operation]) =>
        kind === "query" && operation === "recorder.status.get",
    ).length >= 5,
  );
  assert.equal(
    calls.some(
      ([kind, operation]) =>
        kind === "query" && operation === "calibration.candidate.get",
    ),
    false,
  );
});

test("实机 runtime 允许经4173执行持续标定但仍拒绝抢串口和强制开锁", async () => {
  const calls = [];
  const runtime = createDigitalKeyRuntime({
    mode: "live",
    liveProxy: {
      async query(operation) {
        calls.push(["query", operation]);
        return { setupRevision: "setup-r1", activeModelVersion: "model-1" };
      },
      async execute(operation, argumentsValue) {
        calls.push(["execute", operation, argumentsValue]);
        return {
          setupRevision: argumentsValue.setupRevision,
          candidateVersion: "candidate-1",
        };
      },
    },
  });

  const argumentsValue = {
    setupRevision: "setup-r1",
    xMm: 0,
    yMm: 1000,
    zMm: 0,
  };
  const idempotencyKey = "capture-point-live-1";
  const plan = await runtime.plan({
    operation: "calibration.point.capture",
    arguments: argumentsValue,
    idempotencyKey,
  });
  const accepted = await runtime.execute({
    operation: "calibration.point.capture",
    arguments: argumentsValue,
    idempotencyKey,
    planId: plan.planId,
  });
  assert.equal(accepted.operation, "calibration.point.capture");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const record = runtime.operations.get(accepted.operationRecord.id);
    if (["succeeded", "failed"].includes(record.status)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(
    calls.some(
      ([kind, operation]) =>
        kind === "execute" && operation === "calibration.point.capture",
    ),
  );

  for (const operation of [
    "recorder.connect",
    "recorder.parameters.write",
    "lock.forceOpen",
    "simulation.key.setPose",
  ]) {
    await assert.rejects(
      runtime.execute({
        operation,
        arguments: {},
        idempotencyKey: `forbidden-${operation}`,
      }),
      (error) => error.code === "LIVE_MODE_READ_ONLY",
    );
  }
});
