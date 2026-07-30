import test from "node:test";
import assert from "node:assert/strict";

import {
  CalibrationService,
  assessCalibrationCapture,
  createCalibrationPlan,
} from "../src/calibration-service.js";

function measurements({
  anchors = 2,
  groups = 110,
  startedAtMs = 1_000,
} = {}) {
  const frames = [];
  for (let group = 0; group < groups; group += 1) {
    for (let device = 1; device <= anchors; device += 1) {
      frames.push({
        timestamp: new Date(startedAtMs + 2_100 + group * 20 + device).toISOString(),
        device,
        address: "0A00",
        distanceCm: 100 + device,
        snrDb: 12,
      });
    }
  }
  return frames;
}

function createHarness() {
  const calls = {
    capture: 0,
    assess: 0,
    train: 0,
    validate: 0,
    export: 0,
  };
  const captureSource = {
    async capturePoint() {
      calls.capture += 1;
      return {
        captureId: "capture-cal-1",
        startedAt: new Date(1_000).toISOString(),
        measurements: measurements(),
      };
    },
  };
  const engine = {
    async assessCapture(input) {
      calls.assess += 1;
      return {
        accepted: true,
        synchronizedGroups: 110,
        inputFrames: input.measurements.length,
        perAnchor: [
          { anchorId: 1, samples: 110, medianCm: 101, spreadCm: 1, snrDb: 12 },
          { anchorId: 2, samples: 110, medianCm: 102, spreadCm: 1, snrDb: 12 },
        ],
        recaptureReasons: [],
      };
    },
    async train(input, context) {
      calls.train += 1;
      context.onProgress?.({ phase: "fit", completed: 77, total: 77 });
      return { model: { version: 1 }, metrics: { distanceP95M: 0.12 } };
    },
    async validate() {
      calls.validate += 1;
      return { passed: true, metrics: { angleP95Deg: 6.5 } };
    },
    async exportFirmware() {
      calls.export += 1;
      return { header: "#pragma once\n", source: "const int model = 1;\n" };
    },
  };
  return {
    calls,
    service: new CalibrationService({ captureSource, engine }),
  };
}

test("capture dry-run performs no serial read and no engine work", async () => {
  const { calls, service } = createHarness();

  const result = await service.capture({
    distanceM: 1,
    angleDeg: 0,
    anchorCount: 2,
    dryRun: true,
    idempotencyKey: "dry-capture-1",
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.durationSeconds, 15);
  assert.equal(result.warmupSeconds, 2);
  assert.equal(calls.capture, 0);
  assert.equal(calls.assess, 0);
});

test("capture discards warmup frames and forwards stable serial samples", async () => {
  const { calls, service } = createHarness();

  const result = await service.capture({
    distanceM: 1,
    angleDeg: 0,
    anchorCount: 2,
    idempotencyKey: "capture-1",
  });

  assert.equal(result.accepted, true);
  assert.equal(result.pointId, "R1000_A+00");
  assert.equal(result.synchronizedGroups, 110);
  assert.equal(calls.capture, 1);
  assert.equal(calls.assess, 1);
});

test("same idempotency key executes training exactly once", async () => {
  const { calls, service } = createHarness();
  const input = {
    plan: createCalibrationPlan(),
    captures: [],
    idempotencyKey: "train-same-key",
  };

  const first = await service.train(input);
  const second = await service.train(input);

  assert.deepEqual(second, first);
  assert.equal(calls.train, 1);
});

test("training dry-run does not call the engine", async () => {
  const { calls, service } = createHarness();
  const result = await service.train({
    plan: createCalibrationPlan(),
    captures: [],
    dryRun: true,
    idempotencyKey: "train-dry-run",
  });

  assert.equal(result.dryRun, true);
  assert.equal(calls.train, 0);
});

test("historical capture is rejected when one enabled anchor has fewer than 100 synchronized groups", () => {
  const frames = [
    ...measurements({ anchors: 2, groups: 96 }),
    ...Array.from({ length: 354 }, (_, index) => ({
      timestamp: new Date(20_000 + index * 20).toISOString(),
      device: 2,
      address: "0A00",
      distanceCm: 101,
      snrDb: 12,
    })),
  ];

  const result = assessCalibrationCapture({
    distanceM: 1,
    angleDeg: 0,
    boundaryOffsetMm: 300,
    anchorCount: 2,
    measurements: frames,
    minimumSynchronizedGroups: 100,
    synchronizationWindowMs: 120,
  });

  assert.equal(result.accepted, false);
  assert.equal(result.synchronizedGroups, 96);
  assert.equal(result.perAnchor[0].samples, 96);
  assert.equal(result.perAnchor[1].samples, 450);
  assert.equal(result.perAnchor[0].synchronizedSamples, 96);
  assert.match(
    result.recaptureReasons.map((reason) => reason.code).join(","),
    /INSUFFICIENT_SYNCHRONIZED_SAMPLES/,
  );
});

test("stable-looking but geometrically inconsistent medians are marked red", () => {
  const frames = measurements({ anchors: 2, groups: 110 }).map((frame) => ({
    ...frame,
    distanceCm: frame.device === 1 ? 26 : 96,
  }));

  const result = assessCalibrationCapture({
    distanceM: 0.5,
    angleDeg: 0,
    boundaryOffsetMm: 300,
    anchorCount: 2,
    measurements: frames,
    minimumSynchronizedGroups: 100,
    synchronizationWindowMs: 120,
  });

  assert.equal(result.accepted, false);
  assert.ok(Number.isFinite(result.perAnchor[0].expectedDistanceCm));
  assert.ok(Number.isFinite(result.perAnchor[0].residualCm));
  assert.match(
    result.recaptureReasons.map((reason) => reason.code).join(","),
    /ANCHOR_GEOMETRY_RESIDUAL/,
  );
});

test("different key addresses are never merged into a synchronized calibration group", () => {
  const frames = measurements({ anchors: 2, groups: 120 }).map((frame) => ({
    ...frame,
    address: frame.device === 1 ? "0100" : "0200",
  }));

  const result = assessCalibrationCapture({
    distanceM: 1,
    angleDeg: 0,
    boundaryOffsetMm: 300,
    anchorCount: 2,
    measurements: frames,
    minimumSynchronizedGroups: 100,
    synchronizationWindowMs: 120,
  });

  assert.equal(result.accepted, false);
  assert.equal(result.synchronizedGroups, 0);
  assert.deepEqual(result.perAnchor[0].addresses, ["0100"]);
  assert.deepEqual(result.perAnchor[1].addresses, ["0200"]);
  assert.match(
    result.recaptureReasons.map((reason) => reason.code).join(","),
    /ADDRESS_MISMATCH/,
  );
});
