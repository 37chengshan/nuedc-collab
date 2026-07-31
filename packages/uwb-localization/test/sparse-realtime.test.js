import test from "node:test";
import assert from "node:assert/strict";

import {
  estimateSparseRealtime,
  parseSparseCalibrationLabel,
  synchronizeFrames,
  trainSparseRealtimeModel,
} from "../src/index.js";

const FINAL_CAPTURE_MEDIANS = [
  ["中轴1m", 62, 89],
  ["中轴1m-2", 64, 93],
  ["中轴1m-3", 65, 103],
  ["中轴 0.5", 19, 30],
  ["中轴 1.5", 119, 152],
  ["中轴 1.5m-2", 119, 152],
  ["d1 1.5m", 124, 139],
  ["d1 1.5m -2", 121, 135],
  ["d2 1.5m", 118, 95],
  ["d2 1.5m -2", 117, 99],
  ["d1 1m", 71, 94],
  ["d1 1m -2", 71, 68],
  ["d2 1m", 62, 49],
  ["d2 1m -2", 61, 53],
  ["d1 0。5", 11, 23],
  ["d2 0.5m有效", 29, 9],
  ["V2-R100-A+15", 63, 68],
  ["V2-R100-A-15", 78, 76.5],
];

function calibrationSamples() {
  return FINAL_CAPTURE_MEDIANS.map(([label, firstCm, secondCm]) => ({
    label,
    ...parseSparseCalibrationLabel(label),
    perAnchor: [
      {
        anchorId: "A1",
        medianMm: firstCm * 10,
        snrDb: 16,
        madMm: 20,
      },
      {
        anchorId: "A2",
        medianMm: secondCm * 10,
        snrDb: 10,
        madMm: 30,
      },
    ],
  }));
}

test("最终采集标签可提取径向距离和明确角度", () => {
  assert.deepEqual(parseSparseCalibrationLabel("V2-R100-A-15"), {
    distanceM: 1,
    angleDeg: -15,
    angleSource: "explicit",
  });
  assert.deepEqual(parseSparseCalibrationLabel("V2-R100-A+15"), {
    distanceM: 1,
    angleDeg: 15,
    angleSource: "explicit",
  });
  assert.deepEqual(parseSparseCalibrationLabel("中轴 0.5"), {
    distanceM: 0.5,
    angleDeg: 0,
    angleSource: "centerline",
  });
  assert.deepEqual(parseSparseCalibrationLabel("d1 0。5"), {
    distanceM: 0.5,
    angleDeg: null,
    angleSource: "distance-only",
  });
});

test("50组结构化标签可区分训练点和独立验证点", () => {
  assert.deepEqual(parseSparseCalibrationLabel("line_r080cm_ap00_rep1"), {
    distanceM: 0.8,
    angleDeg: 0,
    angleSource: "structured",
    dataset: "2026-07-31-grid",
    split: "train",
  });
  assert.deepEqual(parseSparseCalibrationLabel("angle_r100cm_am45_rep2"), {
    distanceM: 1,
    angleDeg: -45,
    angleSource: "structured",
    dataset: "2026-07-31-grid",
    split: "train",
  });
  assert.deepEqual(parseSparseCalibrationLabel("valid_r150cm_ap15_rep1"), {
    distanceM: 1.5,
    angleDeg: 15,
    angleSource: "structured",
    dataset: "2026-07-31-grid",
    split: "validation",
  });
});

test("稀疏模型在全部最终标定点上的径向误差不超过 0.2 m", () => {
  const samples = calibrationSamples();
  const model = trainSparseRealtimeModel(samples);

  for (const sample of samples) {
    const estimate = estimateSparseRealtime(model, {
      anchors: sample.perAnchor,
    });
    assert.equal(estimate.valid, true, sample.label);
    assert.ok(
      Math.abs(estimate.distanceM - sample.distanceM) <= 0.2,
      `${sample.label}: ${estimate.distanceM.toFixed(3)} m`,
    );
  }
  assert.ok(model.metrics.distanceMaxErrorM <= 0.2);
});

test("明确的 -15/0/+15 度点用于实时角度拟合", () => {
  const samples = calibrationSamples();
  const model = trainSparseRealtimeModel(samples);

  for (const expected of [-15, 0, 15]) {
    const candidates = samples.filter((sample) => sample.angleDeg === expected);
    for (const sample of candidates) {
      const estimate = estimateSparseRealtime(model, {
        anchors: sample.perAnchor,
      });
      assert.equal(estimate.angleValid, true, sample.label);
      assert.ok(
        Math.abs(estimate.angleDeg - expected) <= 5,
        `${sample.label}: ${estimate.angleDeg.toFixed(2)}°`,
      );
    }
  }
});

test("第二路质量差时仍用稳定的一号链路显示距离，但角度降级", () => {
  const model = trainSparseRealtimeModel(calibrationSamples());
  const estimate = estimateSparseRealtime(model, {
    anchors: [
      { anchorId: "A1", medianMm: 640, snrDb: 16, madMm: 20 },
      { anchorId: "A2", medianMm: 850, snrDb: 2, madMm: 240 },
    ],
  });

  assert.equal(estimate.valid, true);
  assert.ok(Math.abs(estimate.distanceM - 1) <= 0.2);
  assert.equal(estimate.angleValid, false);
  assert.equal(estimate.quality, "degraded");
});

test("不同基站地址但相同钥匙编号的数据可在 120 ms 内同步", () => {
  const synchronized = synchronizeFrames(
    [
      {
        timestamp: "2026-07-30T21:37:27.541Z",
        device: 1,
        address: "0100",
        distanceCm: 63,
        snrDb: 16,
      },
      {
        timestamp: "2026-07-30T21:37:27.541Z",
        device: 2,
        address: "0200",
        distanceCm: 68,
        snrDb: 11,
      },
    ],
    { requiredDevices: [1, 2], windowMs: 120 },
  );

  assert.equal(synchronized.groups.length, 1);
  assert.equal(synchronized.groups[0].keyId, 0);
});
