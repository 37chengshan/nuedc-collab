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

test("实机代理只向 4173 发起 status/measurements/sessions GET", async () => {
  const calls = [];
  const proxy = new UwbRecorderReadOnlyProxy({
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({ source: new URL(url).pathname });
    },
  });

  await proxy.query("recorder.status.get", {});
  await proxy.query("recorder.measurements.list", {
    limit: 20,
    device: 2,
    sinceMs: 5000,
    sessionId: "session-1",
  });
  await proxy.query("recorder.sessions.list", {});

  assert.deepEqual(
    calls.map((call) => new URL(call.url).origin),
    [
      "http://127.0.0.1:4173",
      "http://127.0.0.1:4173",
      "http://127.0.0.1:4173",
    ],
  );
  assert.ok(calls.every((call) => call.options.method === "GET"));
  assert.equal(new URL(calls[0].url).pathname, "/api/status");
  assert.equal(new URL(calls[1].url).pathname, "/api/measurements");
  assert.equal(new URL(calls[2].url).pathname, "/api/sessions");
  assert.equal(new URL(calls[1].url).searchParams.get("device"), "2");
});

test("实机 runtime 拒绝抢串口、写参数和强制开锁", async () => {
  const runtime = createDigitalKeyRuntime({
    mode: "live",
    liveProxy: new UwbRecorderReadOnlyProxy({
      fetchImpl: async () => jsonResponse({ connected: false }),
    }),
  });

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

