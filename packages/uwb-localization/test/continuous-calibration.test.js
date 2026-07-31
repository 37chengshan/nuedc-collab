import test from "node:test";
import assert from "node:assert/strict";

import {
  aggregateContinuousCalibrationRecords,
  assessContinuousCandidate,
  buildContinuousCalibrationCandidate,
  evaluateContinuousCalibrationModel,
  mapGroundTruthToDoorPolar,
  normalizeCalibrationSetup,
  setupRevisionKey,
} from "../src/index.js";

const setup = {
  id: "main-door",
  revision: 3,
  doorLockOrigin: { xM: 10, yM: 20, zM: 0.8 },
  anchors: [
    { id: "A1", xM: 9.8, yM: 20.1, zM: 1.2 },
    { id: "A2", xM: 10.2, yM: 20.1, zM: 1.2 },
  ],
};

test("固定场地 setup 保存门锁原点、2-4 个三维锚点和 revision", () => {
  const normalized = normalizeCalibrationSetup(setup);

  assert.equal(setupRevisionKey(normalized), "main-door@3");
  assert.deepEqual(normalized.doorLockOrigin, {
    xM: 10,
    yM: 20,
    zM: 0.8,
  });
  assert.deepEqual(normalized.anchors[0], {
    id: "A1",
    xM: 9.8,
    yM: 20.1,
    zM: 1.2,
  });
  assert.throws(
    () =>
      normalizeCalibrationSetup({
        ...setup,
        anchors: [setup.anchors[0]],
      }),
    /2～4/,
  );
  assert.throws(
    () =>
      normalizeCalibrationSetup({
        ...setup,
        anchors: [...setup.anchors, { ...setup.anchors[0] }],
      }),
    /锚点ID不能重复/,
  );
});

test("前端毫米 setup 输入归一化为内部米坐标", () => {
  const normalized = normalizeCalibrationSetup({
    id: "front-door",
    revision: 7,
    lock: { xMm: 1000, yMm: -500, zMm: 800 },
    anchors: [
      { id: "A1", xMm: 875, yMm: -460, zMm: 1200 },
      { id: "A2", xMm: 1125, yMm: -460, zMm: 1200 },
    ],
  });

  assert.deepEqual(normalized.doorLockOrigin, {
    xM: 1,
    yM: -0.5,
    zM: 0.8,
  });
  assert.deepEqual(normalized.anchors[1], {
    id: "A2",
    xM: 1.125,
    yM: -0.46,
    zM: 1.2,
  });
});

test("地图 x/y 真值转换为门锁中心径向和角度且不增加300mm", () => {
  const polar = mapGroundTruthToDoorPolar(setup, {
    xM: 10.3,
    yM: 20.4,
    zM: 0.8,
  });

  assert.ok(Math.abs(polar.distanceM - 0.5) < 1e-12);
  assert.ok(Math.abs(polar.angleDeg - 36.86989764584402) < 1e-10);
  assert.equal(polar.radialZeroOffsetM, 0);
});

test("同物理点只汇总当前 setup revision 最近5次合格记录且每次记录等权", () => {
  const records = [
    record("c1", 1, 700),
    record("c2", 2, 1000),
    record("c3", 3, 1002),
    record("c4", 4, 998),
    record("c5", 5, 1001),
    record("c6", 6, 5000),
    record("rejected", 7, 20, { accepted: false }),
    record("old-revision", 8, 30, { setupRevision: 2 }),
  ];

  const samples = aggregateContinuousCalibrationRecords(records, {
    setup,
    split: "train",
  });

  assert.equal(samples.length, 1);
  assert.equal(samples[0].recordCount, 5);
  assert.deepEqual(samples[0].captureIds, ["c2", "c3", "c4", "c5", "c6"]);
  assert.equal(samples[0].perAnchor[0].medianMm, 1001);
  assert.equal(samples[0].perAnchor[0].recordCount, 5);
  assert.ok(Math.abs(samples[0].distanceM - 0.5) < 1e-12);
});

test("候选准入同时执行绝对门槛、P95退化和边界跨越门槛", () => {
  const passing = {
    pointCount: 8,
    distanceMaxErrorM: 0.2,
    distanceP95M: 0.101,
    angleMaxErrorDeg: 8,
    angleP95Deg: 4.01,
    boundaryPointCount: 4,
    boundaryMaxErrorM: 0.18,
    boundaryP95M: 0.1,
    boundaryCrossingCount: 0,
  };
  const active = {
    ...passing,
    distanceP95M: 0.1,
    angleP95Deg: 4,
    boundaryP95M: 0.1,
  };

  assert.equal(assessContinuousCandidate(passing, active).passed, true);

  const rejected = assessContinuousCandidate(
    {
      ...passing,
      distanceMaxErrorM: 0.301,
      angleMaxErrorDeg: 10.01,
      boundaryMaxErrorM: 0.201,
      distanceP95M: 0.103,
      boundaryCrossingCount: 1,
    },
    active,
  );
  assert.equal(rejected.passed, false);
  assert.deepEqual(
    new Set(rejected.reasons.map((reason) => reason.code)),
    new Set([
      "DISTANCE_MAX_EXCEEDED",
      "ANGLE_MAX_EXCEEDED",
      "BOUNDARY_MAX_EXCEEDED",
      "DISTANCE_P95_REGRESSION",
      "BOUNDARY_CROSSING_REGRESSION",
    ]),
  );
});

test("模型评估计算边界误差和边界跨越次数", () => {
  const samples = [
    validationSample("near-1-left", 0.9, 0, 1.05, 4),
    validationSample("near-1-right", 1.1, 5, 1.25, 10),
    validationSample("near-2-left", 1.9, -5, 1.82, -1),
  ];
  const metrics = evaluateContinuousCalibrationModel({}, samples, {
    estimator: (_model, input) => input.anchors[0].estimate,
  });

  assert.equal(metrics.pointCount, 3);
  assert.ok(Math.abs(metrics.distanceMaxErrorM - 0.15) < 1e-12);
  assert.ok(Math.abs(metrics.angleMaxErrorDeg - 5) < 1e-12);
  assert.equal(metrics.boundaryPointCount, 3);
  assert.ok(Math.abs(metrics.boundaryMaxErrorM - 0.15) < 1e-12);
  assert.equal(metrics.boundaryCrossingCount, 1);
});

test("候选模型使用独立 train/validation 记录训练并通过硬门槛", () => {
  const records = [];
  const points = [
    ["p080m20", 0.8, -20],
    ["p100p00", 1, 0],
    ["p120p20", 1.2, 20],
    ["p200p00", 2, 0],
  ];
  let sequence = 0;
  for (const [physicalPointId, distanceM, angleDeg] of points) {
    for (const split of ["train", "validation"]) {
      records.push(
        polarRecord({
          id: `${split}-${physicalPointId}`,
          capturedAt: new Date(sequence++ * 1000).toISOString(),
          physicalPointId,
          split,
          distanceM,
          angleDeg,
        }),
      );
    }
  }

  const candidate = buildContinuousCalibrationCandidate({
    setup: {
      ...setup,
      doorLockOrigin: { xM: 0, yM: 0, zM: 0 },
    },
    records,
  });

  assert.equal(candidate.admission.passed, true);
  assert.equal(candidate.training.pointCount, 4);
  assert.equal(candidate.validation.pointCount, 4);
  assert.equal(candidate.model.continuousCalibration.setupKey, "main-door@3");
  assert.ok(candidate.metrics.distanceMaxErrorM <= 0.3);
  assert.ok(candidate.metrics.angleMaxErrorDeg <= 10);
});

test("没有单独validation记录时自动按物理点交叉验证而不是训练集自测", () => {
  const records = [
    ["p095m15", 0.95, -15],
    ["p100p00", 1, 0],
    ["p105p15", 1.05, 15],
    ["p195m15", 1.95, -15],
    ["p200p00", 2, 0],
    ["p205p15", 2.05, 15],
  ].map(([physicalPointId, distanceM, angleDeg], index) =>
    polarRecord({
      id: `train-${physicalPointId}`,
      capturedAt: new Date(index * 1000).toISOString(),
      physicalPointId,
      split: "train",
      distanceM,
      angleDeg,
    }),
  );

  const candidate = buildContinuousCalibrationCandidate({
    setup: {
      ...setup,
      doorLockOrigin: { xM: 0, yM: 0, zM: 0 },
    },
    records,
  });

  assert.equal(candidate.training.pointCount, 6);
  assert.equal(candidate.validation.mode, "leave-one-physical-point-out");
  assert.equal(candidate.validation.pointCount, 6);
  assert.equal(candidate.metrics.pointCount, 6);
  assert.ok(candidate.metrics.boundaryPointCount >= 6);
});

function record(
  id,
  seconds,
  medianMm,
  { accepted = true, setupRevision = 3 } = {},
) {
  return {
    id,
    capturedAt: new Date(seconds * 1000).toISOString(),
    setupId: "main-door",
    setupRevision,
    physicalPointId: "point-1",
    split: "train",
    accepted,
    truth: { xM: 10.3, yM: 20.4, zM: 0.8 },
    perAnchor: [
      { anchorId: "A1", medianMm, madMm: 5, snrDb: 20 },
      { anchorId: "A2", medianMm: medianMm + 10, madMm: 6, snrDb: 19 },
    ],
  };
}

function validationSample(
  pointId,
  distanceM,
  angleDeg,
  estimatedDistanceM,
  estimatedAngleDeg,
) {
  return {
    pointId,
    distanceM,
    angleDeg,
    perAnchor: [
      {
        anchorId: "A1",
        medianMm: distanceM * 1000,
        estimate: {
          valid: true,
          distanceM: estimatedDistanceM,
          angleValid: true,
          angleDeg: estimatedAngleDeg,
        },
      },
    ],
  };
}

function polarRecord({
  id,
  capturedAt,
  physicalPointId,
  split,
  distanceM,
  angleDeg,
}) {
  const radians = (angleDeg * Math.PI) / 180;
  return {
    id,
    capturedAt,
    setupId: "main-door",
    setupRevision: 3,
    physicalPointId,
    split,
    accepted: true,
    truth: {
      xM: distanceM * Math.sin(radians),
      yM: distanceM * Math.cos(radians),
      zM: 0,
    },
    perAnchor: [
      {
        anchorId: "A1",
        medianMm: distanceM * 1000 + angleDeg * 2,
        madMm: 5,
        snrDb: 20,
      },
      {
        anchorId: "A2",
        medianMm: distanceM * 1000 - angleDeg * 2,
        madMm: 5,
        snrDb: 20,
      },
    ],
  };
}
