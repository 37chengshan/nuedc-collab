import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { createApiServer } from "../src/api-server.js";

async function withServer(service, callback) {
  const server = createApiServer({
    http: { createServer },
    service,
    root: process.cwd(),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function createStubService() {
  const capture = {
    id: "capture-1",
    label: "双路-中轴-1m",
    durationSeconds: 45,
    status: "recording",
    frameCount: 0,
  };
  return {
    status: () => ({ connected: true }),
    listPorts: async () => [],
    startCapture: async (input) => ({ ...capture, ...input }),
    currentCapture: () => capture,
    listCaptures: async () => [{ ...capture, status: "completed", frameCount: 2 }],
    getCaptureMeasurements: async () => [
      { device: 1, distanceCm: 101 },
      { device: 2, distanceCm: 103 },
    ],
    exportCaptureCsv: async () => "distance_cm\r\n101\r\n103",
  };
}

test("采集API支持启动、状态、列表、测量值和CSV导出", async () => {
  await withServer(createStubService(), async (baseUrl) => {
    const startResponse = await fetch(`${baseUrl}/api/captures`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: "双路-中轴-1m",
        durationSeconds: 45,
      }),
    });
    const started = await startResponse.json();
    assert.equal(started.ok, true);
    assert.equal(started.data.label, "双路-中轴-1m");

    const current = await fetch(`${baseUrl}/api/captures/current`).then(
      (response) => response.json(),
    );
    assert.equal(current.data.status, "recording");

    const captures = await fetch(`${baseUrl}/api/captures`).then((response) =>
      response.json(),
    );
    assert.equal(captures.data[0].frameCount, 2);

    const measurements = await fetch(
      `${baseUrl}/api/captures/capture-1/measurements`,
    ).then((response) => response.json());
    assert.equal(measurements.data.length, 2);

    const csvResponse = await fetch(
      `${baseUrl}/api/captures/capture-1/export.csv`,
    );
    assert.match(await csvResponse.text(), /101/);
  });
});
