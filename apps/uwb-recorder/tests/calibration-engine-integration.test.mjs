import test from "node:test";
import assert from "node:assert/strict";

import * as localizationEngine from "../../../packages/uwb-localization/src/index.js";
import {
  CalibrationService,
  createCalibrationPlan,
} from "../src/calibration-service.js";

const ANCHORS = Object.freeze([
  { id: 1, xMm: -125, yMm: 40, enabled: true },
  { id: 2, xMm: 125, yMm: 40, enabled: true },
  { id: 3, xMm: -125, yMm: -40, enabled: true },
  { id: 4, xMm: 125, yMm: -40, enabled: true },
]);

test("真实引擎可对 2～4 基站完整训练、验证并导出固件模型", async () => {
  for (const anchorCount of [2, 3, 4]) {
    const anchors = ANCHORS.slice(0, anchorCount);
    const plan = createCalibrationPlan({ anchors });
    const captures = syntheticCaptures(plan, anchors);
    const progress = [];
    const service = new CalibrationService({ engine: localizationEngine });

    const trained = await service.train({
      plan,
      captures,
      idempotencyKey: `train-${anchorCount}`,
      onProgress: (event) => progress.push(event),
    });

    assert.equal(trained.model.anchors.length, anchorCount);
    assert.equal(Object.keys(trained.model.rangeModels).length, anchorCount);
    assert.equal(trained.training.pointCount, 77);
    assert.equal(
      trained.model.compensationTable.boundaryDistanceCorrectionsMm.length,
      11,
    );
    assert.ok(progress.some((event) => event.phase === "position-grid"));

    const validation = await service.validate({
      captures,
      idempotencyKey: `validate-${anchorCount}`,
    });
    assert.equal(validation.passed, true);
    assert.equal(validation.metrics.pointCount, 77);
    assert.ok(validation.metrics.distanceMaxErrorM <= 0.3);
    assert.ok(validation.metrics.angleMaxErrorDeg <= 10);

    const exported = await service.export({
      idempotencyKey: `export-${anchorCount}`,
    });
    assert.equal(exported.modelSizeBytes, 900);
    assert.equal(exported.headerFileName, "calibration_model_data.h");
    assert.equal(exported.sourceFileName, "calibration_model_data.c");
    assert.match(
      exported.source,
      /const CalibrationModelV1 g_calibration_model_v1 = \{/,
    );
    assert.match(exported.firmwareCrc32, /^[0-9A-F]{8}$/);
  }
});

function syntheticCaptures(plan, anchors) {
  return plan.points.map((point, pointIndex) => {
    const positionRadiusMm =
      point.distanceM * 1000 + plan.geometry.boundaryOffsetMm;
    const radians = (point.angleDeg * Math.PI) / 180;
    const xMm = positionRadiusMm * Math.sin(radians);
    const yMm = positionRadiusMm * Math.cos(radians);

    return {
      pointId: point.id,
      distanceM: point.distanceM,
      angleDeg: point.angleDeg,
      accepted: true,
      synchronizedGroups: 110,
      perAnchor: anchors.map((anchor, anchorIndex) => {
        const trueDistanceMm = Math.hypot(
          xMm - anchor.xMm,
          yMm - anchor.yMm,
        );
        const scale = [1.004, 0.997, 1.002, 0.995][anchorIndex];
        const biasMm = [18, -12, 9, -6][anchorIndex];
        const deterministicJitterMm = ((pointIndex % 5) - 2) * 0.2;
        const measuredMm =
          (trueDistanceMm - biasMm) / scale + deterministicJitterMm;

        return {
          anchorId: anchor.id,
          medianMm: measuredMm,
          medianCm: measuredMm / 10,
          expectedDistanceMm: trueDistanceMm,
          expectedDistanceCm: trueDistanceMm / 10,
          synchronizedSamples: 110,
          samples: 110,
          spreadCm: 0.4,
          snrDb: 14,
        };
      }),
    };
  });
}
