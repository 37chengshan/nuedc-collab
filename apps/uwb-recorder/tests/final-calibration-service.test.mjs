import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createFinalCalibrationService } from "../src/final-calibration-service.js";

const capturesDirectory = join(
  import.meta.dirname,
  "..",
  "data",
  "captures",
);

test("最终采集目录用66点评估并用全部68点生成运行模型", async () => {
  const service = await createFinalCalibrationService({
    capturesDirectory,
  });
  const status = service.status();

  assert.equal(status.ready, true);
  assert.equal(status.dataset, "combined-legacy-and-2026-07-31-grid");
  assert.equal(status.captureCount, 68);
  assert.equal(status.structuredTrainingPointCount, 50);
  assert.equal(status.legacyTrainingPointCount, 18);
  assert.equal(status.validationPointCount, 2);
  assert.equal(status.ignoredCaptureCount, 5);
  assert.equal(
    status.metrics.distanceValidationMode,
    "leave-one-physical-point-out",
  );
  assert.ok(status.metrics.distanceMaxErrorM <= 0.3);
  assert.ok(status.metrics.distanceP95M <= 0.18);
  assert.ok(status.metrics.near1m.p95M <= 0.15);
  assert.ok(status.metrics.near1m.maxErrorM <= 0.2);
  assert.ok(status.metrics.near2m.p95M <= 0.15);
  assert.ok(status.metrics.near2m.maxErrorM <= 0.18);
  assert.equal(status.metrics.boundaryCrossingErrorCount, 0);
  assert.ok(Number.isFinite(status.validationMetrics.distanceMaxErrorM));
  assert.ok(Number.isFinite(status.validationMetrics.angleMaxErrorDeg));
  assert.ok(status.validationMetrics.distanceMaxErrorM >= 0.4);
  assert.deepEqual(status.calibratedAngleDeg, {
    minimum: -45,
    maximum: 45,
  });
});

test("两个最终1.5m补测点进入运行模型后误差不超过0.2m", async () => {
  const service = await createFinalCalibrationService({
    capturesDirectory,
  });
  for (const captureId of [
    "capture-2026-07-31T09-10-13-186Z",
    "capture-2026-07-31T09-11-50-057Z",
  ]) {
    const measurements = (
      await readFile(join(capturesDirectory, `${captureId}.jsonl`), "utf8")
    )
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const estimate = service.estimate(measurements);

    assert.equal(estimate.valid, true);
    assert.ok(Math.abs(estimate.distanceM - 1.5) <= 0.2);
  }
});

test("最终模型可从近期串口帧实时输出距离和角度", async () => {
  const service = await createFinalCalibrationService({
    capturesDirectory,
  });
  const measurements = (
    await readFile(
      join(
        capturesDirectory,
        "capture-2026-07-31T08-34-50-070Z.jsonl",
      ),
      "utf8",
    )
  )
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const estimate = service.estimate(measurements);
  assert.equal(estimate.valid, true);
  assert.ok(Math.abs(estimate.distanceM - 1) <= 0.2);
  assert.equal(estimate.angleValid, true);
  assert.ok(Math.abs(estimate.angleDeg - 30) <= 5);
  assert.equal(estimate.source, "final-captures");
});

test("候选模型可旁路计算实时位置且不会替换正式模型", async () => {
  const measurements = (
    await readFile(
      join(
        capturesDirectory,
        "capture-2026-07-31T08-34-50-070Z.jsonl",
      ),
      "utf8",
    )
  )
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const service = await createFinalCalibrationService({
    capturesDirectory,
    measurementSource: async () => measurements,
  });
  const formalModel = service.model;

  const estimate = await service.estimateLatestWithModel(formalModel, {
    candidateId: "candidate-preview",
    setupKey: "field-site@1",
    source: "continuous-calibration-candidate",
  });

  assert.equal(estimate.valid, true);
  assert.equal(estimate.candidateId, "candidate-preview");
  assert.equal(estimate.setupKey, "field-site@1");
  assert.equal(estimate.source, "continuous-calibration-candidate");
  assert.equal(service.model, formalModel);
});

test("最终定位服务可用单次引用替换热切换持续标定模型", async () => {
  const service = await createFinalCalibrationService({
    capturesDirectory,
  });
  const originalModel = service.model;

  service.installRuntimeModel(originalModel, {
    versionId: "continuous-v1",
    setupKey: "main-door@3",
    source: "continuous-calibration",
  });

  assert.equal(service.model, originalModel);
  assert.equal(service.status().runtimeModel.versionId, "continuous-v1");
  assert.equal(service.status().runtimeModel.setupKey, "main-door@3");
});

test("最终模型导出到MSPM0时必须包含旧18组和新50组全部数据", async () => {
  const service = await createFinalCalibrationService({
    capturesDirectory,
  });

  const exported = service.exportFirmware({
    name: "empirical_model_data",
  });

  assert.equal(exported.name, "empirical_model_data");
  assert.equal(exported.prototypeCount, 68);
  assert.equal(exported.legacyTrainingPointCount, 18);
  assert.equal(exported.structuredTrainingPointCount, 50);
  assert.equal(exported.headerFileName, "empirical_model_data.h");
  assert.equal(exported.sourceFileName, "empirical_model_data.c");
  assert.match(exported.header, /extern const EmpiricalModelV1 g_empirical_model_v1;/);
  assert.match(exported.source, /旧数据: 18/);
  assert.match(exported.source, /新结构化数据: 50/);
  assert.match(exported.source, /\.prototype_count = 68U/);
  assert.equal(exported.distanceNeighborCount, 2);
  assert.equal(exported.distanceKnnBlend, 0.5);
  assert.ok(Math.abs(exported.knownPrototypeRadius - 0.1) < 1e-6);
  assert.ok(exported.primaryKnotCount >= 8);
  assert.match(exported.source, /\.distance_neighbor_count = 2U/);
  assert.match(exported.source, /\.angle_neighbor_count = 4U/);
  assert.match(exported.source, /\.distance_knn_blend = 0\.500000000f/);
  assert.match(exported.source, /\.known_prototype_radius = 0\.100000001f/);
  assert.match(exported.source, /\.primary_knot_count = \d+U/);
  assert.match(exported.source, /\.primary_knots = empirical_model_data_primary_knots/);
  assert.match(exported.firmwareCrc32, /^[0-9A-F]{8}$/);
});
