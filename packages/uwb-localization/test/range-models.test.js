import test from "node:test";
import assert from "node:assert/strict";

import {
  fitAnchorRangeModels,
  fitRangeCalibration,
  predictRange,
} from "../src/index.js";

test("Huber IRLS 在线性标定中抑制单个 NLOS 离群值", () => {
  const samples = [];
  for (const trueMm of [400, 700, 1000, 1400, 1900, 2500, 3200]) {
    for (let repeat = 0; repeat < 3; repeat += 1) {
      samples.push({
        pointId: `P-${trueMm}`,
        measuredMm: trueMm * 1.02 + 20 + repeat - 1,
        trueMm,
      });
    }
  }
  samples.push({
    pointId: "P-1400",
    measuredMm: 2600,
    trueMm: 1400,
  });

  const model = fitRangeCalibration(samples);
  assert.equal(model.type, "linear");
  assert.ok(Math.abs(predictRange(model, 2060) - 2000) < 20);
  assert.equal(model.cv.pointCount, 7);
});

test("明显弯曲但单调的数据选择二次模型而不是更复杂模型", () => {
  const samples = makeSamples((measuredMm) => {
    const centered = measuredMm - 1900;
    return measuredMm + 0.00008 * centered * centered;
  });

  const model = fitRangeCalibration(samples);
  assert.equal(model.type, "quadratic");
  assert.ok(Math.abs(predictRange(model, 2300) - 2312.8) < 20);
});

test("有明显折点的单调数据选择单调分段线性模型", () => {
  const samples = makeSamples((measuredMm) =>
    measuredMm <= 1700 ? 0.6 * measuredMm + 120 : 1.4 * measuredMm - 1240,
  );

  const model = fitRangeCalibration(samples);
  assert.equal(model.type, "piecewise-linear");
  assert.ok(model.rawKnotsMm.length <= 12);
  assert.ok(Math.abs(predictRange(model, 1100) - 780) < 25);
  assert.ok(Math.abs(predictRange(model, 2600) - 2400) < 25);
});

test("选出的模型在 0.3 到 3.5 m 内始终单调且非负", () => {
  const samples = makeSamples(
    (measuredMm) => measuredMm + 120 * Math.sin(measuredMm / 500),
  );
  const model = fitRangeCalibration(samples);

  let previous = -Infinity;
  for (let measuredMm = 300; measuredMm <= 3500; measuredMm += 10) {
    const predicted = predictRange(model, measuredMm);
    assert.ok(predicted >= 0);
    assert.ok(predicted + 1e-7 >= previous);
    previous = predicted;
  }
});

test("按 pointId 分组交叉验证，不把同一点重复样本泄漏到验证集", () => {
  const samples = makeSamples((measuredMm) => measuredMm * 0.98 + 10, 5);
  const model = fitRangeCalibration(samples);
  assert.equal(model.cv.pointCount, 8);
  assert.equal(model.cv.foldCount, 8);
  assert.ok(Object.values(model.candidateScores).every((score) => score.foldCount === 8));
});

test("可以一次为多个锚点分别训练模型", () => {
  const samples = [
    ...makeSamples((value) => value, 2).map((sample) => ({
      ...sample,
      anchorId: "A1",
    })),
    ...makeSamples((value) => value * 0.95 + 30, 2).map((sample) => ({
      ...sample,
      anchorId: "A2",
    })),
  ];

  const models = fitAnchorRangeModels(samples);
  assert.deepEqual(Object.keys(models), ["A1", "A2"]);
  assert.ok(Math.abs(predictRange(models.A2, 980) - 961) < 20);
});

function makeSamples(transform, repeats = 3) {
  const values = [350, 700, 1100, 1500, 1900, 2300, 2800, 3400];
  return values.flatMap((measuredMm) =>
    Array.from({ length: repeats }, (_, repeat) => ({
      pointId: `P-${measuredMm}`,
      measuredMm: measuredMm + (repeat - (repeats - 1) / 2) * 2,
      trueMm: transform(measuredMm),
    })),
  );
}
