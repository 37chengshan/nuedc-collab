import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApiServer } from "../../../uwb-recorder/src/api-server.js";
import { createContinuousCalibrationService } from "../../../uwb-recorder/src/continuous-calibration-service.js";
import { createDigitalKeyRuntime } from "../../src/agent/index.js";

test("4180 Registry命令经受控代理调用4173持续标定服务", async () => {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "digital-key-calibration-stack-"),
  );
  const continuousCalibration = await createContinuousCalibrationService({
    stateDirectory,
    captureSource: {
      async capturePoint() {
        return {
          captureId: "serial-capture-stack",
          startedAt: "2026-07-31T04:00:00.000Z",
          measurements: [
            frame("2026-07-31T04:00:03.000Z", 1, 100),
            frame("2026-07-31T04:00:03.020Z", 2, 101),
          ],
        };
      },
    },
    captureAssessor: async () => ({
      accepted: true,
      synchronizedGroups: 100,
      perAnchor: [
        { anchorId: "A1", medianMm: 1000, madMm: 5, snrDb: 20 },
        { anchorId: "A2", medianMm: 1010, madMm: 6, snrDb: 19 },
      ],
      recaptureReasons: [],
    }),
    candidateBuilder: () => ({
      model: {
        version: 1,
        rangeKnots: { A1: [{ measuredMm: 1000, distanceMm: 1000 }] },
        primaryAnchorId: "A1",
      },
      metrics: {
        distanceMaxErrorM: 0.1,
        distanceP95M: 0.08,
        angleMaxErrorDeg: 5,
        angleP95Deg: 3,
        boundaryPointCount: 1,
        boundaryMaxErrorM: 0.1,
        boundaryP95M: 0.08,
        boundaryCrossingCount: 0,
      },
      baselineMetrics: null,
      admission: { passed: true, reasons: [] },
      training: { pointCount: 4 },
      validation: { pointCount: 4 },
    }),
    idFactory: (prefix) => `${prefix}-stack`,
  });
  const recorderServer = createApiServer({
    http: { createServer },
    service: {
      status: () => ({ connected: true }),
      listPorts: async () => [],
    },
    calibration: null,
    finalCalibration: null,
    continuousCalibration,
    root: process.cwd(),
  });
  await new Promise((resolve) =>
    recorderServer.listen(0, "127.0.0.1", resolve),
  );
  const recorderAddress = recorderServer.address();
  const recorderOrigin = `http://127.0.0.1:${recorderAddress.port}`;
  const runtime = createDigitalKeyRuntime({
    mode: "workbench",
    liveProxyOptions: {
      fetchImpl(url, options) {
        const redirected = new URL(url);
        redirected.host = new URL(recorderOrigin).host;
        return fetch(redirected, options);
      },
    },
  });

  try {
    const setupArguments = {
      name: "现场场地",
      lock: { xMm: 0, yMm: 0, zMm: 0 },
      anchors: [
        { id: "A1", xMm: -125, yMm: 40, zMm: 850 },
        { id: "A2", xMm: 125, yMm: 40, zMm: 850 },
      ],
      autoActivate: false,
    };
    const setupPlan = await runtime.plan({
      operation: "calibration.setup.configure",
      arguments: setupArguments,
      idempotencyKey: "stack-setup-idempotency-key",
    });
    const setupResult = await runtime.execute({
      operation: "calibration.setup.configure",
      arguments: setupArguments,
      idempotencyKey: "stack-setup-idempotency-key",
      planId: setupPlan.planId,
    });
    assert.equal(setupResult.data.setupKey, "field-site@1");

    const captureArguments = {
      setupRevision: "field-site@1",
      xMm: 0,
      yMm: 1000,
      zMm: 850,
      durationSeconds: 15,
      warmupSeconds: 2,
      minimumSynchronizedGroups: 100,
    };
    const capturePlan = await runtime.plan({
      operation: "calibration.point.capture",
      arguments: captureArguments,
      idempotencyKey: "stack-capture-idempotency-key",
    });
    const accepted = await runtime.execute({
      operation: "calibration.point.capture",
      arguments: captureArguments,
      idempotencyKey: "stack-capture-idempotency-key",
      planId: capturePlan.planId,
    });
    const operationId = accepted.operationRecord.id;
    const operation = await waitForOperation(runtime, operationId);
    assert.equal(operation.status, "succeeded");
    assert.equal(operation.result.record.id, "serial-capture-stack");
    assert.equal(operation.result.candidate.id, "candidate-stack");

    const status = await runtime.query({
      operation: "calibration.candidate.get",
      arguments: {},
    });
    assert.equal(status.data.setupRevision, "field-site@1");
    assert.equal(status.data.candidate.id, "candidate-stack");
  } finally {
    await new Promise((resolve) => recorderServer.close(resolve));
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

async function waitForOperation(runtime, operationId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const operation = runtime.operations.get(operationId);
    if (["succeeded", "failed", "cancelled"].includes(operation.status)) {
      return operation;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`操作未在预期时间内完成：${operationId}`);
}

function frame(timestamp, device, distanceCm) {
  return {
    type: "frame",
    timestamp,
    device,
    address: "0100",
    distanceCm,
    snrDb: 20,
  };
}
