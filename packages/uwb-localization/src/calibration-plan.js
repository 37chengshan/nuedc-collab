import { finiteNumber, roundTo } from "./utils.js";

export const CALIBRATION_RADII_MM = Object.freeze([
  500, 800, 950, 1000, 1050, 1500, 1950, 2000, 2050, 2500, 3000,
]);

export const CALIBRATION_ANGLES_DEG = Object.freeze([
  -45, -30, -15, 0, 15, 30, 45,
]);

const DEFAULT_ANCHORS = Object.freeze([
  Object.freeze({ id: "A1", xMm: -125, yMm: 40 }),
  Object.freeze({ id: "A2", xMm: 125, yMm: 40 }),
]);

export function createCalibrationPlan({
  radialZeroOffsetMm = 300,
  boundaryDistancesMm = CALIBRATION_RADII_MM,
  anglesDeg = CALIBRATION_ANGLES_DEG,
} = {}) {
  const offset = finiteNumber(radialZeroOffsetMm, "radialZeroOffsetMm");
  return boundaryDistancesMm.flatMap((boundaryValue) => {
    const boundaryDistanceMm = finiteNumber(
      boundaryValue,
      "boundaryDistanceMm",
    );
    const positionRadiusMm = boundaryDistanceMm + offset;
    return anglesDeg.map((angleValue) => {
      const angleDeg = finiteNumber(angleValue, "angleDeg");
      const radians = (angleDeg * Math.PI) / 180;
      return {
        pointId: pointId(boundaryDistanceMm, angleDeg),
        boundaryDistanceMm,
        positionRadiusMm,
        angleDeg,
        xMm:
          offset === 0
            ? positionRadiusMm * Math.sin(radians)
            : roundTo(positionRadiusMm * Math.sin(radians), 3),
        yMm:
          offset === 0
            ? positionRadiusMm * Math.cos(radians)
            : roundTo(positionRadiusMm * Math.cos(radians), 3),
      };
    });
  });
}

export function validateAnchorConfig(input = {}) {
  const anchorsInput =
    input.anchors === undefined ? DEFAULT_ANCHORS : input.anchors;
  if (!Array.isArray(anchorsInput) || anchorsInput.length < 2 || anchorsInput.length > 4) {
    throw new RangeError("anchors 数量必须在 2 到 4 之间");
  }

  const ids = new Set();
  const coordinates = new Set();
  const anchors = anchorsInput.map((anchor, index) => {
    const id = String(anchor?.id ?? `A${index + 1}`);
    if (ids.has(id)) {
      throw new TypeError(`锚点 id 重复: ${id}`);
    }
    ids.add(id);
    const xMm = finiteNumber(anchor?.xMm, `anchors[${index}].xMm`);
    const yMm = finiteNumber(anchor?.yMm, `anchors[${index}].yMm`);
    const coordinateKey = `${xMm}\u0000${yMm}`;
    if (coordinates.has(coordinateKey)) {
      throw new TypeError("锚点坐标不能重复");
    }
    coordinates.add(coordinateKey);
    return { id, xMm, yMm };
  });

  const radialZeroOffsetMm = finiteNumber(
    input.radialZeroOffsetMm ?? 300,
    "radialZeroOffsetMm",
  );
  if (radialZeroOffsetMm < 0) {
    throw new RangeError("radialZeroOffsetMm 不能为负数");
  }
  return { anchors, radialZeroOffsetMm };
}

export function buildAnchorCalibrationSamples(samples, config = {}) {
  if (!Array.isArray(samples)) {
    throw new TypeError("samples 必须是数组");
  }
  const anchors = Array.isArray(config.anchors) ? config.anchors : DEFAULT_ANCHORS;
  const offset = finiteNumber(
    config.radialZeroOffsetMm ?? 300,
    "radialZeroOffsetMm",
  );
  const anchorById = new Map(
    anchors.map((anchor, index) => [
      String(anchor.id ?? `A${index + 1}`),
      {
        id: String(anchor.id ?? `A${index + 1}`),
        xMm: finiteNumber(anchor.xMm, `anchors[${index}].xMm`),
        yMm: finiteNumber(anchor.yMm, `anchors[${index}].yMm`),
      },
    ]),
  );

  return samples.map((sample, index) => {
    const anchorId = String(sample.anchorId);
    const anchor = anchorById.get(anchorId);
    if (!anchor) {
      throw new TypeError(`samples[${index}] 引用了未知锚点 ${anchorId}`);
    }
    const boundaryDistanceMm = finiteNumber(
      sample.boundaryDistanceMm,
      `samples[${index}].boundaryDistanceMm`,
    );
    const angleDeg = finiteNumber(
      sample.angleDeg,
      `samples[${index}].angleDeg`,
    );
    const positionRadiusMm = boundaryDistanceMm + offset;
    const radians = (angleDeg * Math.PI) / 180;
    const xMm = positionRadiusMm * Math.sin(radians);
    const yMm = positionRadiusMm * Math.cos(radians);
    return {
      ...sample,
      pointId: sample.pointId ?? pointId(boundaryDistanceMm, angleDeg),
      anchorId,
      boundaryDistanceMm,
      positionRadiusMm,
      angleDeg,
      xMm: roundTo(xMm, 12),
      yMm: roundTo(yMm, 12),
      measuredMm: finiteNumber(
        sample.measuredMm,
        `samples[${index}].measuredMm`,
      ),
      trueMm: Math.hypot(xMm - anchor.xMm, yMm - anchor.yMm),
    };
  });
}

function pointId(boundaryDistanceMm, angleDeg) {
  const radius = String(Math.round(boundaryDistanceMm)).padStart(4, "0");
  const angle = String(Math.abs(Math.round(angleDeg))).padStart(2, "0");
  return `R${radius}_A${angleDeg < 0 ? "-" : "+"}${angle}`;
}
