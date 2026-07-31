// /api/position.distanceM 已按 2026-07-31 最终标定约定表示
// 门锁坐标原点 O 到钥匙圆柱中心的距离，实机展示不得再叠加 300 mm。
const DEFAULT_RADIAL_ZERO_OFFSET_M = 0;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function confidencePercentOf(input, angleValid) {
  const explicit = finiteNumber(input.confidencePercent ?? input.confidence);
  if (explicit !== null) {
    return Math.round(clamp(explicit <= 1 ? explicit * 100 : explicit, 0, 100));
  }
  const angleConfidence = finiteNumber(input.angleConfidence);
  if (angleValid && angleConfidence !== null) {
    return Math.round(
      clamp(angleConfidence <= 1 ? angleConfidence * 100 : angleConfidence, 0, 100),
    );
  }
  return 0;
}

export function createFittedPositionFrame(input = {}, options = {}) {
  const radialZeroOffsetM =
    finiteNumber(options.radialZeroOffsetM) ??
    DEFAULT_RADIAL_ZERO_OFFSET_M;
  const distanceM =
    finiteNumber(input.distanceM) ??
    (() => {
      const distanceMm = finiteNumber(input.distanceMm);
      return distanceMm === null ? null : distanceMm / 1000;
    })();
  const valid =
    input.valid !== false &&
    distanceM !== null &&
    distanceM >= 0;
  const angleDeg = finiteNumber(input.angleDeg);
  const angleValid = valid && input.angleValid === true && angleDeg !== null;
  const radiusFromOriginM = valid
    ? distanceM + radialZeroOffsetM
    : null;
  const radians = angleValid ? angleDeg * (Math.PI / 180) : null;
  const xM =
    radians === null || radiusFromOriginM === null
      ? null
      : Math.sin(radians) * radiusFromOriginM;
  const yM =
    radians === null || radiusFromOriginM === null
      ? null
      : Math.cos(radians) * radiusFromOriginM;
  const receivedAt =
    typeof options.receivedAt === "string"
      ? options.receivedAt
      : new Date(options.receivedAt ?? Date.now()).toISOString();

  return {
    valid,
    positionMode: !valid
      ? "unavailable"
      : angleValid
        ? "fitted-2d"
        : "range-only",
    distanceM: valid ? distanceM : null,
    distanceMm: valid ? distanceM * 1000 : null,
    radialZeroOffsetM,
    radiusFromOriginM,
    angleValid,
    angleDeg: angleValid ? angleDeg : null,
    xM,
    yM,
    plotX: valid ? (angleValid ? xM : 0) : null,
    plotY: valid ? (angleValid ? yM : radiusFromOriginM) : null,
    confidencePercent: confidencePercentOf(input, angleValid),
    quality: String(input.quality ?? (valid ? "unknown" : "unavailable")),
    source: String(input.source ?? "recorder-position"),
    sampleCount: Math.max(0, Math.round(finiteNumber(input.sampleCount) ?? 0)),
    usedAnchors: Array.isArray(input.usedAnchors)
      ? input.usedAnchors.map(String)
      : [],
    anchors: Array.isArray(input.anchors)
      ? input.anchors.map((anchor) => ({ ...anchor }))
      : [],
    expectedErrorM: finiteNumber(
      input.expectedMaxCalibrationErrorM ?? input.expectedErrorM,
    ),
    calibratedRangeM:
      input.calibratedRangeM && typeof input.calibratedRangeM === "object"
        ? { ...input.calibratedRangeM }
        : null,
    calibratedAngleDeg:
      input.calibratedAngleDeg && typeof input.calibratedAngleDeg === "object"
        ? { ...input.calibratedAngleDeg }
        : null,
    keyId: Number.isInteger(Number(input.keyId))
      ? Number(input.keyId)
      : null,
    reason: valid
      ? null
      : String(input.reason ?? "尚未收到有效的电脑拟合位置"),
    receivedAt,
  };
}
