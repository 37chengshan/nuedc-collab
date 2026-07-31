import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { createApiServer } from "../src/api-server.js";

async function withServer(calibration, callback, finalCalibration = null) {
  const server = createApiServer({
    http: { createServer },
    service: {
      status: () => ({ connected: true }),
      listPorts: async () => [],
    },
    calibration,
    finalCalibration,
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

test("calibration API exposes plan, capture, train, validate and export", async () => {
  const received = [];
  const calibration = {
    plan: (input) => ({ points: [{ id: "p1" }], ...input }),
    capture: async (input) => {
      received.push(["capture", input]);
      return { accepted: true, pointId: "p1" };
    },
    train: async (input) => {
      received.push(["train", input]);
      return { model: { version: 1 } };
    },
    validate: async (input) => {
      received.push(["validate", input]);
      return { passed: true };
    },
    export: async (input) => {
      received.push(["export", input]);
      return { header: "#pragma once", source: "const int x = 1;" };
    },
  };

  await withServer(calibration, async (baseUrl) => {
    const plan = await fetch(`${baseUrl}/api/calibration/plan`).then((response) =>
      response.json(),
    );
    assert.equal(plan.data.points.length, 1);

    for (const action of ["capture", "train", "validate", "export"]) {
      const response = await fetch(`${baseUrl}/api/calibration/${action}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `${action}-key`,
        },
        body: JSON.stringify({ dryRun: action === "export" }),
      }).then((value) => value.json());
      assert.equal(response.ok, true);
    }
  });

  assert.equal(received.length, 4);
  assert.equal(received[0][1].idempotencyKey, "capture-key");
  assert.equal(received[3][1].dryRun, true);
});

test("final calibration API exposes model status and realtime estimate", async () => {
  const finalCalibration = {
    status: () => ({
      ready: true,
      captureCount: 18,
      metrics: { distanceMaxErrorM: 0.12 },
    }),
    estimateLatest: async () => ({
      valid: true,
      distanceM: 1.02,
      angleDeg: 14.2,
      angleValid: true,
    }),
    exportFirmware: (input) => ({
      name: input.name,
      prototypeCount: 66,
      legacyTrainingPointCount: 18,
      structuredTrainingPointCount: 48,
      header: "#pragma once",
      source: "const int empirical = 1;",
    }),
  };

  await withServer(
    { plan: () => ({ points: [] }) },
    async (baseUrl) => {
      const model = await fetch(
        `${baseUrl}/api/calibration/final`,
      ).then((response) => response.json());
      assert.equal(model.ok, true);
      assert.equal(model.data.captureCount, 18);

      const position = await fetch(`${baseUrl}/api/position`).then((response) =>
        response.json(),
      );
      assert.equal(position.ok, true);
      assert.equal(position.data.valid, true);
      assert.equal(position.data.distanceM, 1.02);

      const exported = await fetch(`${baseUrl}/api/calibration/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "empirical_model_data" }),
      }).then((response) => response.json());
      assert.equal(exported.ok, true);
      assert.equal(exported.data.prototypeCount, 66);
      assert.equal(exported.data.legacyTrainingPointCount, 18);
    },
    finalCalibration,
  );
});
