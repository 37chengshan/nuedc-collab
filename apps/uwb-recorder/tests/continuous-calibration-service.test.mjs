import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createContinuousCalibrationService } from "../src/continuous-calibration-service.js";

const setup = {
  id: "door-a",
  revision: 1,
  doorLockOrigin: { xM: 0, yM: 0, zM: 0.8 },
  anchors: [
    { id: "A1", xM: -0.125, yM: 0.04, zM: 1.2 },
    { id: "A2", xM: 0.125, yM: 0.04, zM: 1.2 },
  ],
};

test("setup revision 隔离旧记录且记录持久化不接触串口", async () => {
  await withTemporaryState(async (stateDirectory) => {
    const service = await createContinuousCalibrationService({
      stateDirectory,
    });
    await service.configureSetup(setup);

    await assert.rejects(
      () =>
        service.addRecord({
          ...calibrationRecord("stale"),
          setupRevision: 0,
        }),
      (error) => error.code === "CALIBRATION_SETUP_REVISION_MISMATCH",
    );

    const saved = await service.addRecord(calibrationRecord("current"));
    assert.equal(saved.setupKey, "door-a@1");
    assert.equal(service.status().recordCount, 1);
    assert.equal("serialPort" in service, false);
  });
});

test("4180页面场地载荷自动生成revision且只在几何变化时递增", async () => {
  await withTemporaryState(async (stateDirectory) => {
    const service = await createContinuousCalibrationService({
      stateDirectory,
    });
    const uiSetup = {
      name: "现场场地",
      lock: { xMm: 0, yMm: 0, zMm: 0 },
      anchors: [
        { id: "A1", xMm: -125, yMm: 40, zMm: 850 },
        { id: "A2", xMm: 125, yMm: 40, zMm: 850 },
      ],
      autoActivate: true,
    };

    const first = await service.configureSetup(uiSetup);
    const repeated = await service.configureSetup(uiSetup);
    const changed = await service.configureSetup({
      ...uiSetup,
      anchors: [
        uiSetup.anchors[0],
        { ...uiSetup.anchors[1], xMm: 130 },
      ],
    });

    assert.equal(first.setupKey, "field-site@1");
    assert.equal(repeated.setupKey, "field-site@1");
    assert.equal(repeated.unchanged, true);
    assert.equal(changed.setupKey, "field-site@2");
    assert.equal(service.status().setupRevision, "field-site@2");
    assert.equal(service.status().setup.autoActivate, true);
  });
});

test("真实点采集编排调用4173串口采集源并评估、记录、训练和自动激活", async () => {
  await withTemporaryState(async (stateDirectory) => {
    const captureCalls = [];
    const assessmentCalls = [];
    const installed = [];
    const service = await createContinuousCalibrationService({
      stateDirectory,
      captureSource: {
        async capturePoint(options) {
          captureCalls.push(options);
          return {
            captureId: "serial-capture-1",
            startedAt: "2026-07-31T04:00:00.000Z",
            measurements: [
              frame("2026-07-31T04:00:01.000Z", 1, 50),
              frame("2026-07-31T04:00:03.000Z", 1, 51),
              frame("2026-07-31T04:00:03.020Z", 2, 52),
            ],
          };
        },
      },
      captureAssessor: async (input) => {
        assessmentCalls.push(input);
        return {
          accepted: true,
          synchronizedGroups: 100,
          perAnchor: [
            { anchorId: "A1", medianMm: 510, madMm: 5, snrDb: 20 },
            { anchorId: "A2", medianMm: 520, madMm: 6, snrDb: 19 },
          ],
          recaptureReasons: [],
        };
      },
      candidateBuilder: () => candidateResult("captured-model"),
      runtimeModelTarget: {
        installRuntimeModel(model) {
          installed.push(model);
        },
      },
      idFactory: (prefix) => `${prefix}-1`,
    });
    await service.configureSetup(setup);

    const result = await service.captureCalibrationPoint({
      setupRevision: 1,
      xMm: 300,
      yMm: 400,
      zMm: 800,
      autoActivate: true,
    });

    assert.equal(captureCalls.length, 1);
    assert.equal(captureCalls[0].durationSeconds, 17);
    assert.equal(assessmentCalls[0].warmupSeconds, 2);
    assert.equal(assessmentCalls[0].minimumSynchronizedGroups, 100);
    assert.equal(assessmentCalls[0].boundaryOffsetMm, 0);
    assert.equal(assessmentCalls[0].measurements.length, 2);
    assert.ok(Math.abs(assessmentCalls[0].distanceM - 0.5) < 1e-12);
    assert.ok(
      Math.abs(assessmentCalls[0].angleDeg - 36.86989764584402) < 1e-10,
    );
    assert.equal(result.record.id, "serial-capture-1");
    assert.deepEqual(result.record.truth, { xM: 0.3, yM: 0.4, zM: 0.8 });
    assert.equal(result.candidate.admission.passed, true);
    assert.equal(result.active.model.name, "captured-model");
    assert.equal(installed.at(-1).name, "captured-model");
  });
});

test("4180使用setupKey和candidateVersion也能采集与激活", async () => {
  await withTemporaryState(async (stateDirectory) => {
    const service = await createContinuousCalibrationService({
      stateDirectory,
      captureSource: {
        async capturePoint() {
          return {
            captureId: "serial-capture-ui",
            startedAt: "2026-07-31T04:00:00.000Z",
            measurements: [
              frame("2026-07-31T04:00:03.000Z", 1, 51),
              frame("2026-07-31T04:00:03.020Z", 2, 52),
            ],
          };
        },
      },
      captureAssessor: async () => ({
        accepted: true,
        synchronizedGroups: 100,
        perAnchor: [
          { anchorId: "A1", medianMm: 510, madMm: 5, snrDb: 20 },
          { anchorId: "A2", medianMm: 520, madMm: 6, snrDb: 19 },
        ],
      }),
      candidateBuilder: () => candidateResult("ui-candidate"),
      idFactory: (prefix) => `${prefix}-ui`,
    });
    await service.configureSetup(setup);

    const capture = await service.captureCalibrationPoint({
      setupRevision: "door-a@1",
      xMm: 300,
      yMm: 400,
      zMm: 800,
    });
    const activated = await service.activateCandidate({
      setupRevision: "door-a@1",
      candidateVersion: capture.candidate.id,
    });

    assert.equal(capture.record.id, "serial-capture-ui");
    assert.equal(activated.candidateId, "candidate-ui");
  });
});

test("持续标定快照返回候选正式位置、误差点和下一推荐点", async () => {
  await withTemporaryState(async (stateDirectory) => {
    const service = await createContinuousCalibrationService({
      stateDirectory,
      runtimeModelTarget: {
        async estimateLatestWithModel(_model, metadata) {
          return {
            valid: true,
            distanceM: 1,
            angleValid: true,
            angleDeg: 30,
            candidateId: metadata.candidateId,
          };
        },
        async estimateLatest() {
          return {
            valid: true,
            distanceM: 1.05,
            angleValid: true,
            angleDeg: 25,
            modelVersion: "formal-v1",
          };
        },
      },
      candidateBuilder: () => ({
        ...candidateResult("snapshot-model"),
        validation: {
          pointCount: 1,
          samples: [
            {
              pointId: "p1",
              truth: { xM: 0, yM: 1, zM: 0.8 },
              recordCount: 2,
            },
          ],
        },
        metrics: {
          ...candidateResult("snapshot-model").metrics,
          rows: [{ pointId: "p1", distanceErrorM: 0.08 }],
        },
      }),
      idFactory: (prefix) => `${prefix}-snapshot`,
    });
    await service.configureSetup(setup);
    await service.addRecord(calibrationRecord("snapshot-record"));
    await service.trainCandidate();

    const snapshot = await service.snapshot();

    assert.equal(snapshot.candidatePosition.version, "candidate-snapshot");
    assert.equal(snapshot.formalPosition.version, "formal-v1");
    assert.deepEqual(snapshot.heatmap, [
      { xMm: 0, yMm: 1000, errorM: 0.08, samples: 2 },
    ]);
    assert.equal(typeof snapshot.recommendation.reason, "string");
    assert.ok(
      [0.95, 1, 1.05, 1.95, 2, 2.05].includes(
        snapshot.recommendation.radialM,
      ),
    );
  });
});

test("质量不合格的真实采集只留审计记录，不训练也不激活", async () => {
  await withTemporaryState(async (stateDirectory) => {
    let candidateBuilds = 0;
    const service = await createContinuousCalibrationService({
      stateDirectory,
      captureSource: {
        async capturePoint() {
          return {
            captureId: "rejected-capture",
            startedAt: "2026-07-31T04:00:00.000Z",
            measurements: [
              frame("2026-07-31T04:00:03.000Z", 1, 51),
              frame("2026-07-31T04:00:03.020Z", 2, 52),
            ],
          };
        },
      },
      captureAssessor: async () => ({
        accepted: false,
        synchronizedGroups: 20,
        perAnchor: [
          { anchorId: "A1", medianMm: 510, madMm: 5, snrDb: 20 },
          { anchorId: "A2", medianMm: 520, madMm: 6, snrDb: 19 },
        ],
        recaptureReasons: [{ code: "INSUFFICIENT_SYNCHRONIZED_SAMPLES" }],
      }),
      candidateBuilder: () => {
        candidateBuilds += 1;
        return candidateResult("must-not-run");
      },
    });
    await service.configureSetup(setup);

    const result = await service.captureCalibrationPoint({
      setupRevision: 1,
      xMm: 0,
      yMm: 1000,
    });

    assert.equal(result.record.accepted, false);
    assert.equal(result.candidate, null);
    assert.equal(result.active, null);
    assert.equal(candidateBuilds, 0);
    assert.equal(service.status().recordCount, 1);
    assert.equal(service.status().qualifiedRecordCount, 0);
  });
});

test("并发写入不同采集记录不会丢失更新", async () => {
  await withTemporaryState(async (stateDirectory) => {
    const service = await createContinuousCalibrationService({
      stateDirectory,
    });
    await service.configureSetup(setup);

    await Promise.all([
      service.addRecord(calibrationRecord("parallel-1")),
      service.addRecord(calibrationRecord("parallel-2")),
    ]);

    assert.equal(service.status().recordCount, 2);
    assert.equal(service.status().stateSequence, 3);
  });
});

test("候选通过后原子热切换并只保留最近2个历史版本", async () => {
  await withTemporaryState(async (stateDirectory) => {
    const installed = [];
    let candidateNumber = 0;
    const service = await createContinuousCalibrationService({
      stateDirectory,
      runtimeModelTarget: {
        installRuntimeModel(model, metadata) {
          installed.push({ model, metadata });
        },
      },
      candidateBuilder: ({ input }) => {
        candidateNumber += 1;
        return candidateResult(input.name ?? `candidate-${candidateNumber}`);
      },
      idFactory: (prefix) => `${prefix}-${candidateNumber + 1}`,
      clock: tickingClock(),
    });
    await service.configureSetup(setup);
    await service.addRecord(calibrationRecord("r1"));

    for (const name of ["v1", "v2", "v3", "v4"]) {
      const candidate = await service.trainCandidate({ name });
      await service.activateCandidate({ candidateId: candidate.id });
    }

    const status = service.status();
    assert.equal(status.active.model.name, "v4");
    assert.deepEqual(
      status.history.map((version) => version.model.name),
      ["v3", "v2"],
    );
    assert.equal(installed.at(-1).model.name, "v4");

    const files = await readdir(stateDirectory);
    assert.ok(files.some((name) => /^state-\d+-.*\.json$/.test(name)));
    assert.equal(files.some((name) => name.endsWith(".tmp")), false);
  });
});

test("未通过门槛的候选不能切换 active", async () => {
  await withTemporaryState(async (stateDirectory) => {
    const service = await createContinuousCalibrationService({
      stateDirectory,
      candidateBuilder: () => candidateResult("bad", false),
      idFactory: () => "candidate-bad",
    });
    await service.configureSetup(setup);
    const candidate = await service.trainCandidate();

    await assert.rejects(
      () => service.activateCandidate({ candidateId: candidate.id }),
      (error) => error.code === "CALIBRATION_CANDIDATE_REJECTED",
    );
    assert.equal(service.status().active, null);
  });
});

test("回退切换到最近历史版本且服务重启恢复 active", async () => {
  await withTemporaryState(async (stateDirectory) => {
    let candidateNumber = 0;
    const firstRuntime = [];
    const first = await createContinuousCalibrationService({
      stateDirectory,
      runtimeModelTarget: {
        installRuntimeModel(model, metadata) {
          firstRuntime.push({ model, metadata });
        },
      },
      candidateBuilder: ({ input }) => {
        candidateNumber += 1;
        return candidateResult(input.name);
      },
      idFactory: (prefix) => `${prefix}-${candidateNumber}`,
      clock: tickingClock(),
    });
    await first.configureSetup(setup);
    for (const name of ["v1", "v2"]) {
      const candidate = await first.trainCandidate({ name });
      await first.activateCandidate({ candidateId: candidate.id });
    }

    const rolledBack = await first.rollback();
    assert.equal(rolledBack.model.name, "v1");
    assert.equal(firstRuntime.at(-1).model.name, "v1");

    const restoredRuntime = [];
    const restarted = await createContinuousCalibrationService({
      stateDirectory,
      runtimeModelTarget: {
        installRuntimeModel(model, metadata) {
          restoredRuntime.push({ model, metadata });
        },
      },
    });
    assert.equal(restarted.status().active.model.name, "v1");
    assert.equal(restoredRuntime.length, 1);
    assert.equal(restoredRuntime[0].model.name, "v1");
  });
});

function calibrationRecord(id) {
  return {
    id,
    capturedAt: "2026-07-31T12:00:00.000+08:00",
    setupId: "door-a",
    setupRevision: 1,
    physicalPointId: "p1",
    split: "train",
    accepted: true,
    truth: { xM: 0, yM: 1, zM: 0.8 },
    perAnchor: [
      { anchorId: "A1", medianMm: 1000, madMm: 5, snrDb: 20 },
      { anchorId: "A2", medianMm: 1010, madMm: 6, snrDb: 19 },
    ],
  };
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

function candidateResult(name, passed = true) {
  return {
    model: {
      version: 1,
      name,
      rangeKnots: { A1: [{ measuredMm: 1, distanceMm: 1 }] },
      primaryAnchorId: "A1",
    },
    metrics: {
      distanceMaxErrorM: passed ? 0.2 : 0.4,
      distanceP95M: 0.1,
      angleMaxErrorDeg: 5,
      angleP95Deg: 3,
      boundaryPointCount: 2,
      boundaryMaxErrorM: 0.1,
      boundaryP95M: 0.08,
      boundaryCrossingCount: 0,
    },
    baselineMetrics: null,
    admission: {
      passed,
      reasons: passed
        ? []
        : [{ code: "DISTANCE_MAX_EXCEEDED", message: "too large" }],
    },
    training: { pointCount: 4 },
    validation: { pointCount: 4 },
  };
}

function tickingClock() {
  let offset = 0;
  return () => new Date(Date.UTC(2026, 6, 31, 4, 0, offset++));
}

async function withTemporaryState(callback) {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "uwb-continuous-calibration-"),
  );
  try {
    await callback(stateDirectory);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
}
