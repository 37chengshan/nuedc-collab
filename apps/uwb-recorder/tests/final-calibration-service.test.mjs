import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { createFinalCalibrationService } from "../src/final-calibration-service.js";

const capturesDirectory = join(
  import.meta.dirname,
  "..",
  "data",
  "captures",
);

test("最终采集目录可自动训练为实时模型且标定误差不超过 0.2 m", async () => {
  const service = await createFinalCalibrationService({
    capturesDirectory,
  });
  const status = service.status();

  assert.equal(status.ready, true);
  assert.equal(status.captureCount, 18);
  assert.ok(status.metrics.distanceMaxErrorM <= 0.2);
  assert.deepEqual(status.calibratedAngleDeg, {
    minimum: -15,
    maximum: 15,
  });
});

test("最终模型可从近期串口帧实时输出距离和角度", async () => {
  const service = await createFinalCalibrationService({
    capturesDirectory,
  });
  const measurements = [];
  for (let index = 0; index < 9; index += 1) {
    const timestamp = new Date(
      Date.parse("2026-07-30T21:37:27.541Z") + index * 100,
    ).toISOString();
    measurements.push(
      {
        timestamp,
        device: 1,
        address: "0100",
        distanceCm: 63 + (index % 3) - 1,
        snrDb: 16,
      },
      {
        timestamp,
        device: 2,
        address: "0200",
        distanceCm: 68 + (index % 3) - 1,
        snrDb: 11,
      },
    );
  }

  const estimate = service.estimate(measurements);
  assert.equal(estimate.valid, true);
  assert.ok(Math.abs(estimate.distanceM - 1) <= 0.2);
  assert.equal(estimate.angleValid, true);
  assert.ok(Math.abs(estimate.angleDeg - 15) <= 5);
  assert.equal(estimate.source, "final-captures");
});
