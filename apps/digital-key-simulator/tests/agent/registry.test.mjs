import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_SCHEMA_VERSION,
  DigitalKeyCommandRegistry,
  createDigitalKeyRuntime,
} from "../../src/agent/index.js";

const SIMULATION_OPERATIONS = [
  "simulation.state.get",
  "lock.snapshot.get",
  "simulation.lifecycle.set",
  "simulation.key.setPose",
  "simulation.lock.setExpectedId",
  "simulation.faults.set",
  "simulation.scenario.run",
  "diagnostics.run.start",
];

test("DigitalKeyCommandRegistry 渐进公开摘要与完整 JSON Schema", () => {
  assert.equal(AGENT_SCHEMA_VERSION, "1.2.0");
  const registry = new DigitalKeyCommandRegistry({ mode: "simulation" });
  const overview = registry.list();

  assert.deepEqual(
    overview.commands.map((command) => command.operation),
    SIMULATION_OPERATIONS,
  );
  assert.match(overview.revision, /^[0-9a-f]{64}$/);
  assert.equal(overview.commands[0].argumentsSchema, undefined);

  const command = registry.describe("simulation.key.setPose");
  assert.equal(
    command.argumentsSchema.$schema,
    "https://json-schema.org/draft/2020-12/schema",
  );
  assert.equal(command.argumentsSchema.type, "object");
  assert.equal(command.argumentsSchema.additionalProperties, false);
  assert.equal(command.requiresIdempotencyKey, true);
  assert.equal(command.requiresStateRevision, true);
  assert.deepEqual(command.risk, {
    level: "medium",
    tier: "warned",
    reason: "改变仿真钥匙位置并触发门锁状态重算",
  });
});

test("实机模式能力表公开只读监看与受控持续标定命令", () => {
  const registry = new DigitalKeyCommandRegistry({ mode: "live" });

  assert.deepEqual(
    registry.list().commands.map((command) => command.operation),
    [
      "recorder.status.get",
      "recorder.position.get",
      "recorder.calibration.get",
      "recorder.measurements.list",
      "recorder.sessions.list",
      "device.ports.list",
      "device.serial.connect",
      "device.serial.disconnect",
      "calibration.setup.configure",
      "calibration.point.capture",
      "calibration.candidate.get",
      "calibration.model.activate",
      "calibration.model.rollback",
    ],
  );
  const candidate = registry.describe("calibration.candidate.get");
  assert.equal(candidate.kind, "query");
  assert.equal(candidate.safety, "read");
  assert.equal(candidate.risk.tier, "open");

  const ports = registry.describe("device.ports.list");
  assert.equal(ports.kind, "query");
  assert.equal(ports.safety, "read");
  assert.equal(ports.requiresStateRevision, false);

  const connect = registry.describe("device.serial.connect");
  assert.equal(connect.kind, "command");
  assert.equal(connect.execution, "immediate");
  assert.equal(connect.changesState, true);
  assert.equal(connect.requiresIdempotencyKey, true);
  assert.equal(connect.requiresStateRevision, true);
  assert.deepEqual(
    connect.argumentsSchema.properties.baudRate.enum,
    [
      9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600,
      1000000, 2000000,
    ],
  );
  assert.throws(
    () =>
      registry.validate("device.serial.connect", {
        path: "COM6",
        baudRate: 12345,
      }),
    (error) => error.code === "VALIDATION_ERROR",
  );

  const disconnect = registry.describe("device.serial.disconnect");
  assert.equal(disconnect.kind, "command");
  assert.equal(disconnect.changesState, true);
  assert.equal(disconnect.requiresIdempotencyKey, true);
  assert.equal(disconnect.requiresStateRevision, true);

  for (const operation of [
    "calibration.setup.configure",
    "calibration.point.capture",
    "calibration.model.activate",
    "calibration.model.rollback",
  ]) {
    const command = registry.describe(operation);
    assert.equal(command.kind, "command");
    assert.equal(command.safety, "mutating");
    assert.equal(command.requiresIdempotencyKey, true);
    assert.equal(command.requiresStateRevision, true);
    assert.equal(command.risk.tier, "warned");
  }
  assert.throws(
    () => registry.describe("lock.forceOpen"),
    (error) => error.code === "OPERATION_NOT_ALLOWED",
  );
});

test("workbench registry 同时发现仿真、UWB Lab 与持续标定命令", () => {
  const registry = new DigitalKeyCommandRegistry({ mode: "workbench" });
  const operations = registry
    .list()
    .commands.map((command) => command.operation);

  assert.equal(operations.length, 21);
  assert.ok(operations.includes("simulation.state.get"));
  assert.ok(operations.includes("recorder.status.get"));
  assert.ok(operations.includes("recorder.position.get"));
  assert.ok(operations.includes("recorder.calibration.get"));
  assert.ok(operations.includes("recorder.measurements.list"));
  assert.ok(operations.includes("recorder.sessions.list"));
  assert.ok(operations.includes("device.ports.list"));
  assert.ok(operations.includes("device.serial.connect"));
  assert.ok(operations.includes("device.serial.disconnect"));
  assert.ok(operations.includes("calibration.setup.configure"));
  assert.ok(operations.includes("calibration.point.capture"));
  assert.ok(operations.includes("calibration.candidate.get"));
  assert.ok(operations.includes("calibration.model.activate"));
  assert.ok(operations.includes("calibration.model.rollback"));
});

test("createDigitalKeyRuntime 是公开工厂且不需要监听端口", () => {
  const runtime = createDigitalKeyRuntime({
    mode: "simulation",
    domain: {
      async query() {
        return {};
      },
      async execute() {
        return {};
      },
    },
  });

  assert.equal(runtime.mode, "simulation");
  assert.equal(typeof runtime.query, "function");
  assert.equal(typeof runtime.plan, "function");
  assert.equal(typeof runtime.execute, "function");
  assert.equal(typeof runtime.operations.get, "function");
  assert.equal(typeof runtime.events.subscribe, "function");
  assert.equal("listen" in runtime, false);
});
