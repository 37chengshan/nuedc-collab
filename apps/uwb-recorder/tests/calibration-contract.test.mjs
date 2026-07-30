import test from "node:test";
import assert from "node:assert/strict";

import {
  SCHEMA_VERSION,
  schemaAtPath,
} from "../src/contracts.js";
import {
  DEFAULT_CALIBRATION_ANGLES_DEG,
  DEFAULT_CALIBRATION_DISTANCES_M,
  createCalibrationPlan,
} from "../src/calibration-service.js";

test("Schema 1.2.0 exposes the complete calibration command surface", () => {
  assert.equal(SCHEMA_VERSION, "1.2.0");
  for (const action of ["plan", "capture", "train", "validate", "export"]) {
    assert.equal(
      schemaAtPath(`calibration.${action}`).since,
      "1.2.0",
    );
  }
  assert.equal(schemaAtPath("calibration.plan").safety, "read");
  assert.equal(schemaAtPath("calibration.capture").safety, "mutating");
});

test("default calibration plan contains the agreed 77 distance-angle points", () => {
  const plan = createCalibrationPlan();

  assert.deepEqual(DEFAULT_CALIBRATION_DISTANCES_M, [
    0.5, 0.8, 0.95, 1, 1.05, 1.5, 1.95, 2, 2.05, 2.5, 3,
  ]);
  assert.deepEqual(DEFAULT_CALIBRATION_ANGLES_DEG, [
    -45, -30, -15, 0, 15, 30, 45,
  ]);
  assert.equal(plan.points.length, 77);
  assert.deepEqual(plan.points[0], {
    id: "R0500_A-45",
    index: 1,
    distanceM: 0.5,
    angleDeg: -45,
    label: "0.50 m / -45°",
    status: "pending",
  });
  assert.equal(plan.points.at(-1).distanceM, 3);
  assert.equal(plan.points.at(-1).angleDeg, 45);
});
