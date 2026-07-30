import {
  CALIBRATION_ANGLES_DEG,
  CALIBRATION_RADII_MM,
} from "./calibration-plan.js";
import { clamp, finiteNumber, median } from "./utils.js";

export function trainCompensationTable(
  samples,
  {
    boundaryDistancesMm = CALIBRATION_RADII_MM,
    anglesDeg = CALIBRATION_ANGLES_DEG,
  } = {},
) {
  if (!Array.isArray(samples)) {
    throw new TypeError("补偿样本必须是数组");
  }
  const grouped = new Map();
  for (const [index, sample] of samples.entries()) {
    const distance = finiteNumber(
      sample.boundaryDistanceMm,
      `samples[${index}].boundaryDistanceMm`,
    );
    const angle = finiteNumber(sample.angleDeg, `samples[${index}].angleDeg`);
    const key = `${distance}\u0000${angle}`;
    const bucket = grouped.get(key) ?? {
      radial: [],
      bearing: [],
    };
    bucket.radial.push(
      finiteNumber(
        sample.boundaryDistanceCorrectionMm ?? 0,
        `samples[${index}].boundaryDistanceCorrectionMm`,
      ),
    );
    bucket.bearing.push(
      finiteNumber(
        sample.angleCorrectionCdeg ?? 0,
        `samples[${index}].angleCorrectionCdeg`,
      ),
    );
    grouped.set(key, bucket);
  }

  const distances = boundaryDistancesMm.map((value) =>
    finiteNumber(value, "boundaryDistancesMm"),
  );
  const angles = anglesDeg.map((value) => finiteNumber(value, "anglesDeg"));
  const radial = [];
  const bearing = [];
  for (const distance of distances) {
    const radialRow = [];
    const bearingRow = [];
    for (const angle of angles) {
      const bucket = grouped.get(`${distance}\u0000${angle}`);
      if (!bucket) {
        throw new RangeError(`补偿表缺少 ${distance} mm / ${angle}° 测点`);
      }
      radialRow.push(toInt16(Math.round(median(bucket.radial))));
      bearingRow.push(toInt16(Math.round(median(bucket.bearing))));
    }
    radial.push(radialRow);
    bearing.push(bearingRow);
  }

  return {
    boundaryDistancesMm: distances,
    anglesCdeg: angles.map((angle) => Math.round(angle * 100)),
    boundaryDistanceCorrectionsMm: radial,
    angleCorrectionsCdeg: bearing,
  };
}

export function interpolateCompensation(
  table,
  boundaryDistanceMm,
  bearingDeg,
) {
  validateTable(table);
  const distance = clamp(
    finiteNumber(boundaryDistanceMm, "boundaryDistanceMm"),
    table.boundaryDistancesMm[0],
    table.boundaryDistancesMm.at(-1),
  );
  const angleCdeg = clamp(
    finiteNumber(bearingDeg, "bearingDeg") * 100,
    table.anglesCdeg[0],
    table.anglesCdeg.at(-1),
  );
  const [distanceLower, distanceUpper, distanceRatio] = bracket(
    table.boundaryDistancesMm,
    distance,
  );
  const [angleLower, angleUpper, angleRatio] = bracket(
    table.anglesCdeg,
    angleCdeg,
  );

  return {
    boundaryDistanceCorrectionMm: bilinear(
      table.boundaryDistanceCorrectionsMm,
      distanceLower,
      distanceUpper,
      angleLower,
      angleUpper,
      distanceRatio,
      angleRatio,
    ),
    angleCorrectionCdeg: bilinear(
      table.angleCorrectionsCdeg,
      distanceLower,
      distanceUpper,
      angleLower,
      angleUpper,
      distanceRatio,
      angleRatio,
    ),
  };
}

export function applyCompensation(table, position) {
  const boundaryDistanceMm = finiteNumber(
    position.boundaryDistanceMm ?? position.radialMm,
    "position.boundaryDistanceMm",
  );
  const bearingDeg = finiteNumber(position.bearingDeg, "position.bearingDeg");
  const correction = interpolateCompensation(
    table,
    boundaryDistanceMm,
    bearingDeg,
  );
  return {
    boundaryDistanceMm:
      boundaryDistanceMm + correction.boundaryDistanceCorrectionMm,
    bearingDeg: bearingDeg + correction.angleCorrectionCdeg / 100,
    ...correction,
  };
}

function validateTable(table) {
  if (
    !table ||
    !Array.isArray(table.boundaryDistancesMm) ||
    !Array.isArray(table.anglesCdeg) ||
    !Array.isArray(table.boundaryDistanceCorrectionsMm) ||
    !Array.isArray(table.angleCorrectionsCdeg)
  ) {
    throw new TypeError("补偿表结构无效");
  }
}

function bracket(axis, value) {
  if (value <= axis[0]) {
    return [0, 0, 0];
  }
  const last = axis.length - 1;
  if (value >= axis[last]) {
    return [last, last, 0];
  }
  const upper = axis.findIndex((item) => item >= value);
  const lower = upper - 1;
  const width = axis[upper] - axis[lower];
  return [lower, upper, width === 0 ? 0 : (value - axis[lower]) / width];
}

function bilinear(
  grid,
  row0,
  row1,
  column0,
  column1,
  rowRatio,
  columnRatio,
) {
  const top =
    grid[row0][column0] * (1 - columnRatio) +
    grid[row0][column1] * columnRatio;
  const bottom =
    grid[row1][column0] * (1 - columnRatio) +
    grid[row1][column1] * columnRatio;
  return top * (1 - rowRatio) + bottom * rowRatio;
}

function toInt16(value) {
  return Math.round(clamp(value, -32768, 32767));
}
