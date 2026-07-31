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

test("最终采集目录合并旧18组和新结构化数据并隔离独立验证点", async () => {
  const service = await createFinalCalibrationService({
    capturesDirectory,
  });
  const status = service.status();

  assert.equal(status.ready, true);
  assert.equal(status.dataset, "combined-legacy-and-2026-07-31-grid");
  assert.equal(status.captureCount, 66);
  assert.equal(status.structuredTrainingPointCount, 48);
  assert.equal(status.legacyTrainingPointCount, 18);
  assert.equal(status.validationPointCount, 2);
  assert.equal(status.ignoredCaptureCount, 5);
  assert.equal(
    status.metrics.distanceValidationMode,
    "leave-one-capture-out",
  );
  assert.ok(status.metrics.distanceMaxErrorM <= 0.2);
  assert.ok(status.metrics.distanceP95M <= 0.1);
  assert.ok(Number.isFinite(status.validationMetrics.distanceMaxErrorM));
  assert.ok(Number.isFinite(status.validationMetrics.angleMaxErrorDeg));
  assert.deepEqual(status.calibratedAngleDeg, {
    minimum: -45,
    maximum: 45,
  });
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

test("最终模型导出到MSPM0时必须包含旧18组和新48组训练数据", async () => {
  const service = await createFinalCalibrationService({
    capturesDirectory,
  });

  const exported = service.exportFirmware({
    name: "empirical_model_data",
  });

  assert.equal(exported.name, "empirical_model_data");
  assert.equal(exported.prototypeCount, 66);
  assert.equal(exported.legacyTrainingPointCount, 18);
  assert.equal(exported.structuredTrainingPointCount, 48);
  assert.equal(exported.headerFileName, "empirical_model_data.h");
  assert.equal(exported.sourceFileName, "empirical_model_data.c");
  assert.match(exported.header, /extern const EmpiricalModelV1 g_empirical_model_v1;/);
  assert.match(exported.source, /旧数据: 18/);
  assert.match(exported.source, /新结构化数据: 48/);
  assert.match(exported.source, /\.prototype_count = 66U/);
  assert.match(exported.source, /\.distance_neighbor_count = 6U/);
  assert.match(exported.source, /\.angle_neighbor_count = 4U/);
  assert.match(exported.firmwareCrc32, /^[0-9A-F]{8}$/);
});
