import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { createApiServer } from "../src/api-server.js";

async function withServer(
  calibration,
  callback,
  finalCalibration = null,
  continuousCalibration = null,
) {
  const server = createApiServer({
    http: { createServer },
    service: {
      status: () => ({ connected: true }),
      listPorts: async () => [],
    },
    calibration,
    finalCalibration,
    continuousCalibration,
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

test("continuous calibration API exposes agreed capture orchestration paths and rejects forged records", async () => {
  const calls = [];
  const continuousCalibration = {
    status: () => ({ setup: null, active: null, history: [] }),
    configureSetup: async (input) => {
      calls.push(["setup", input]);
      return { setupKey: `${input.id}@${input.revision}` };
    },
    captureCalibrationPoint: async (input) => {
      calls.push(["capture-point", input]);
      return {
        record: { id: "serial-capture-1" },
        candidate: { id: "candidate-1", admission: { passed: true } },
      };
    },
    activateCandidate: async (input) => {
      calls.push(["activate", input]);
      return { versionId: "version-1" };
    },
    rollback: async (input) => {
      calls.push(["rollback", input]);
      return { versionId: "version-0" };
    },
  };

  await withServer(
    { plan: () => ({ points: [] }) },
    async (baseUrl) => {
      const status = await fetch(
        `${baseUrl}/api/calibration/continuous`,
      ).then((response) => response.json());
      assert.equal(status.ok, true);

      const requests = [
        [
          "POST",
          "setup",
          {
            id: "door",
            revision: 1,
            lock: { xMm: 0, yMm: 0, zMm: 800 },
            anchors: [
              { id: "A1", xMm: -125, yMm: 40, zMm: 1200 },
              { id: "A2", xMm: 125, yMm: 40, zMm: 1200 },
            ],
          },
        ],
        [
          "POST",
          "points:capture",
          {
            setupRevision: 1,
            xMm: 0,
            yMm: 1000,
            durationSeconds: 15,
          },
        ],
        ["POST", "models:activate", { candidateId: "candidate-1" }],
        ["POST", "models:rollback", {}],
      ];
      for (const [method, action, body] of requests) {
        const response = await fetch(
          `${baseUrl}/api/calibration/continuous/${action}`,
          {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        ).then((value) => value.json());
        assert.equal(response.ok, true);
      }

      const forged = await fetch(
        `${baseUrl}/api/calibration/continuous/records`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            perAnchor: [{ anchorId: "A1", medianMm: 123 }],
          }),
        },
      ).then((response) => response.json());
      assert.equal(forged.ok, false);
      assert.equal(forged.error.code, "NOT_FOUND");
    },
    null,
    continuousCalibration,
  );

  assert.deepEqual(
    calls.map(([action]) => action),
    ["setup", "capture-point", "activate", "rollback"],
  );
});
