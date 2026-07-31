import assert from "node:assert/strict";
import test from "node:test";

import {
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

test("实机模式能力表只有 4173 的五个只读资源", () => {
  const registry = new DigitalKeyCommandRegistry({ mode: "live" });

  assert.deepEqual(
    registry.list().commands.map((command) => command.operation),
    [
      "recorder.status.get",
      "recorder.position.get",
      "recorder.calibration.get",
      "recorder.measurements.list",
      "recorder.sessions.list",
    ],
  );
  assert.ok(
    registry.list().commands.every(
      (command) =>
        command.kind === "query" &&
        command.safety === "read" &&
        command.risk.tier === "open",
    ),
  );
  assert.throws(
    () => registry.describe("lock.forceOpen"),
    (error) => error.code === "OPERATION_NOT_ALLOWED",
  );
});

test("workbench registry 同时发现仿真与 UWB Lab 只读命令", () => {
  const registry = new DigitalKeyCommandRegistry({ mode: "workbench" });
  const operations = registry
    .list()
    .commands.map((command) => command.operation);

  assert.equal(operations.length, 13);
  assert.ok(operations.includes("simulation.state.get"));
  assert.ok(operations.includes("recorder.status.get"));
  assert.ok(operations.includes("recorder.position.get"));
  assert.ok(operations.includes("recorder.calibration.get"));
  assert.ok(operations.includes("recorder.measurements.list"));
  assert.ok(operations.includes("recorder.sessions.list"));
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
