import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { createDigitalKeyRuntime } from "../../src/agent/index.js";
import { createDigitalKeyServer } from "../../src/server/index.js";

function createDomain() {
  const state = {
    lifecycle: "paused",
    key: { active: true, xMm: 0, yMm: 2500 },
    lock: { state: "locked" },
  };
  return {
    async query(operation) {
      if (operation === "simulation.state.get") {
        return structuredClone(state);
      }
      if (operation === "lock.snapshot.get") {
        return structuredClone(state.lock);
      }
      throw new Error(`unexpected query ${operation}`);
    },
    async execute(operation, argumentsValue) {
      if (operation === "simulation.key.setPose") {
        state.key = { ...state.key, ...argumentsValue };
        return structuredClone(state);
      }
      throw new Error(`unexpected execute ${operation}`);
    },
  };
}

async function startServer() {
  const runtime = createDigitalKeyRuntime({
    mode: "simulation",
    domain: createDomain(),
  });
  const server = createDigitalKeyServer({ runtime });
  assert.equal(server.listening, false);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    runtime,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function post(baseUrl, path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("createDigitalKeyServer 返回未监听的 Node http.Server", () => {
  const server = createDigitalKeyServer({
    runtime: createDigitalKeyRuntime({
      mode: "simulation",
      domain: createDomain(),
    }),
  });

  assert.equal(typeof server.listen, "function");
  assert.equal(server.listening, false);
  server.close();
});

test("v1 registry/query/plan/execute/operations 使用结构化 envelope", async (t) => {
  const app = await startServer();
  t.after(app.close);

  const registry = await fetch(
    `${app.baseUrl}/api/agent/v1/registry`,
  ).then((response) => response.json());
  assert.equal(registry.ok, true);
  assert.equal(registry.data.commands.length, 8);
  assert.equal(registry.data.commands[0].argumentsSchema, undefined);

  const described = await fetch(
    `${app.baseUrl}/api/agent/v1/registry/${encodeURIComponent("simulation.key.setPose")}`,
  ).then((response) => response.json());
  assert.equal(
    described.data.argumentsSchema.$schema,
    "https://json-schema.org/draft/2020-12/schema",
  );

  const query = await post(app.baseUrl, "/api/agent/v1/query", {
    operation: "simulation.state.get",
    arguments: {},
    requestId: "http-query-0001",
  }).then((response) => response.json());
  assert.equal(query.ok, true);
  assert.match(query.data.stateRevision, /^[0-9a-f]{64}$/);

  const command = {
    operation: "simulation.key.setPose",
    arguments: { xMm: 0, yMm: 700 },
    requestId: "http-execute-0001",
    expectedStateRevision: query.data.stateRevision,
    idempotencyKey: "http-pose-execute-0001",
  };
  const plan = await post(
    app.baseUrl,
    "/api/agent/v1/commands:plan",
    command,
  ).then((response) => response.json());
  assert.equal(plan.ok, true);
  assert.equal(plan.data.dryRun, true);

  const execute = await post(
    app.baseUrl,
    "/api/agent/v1/commands:execute",
    {
      operation: command.operation,
      arguments: command.arguments,
      requestId: command.requestId,
      idempotencyKey: command.idempotencyKey,
      planId: plan.data.planId,
    },
  ).then((response) => response.json());
  assert.equal(execute.ok, true);
  assert.equal(execute.data.idempotentReplay, false);

  const operationId = execute.data.operationRecord?.id;
  if (operationId) {
    const cancelled = await post(
      app.baseUrl,
      `/api/agent/v1/operations/${encodeURIComponent(operationId)}:cancel`,
      {},
    ).then((response) => response.json());
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.data.status, "cancelled");
  }

  const missingOperation = await fetch(
    `${app.baseUrl}/api/agent/v1/operations/missing`,
  );
  assert.equal(missingOperation.status, 404);
  assert.deepEqual(
    Object.keys((await missingOperation.json()).error).sort(),
    ["code", "details", "message", "retryable"],
  );
});

test("SSE 在状态写入后发送 state.changed", async (t) => {
  const app = await startServer();
  t.after(app.close);
  const controller = new AbortController();
  t.after(() => controller.abort());

  const stream = await fetch(`${app.baseUrl}/api/agent/v1/events`, {
    signal: controller.signal,
    headers: { Accept: "text/event-stream" },
  });
  assert.match(stream.headers.get("content-type"), /^text\/event-stream/);
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let text = decoder.decode((await reader.read()).value);
  assert.match(text, /event: ready/);

  const state = await app.runtime.query({
    operation: "simulation.state.get",
    arguments: {},
  });
  await app.runtime.execute({
    operation: "simulation.key.setPose",
    arguments: { xMm: 0, yMm: 700 },
    expectedStateRevision: state.stateRevision,
    idempotencyKey: "http-sse-pose-0001",
  });

  for (let attempt = 0; attempt < 10 && !text.includes("state.changed"); attempt += 1) {
    text += decoder.decode((await reader.read()).value);
  }
  assert.match(text, /event: state\.changed/);
  assert.match(text, /"stateRevision"/);
  controller.abort();
});

test("events 默认返回 JSON 回放，显式 Accept 才保持 SSE 长连接", async (t) => {
  const app = await startServer();
  t.after(app.close);

  const response = await fetch(
    `${app.baseUrl}/api/agent/v1/events?after=0&limit=20`,
    { headers: { Accept: "application/json" } },
  );
  const envelope = await response.json();

  assert.match(response.headers.get("content-type"), /^application\/json/);
  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.data.events, []);
  assert.equal(envelope.data.count, 0);
});

test("未知 Agent API 返回结构化 404", async (t) => {
  const app = await startServer();
  t.after(app.close);

  const response = await fetch(`${app.baseUrl}/api/agent/v1/not-found`);
  const envelope = await response.json();

  assert.equal(response.status, 404);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "NOT_FOUND");
  assert.equal(envelope.error.retryable, false);
});
