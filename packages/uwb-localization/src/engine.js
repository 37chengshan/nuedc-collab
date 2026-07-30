import {
  CALIBRATION_ANGLES_DEG,
  CALIBRATION_RADII_MM,
  createCalibrationPlan,
  validateAnchorConfig,
} from "./calibration-plan.js";
import { applyCompensation, trainCompensationTable } from "./compensation.js";
import { hampelFilter, replayFrameSession } from "./frames.js";
import { solvePosition } from "./localization.js";
import {
  createCalibrationModelV1,
  exportCalibrationModelC,
  validateModel,
} from "./model.js";
import { fitAnchorRangeModels } from "./range-models.js";
import {
  clamp,
  finiteNumber,
  median,
  medianAbsoluteDeviation,
} from "./utils.js";

export async function assessCapture(input = {}) {
  const anchorCount = integerInRange(input.anchorCount ?? 2, 2, 4);
  const requiredDevices = Array.from(
    { length: anchorCount },
    (_, index) => index + 1,
  );
  const measurements = Array.isArray(input.measurements)
    ? input.measurements
    : [];
  const minimum = integerInRange(
    input.minimumSynchronizedGroups ?? 100,
    1,
    100000,
  );
  const replay = replayFrameSession(measurements, {
    requiredDevices,
    windowMs: input.synchronizationWindowMs ?? 120,
    minSynchronizedGroups: minimum,
  });
  const synchronizedFrames = replay.groups.flatMap((group) => group.frames);
  const anchors = normalizeAnchors(input.anchors, anchorCount);
  const boundaryDistanceMm =
    finiteNumber(input.distanceM, "distanceM") * 1000;
  const angleDeg = finiteNumber(input.angleDeg, "angleDeg");
  const offset = finiteNumber(input.boundaryOffsetMm ?? 300, "boundaryOffsetMm");
  const positionRadiusMm = boundaryDistanceMm + offset;
  const radians = (angleDeg * Math.PI) / 180;
  const point = {
    xMm: positionRadiusMm * Math.sin(radians),
    yMm: positionRadiusMm * Math.cos(radians),
  };

  const perAnchor = anchors.map((anchor, index) => {
    const device = index + 1;
    const raw = measurements
      .filter((frame) => Number(frame.device ?? frame.deviceId) === device)
      .map((frame) => normalizeDistance(frame))
      .filter(Number.isFinite);
    const synchronized = synchronizedFrames
      .filter((frame) => Number(frame.deviceId) === device)
      .map((frame) => frame.distanceMm);
    const filtered = hampelFilter(synchronized, {
      windowSize: 7,
      threshold: 3,
    });
    const center = median(filtered.accepted);
    const mad = medianAbsoluteDeviation(filtered.accepted, center);
    const snr = synchronizedFrames
      .filter((frame) => Number(frame.deviceId) === device)
      .map((frame) => frame.snrDb)
      .filter(Number.isFinite);
    const expectedDistanceMm = Math.hypot(
      point.xMm - anchor.xMm,
      point.yMm - anchor.yMm,
    );
    return {
      anchorId: anchor.id,
      samples: raw.length,
      synchronizedSamples: synchronized.length,
      medianCm: center === null ? null : center / 10,
      medianMm: center,
      spreadCm: mad === null ? null : (1.4826 * mad) / 10,
      madMm: mad,
      snrDb: median(snr),
      expectedDistanceCm: expectedDistanceMm / 10,
      expectedDistanceMm,
      residualCm: center === null ? null : (center - expectedDistanceMm) / 10,
      rejectedSamples: filtered.rejectedIndices.length,
    };
  });
  const reasons = [];
  if (replay.synchronizedGroupCount < minimum) {
    reasons.push({
      code:
        replay.parsedFrameCount > 0 &&
        new Set(replay.groups.map((group) => group.address)).size === 0
          ? "ADDRESS_MISMATCH_OR_DROPOUT"
          : "INSUFFICIENT_SYNCHRONIZED_SAMPLES",
      message: `仅得到 ${replay.synchronizedGroupCount} 组同地址同步数据，至少需要 ${minimum} 组`,
    });
  }
  for (const anchor of perAnchor) {
    if (anchor.synchronizedSamples < minimum) {
      reasons.push({
        code: "ANCHOR_SAMPLE_SHORTAGE",
        anchorId: anchor.anchorId,
        message: `${anchor.anchorId} 仅 ${anchor.synchronizedSamples} 组，至少需要 ${minimum} 组`,
      });
    }
    if (anchor.spreadCm !== null && anchor.spreadCm > 10) {
      reasons.push({
        code: "ANCHOR_UNSTABLE",
        anchorId: anchor.anchorId,
        message: `${anchor.anchorId} 波动 ${anchor.spreadCm.toFixed(1)} cm，保持钥匙静止后重采`,
      });
    }
  }
  return {
    accepted: reasons.length === 0,
    synchronizedGroups: replay.synchronizedGroupCount,
    inputFrames: replay.inputFrameCount,
    parsedFrames: replay.parsedFrameCount,
    perAnchor,
    recaptureReasons: reasons,
  };
}

export async function train(input = {}, context = {}) {
  const config = validateAnchorConfig({
    anchors: normalizeAnchors(input.anchors),
    radialZeroOffsetMm: input.boundaryOffsetMm ?? 300,
  });
  const captures = (input.captures ?? []).filter(
    (capture) => capture?.accepted !== false,
  );
  const expectedPlan = input.plan?.points ?? createCalibrationPlan();
  const captureByPoint = new Map(
    captures.map((capture) => [String(capture.pointId ?? capture.id), capture]),
  );
  const missing = expectedPlan
    .map((point) => String(point.pointId ?? point.id))
    .filter((pointId) => !captureByPoint.has(pointId));
  if (missing.length > 0) {
    throw calibrationError(
      "CALIBRATION_INCOMPLETE",
      `缺少 ${missing.length} 个标定点`,
      { recapturePoints: missing },
    );
  }

  const rangeSamples = [];
  for (const capture of captures) {
    for (const item of capture.perAnchor ?? []) {
      if (!Number.isFinite(Number(item.medianCm ?? item.medianMm))) {
        continue;
      }
      rangeSamples.push({
        pointId: String(capture.pointId),
        anchorId: normalizeAnchorId(item.anchorId),
        measuredMm: Number(item.medianMm ?? item.medianCm * 10),
        trueMm: Number(item.expectedDistanceMm ?? item.expectedDistanceCm * 10),
      });
    }
  }
  context.onProgress?.({
    phase: "range-models",
    completed: 0,
    total: config.anchors.length,
  });
  const rangeModels = fitAnchorRangeModels(rangeSamples);

  const positionRows = [];
  for (const [index, capture] of captures.entries()) {
    const estimate = estimateCapture(capture, config, rangeModels);
    if (!estimate.valid) {
      throw calibrationError(
        "CALIBRATION_POSITION_FAILED",
        `测点 ${capture.pointId} 无法完成定位`,
        { recapturePoints: [capture.pointId] },
      );
    }
    const trueBoundaryMm = Number(capture.distanceM) * 1000;
    const trueBearingDeg = Number(capture.angleDeg);
    positionRows.push({
      pointId: capture.pointId,
      boundaryDistanceMm: trueBoundaryMm,
      angleDeg: trueBearingDeg,
      estimatedBoundaryMm: estimate.boundaryDistanceMm,
      estimatedBearingDeg: estimate.bearingDeg,
      boundaryDistanceCorrectionMm:
        trueBoundaryMm - estimate.boundaryDistanceMm,
      angleCorrectionCdeg: Math.round(
        (trueBearingDeg - estimate.bearingDeg) * 100,
      ),
      xErrorMm:
        estimate.xMm -
        (trueBoundaryMm + config.radialZeroOffsetMm) *
          Math.sin((trueBearingDeg * Math.PI) / 180),
      yErrorMm:
        estimate.yMm -
        (trueBoundaryMm + config.radialZeroOffsetMm) *
          Math.cos((trueBearingDeg * Math.PI) / 180),
    });
    context.onProgress?.({
      phase: "position-grid",
      completed: index + 1,
      total: captures.length,
    });
  }
  const compensationTable = trainCompensationTable(positionRows);
  const measurementVariance = variance(
    positionRows.flatMap((row) => [row.xErrorMm, row.yErrorMm]),
  );
  const processVariance = variance(
    positionRows.slice(1).map((row, index) => {
      const previous = positionRows[index];
      return Math.hypot(
        row.xErrorMm - previous.xErrorMm,
        row.yErrorMm - previous.yErrorMm,
      );
    }),
  );
  const correctedRows = positionRows.map((row) => {
    const corrected = applyCompensation(compensationTable, {
      boundaryDistanceMm: row.estimatedBoundaryMm,
      bearingDeg: row.estimatedBearingDeg,
    });
    return {
      distanceErrorMm: corrected.boundaryDistanceMm - row.boundaryDistanceMm,
      bearingErrorDeg: corrected.bearingDeg - row.angleDeg,
    };
  });
  const rangeRmse = median(
    Object.values(rangeModels).map((model) => model.cv?.rmseMm ?? 0),
  );
  const absoluteDistanceErrors = correctedRows.map((row) =>
    Math.abs(row.distanceErrorMm),
  );
  const absoluteBearingErrors = correctedRows.map((row) =>
    Math.abs(row.bearingErrorDeg),
  );
  const positionP95Mm = percentile(absoluteDistanceErrors, 0.95);
  const model = createCalibrationModelV1({
    anchors: config.anchors,
    radialZeroOffsetMm: config.radialZeroOffsetMm,
    rangeModels,
    compensationTable,
    kalman: {
      processNoise: clamp(processVariance / 1000, 0.1, 100),
      measurementNoise: clamp(measurementVariance, 4, 100000),
      initialCovariance: Math.max(100, measurementVariance * 4),
    },
    metrics: {
      rangeCvRmseMm: rangeRmse ?? 0,
      positionP95Mm,
      distanceP95Mm: positionP95Mm,
      distanceMaxMm: Math.max(0, ...absoluteDistanceErrors),
      bearingP95Cdeg: Math.round(
        percentile(absoluteBearingErrors, 0.95) * 100,
      ),
      bearingMaxDeg: Math.max(0, ...absoluteBearingErrors),
      boundaryP95Mm: positionP95Mm,
      synchronizedGroups: captures.reduce(
        (sum, capture) => sum + Number(capture.synchronizedGroups ?? 0),
        0,
      ),
    },
    metadata: {
      trainedPointCount: captures.length,
      trainedAt: new Date().toISOString(),
    },
  });
  return {
    model,
    metrics: model.metrics,
    training: {
      pointCount: captures.length,
      rangeModelTypes: Object.fromEntries(
        Object.entries(rangeModels).map(([id, rangeModel]) => [
          id,
          rangeModel.type,
        ]),
      ),
    },
  };
}

export async function validate(input = {}, context = {}) {
  const model = input.model;
  const modelValidation = validateModel(model);
  if (!modelValidation.valid) {
    throw calibrationError(
      "CALIBRATION_MODEL_INVALID",
      modelValidation.errors.join("；"),
    );
  }
  const config = validateAnchorConfig({
    anchors: model.anchors,
    radialZeroOffsetMm: model.coordinateSystem.radialZeroOffsetMm,
  });
  const rows = [];
  const points =
    input.validationPoints?.length > 0
      ? input.validationPoints
      : input.captures ?? [];
  for (const [index, point] of points.entries()) {
    const estimate = estimateCapture(point, config, model.rangeModels);
    if (!estimate.valid) {
      continue;
    }
    const corrected = applyCompensation(model.compensationTable, estimate);
    const trueDistanceMm = Number(
      point.boundaryDistanceMm ?? Number(point.distanceM) * 1000,
    );
    const trueBearingDeg = Number(point.angleDeg);
    rows.push({
      pointId: point.pointId ?? point.id ?? `V${index + 1}`,
      trueDistanceMm,
      trueBearingDeg,
      estimatedDistanceMm: corrected.boundaryDistanceMm,
      estimatedBearingDeg: corrected.bearingDeg,
      distanceErrorMm: corrected.boundaryDistanceMm - trueDistanceMm,
      bearingErrorDeg: corrected.bearingDeg - trueBearingDeg,
    });
    context.onProgress?.({
      phase: "validate",
      completed: index + 1,
      total: points.length,
    });
  }
  const distanceErrors = rows.map((row) => Math.abs(row.distanceErrorMm));
  const bearingErrors = rows.map((row) => Math.abs(row.bearingErrorDeg));
  const metrics = {
    pointCount: rows.length,
    distanceP95M: percentile(distanceErrors, 0.95) / 1000,
    distanceMaxErrorM: Math.max(0, ...distanceErrors) / 1000,
    angleP95Deg: percentile(bearingErrors, 0.95),
    angleMaxErrorDeg: Math.max(0, ...bearingErrors),
  };
  const limits = input.limits ?? {};
  const passed =
    rows.length > 0 &&
    metrics.distanceMaxErrorM <= (limits.distanceMaxErrorM ?? 0.3) &&
    metrics.angleMaxErrorDeg <= (limits.angleMaxErrorDeg ?? 10);
  return {
    passed,
    metrics,
    rows,
    worstPoints: [...rows]
      .sort(
        (left, right) =>
          Math.abs(right.distanceErrorMm) -
            Math.abs(left.distanceErrorMm) ||
          Math.abs(right.bearingErrorDeg) - Math.abs(left.bearingErrorDeg),
      )
      .slice(0, 10),
  };
}

export async function exportFirmware(input = {}) {
  if (!input.model) {
    throw calibrationError("CALIBRATION_MODEL_MISSING", "尚未训练标定模型");
  }
  const base = sanitizeName(input.name ?? "calibration_model_data");
  const output = exportCalibrationModelC(input.model, {
    symbol: input.symbol ?? "g_calibration_model_v1",
    headerName: `${base}.h`,
    includeAuditJson: false,
  });
  return {
    ...output,
    target: input.target ?? "MSPM0G3507",
    headerFileName: `${base}.h`,
    sourceFileName: `${base}.c`,
    auditFileName: `${base}.json`,
  };
}

export function createCalibrationEngine() {
  return { assessCapture, train, validate, exportFirmware };
}

function estimateCapture(capture, config, rangeModels) {
  const ranges = (capture.perAnchor ?? [])
    .map((item) => ({
      anchorId: normalizeAnchorId(item.anchorId),
      distanceMm: Number(item.medianMm ?? item.medianCm * 10),
      snrDb: item.snrDb,
    }))
    .filter((range) => Number.isFinite(range.distanceMm));
  return solvePosition({
    anchors: config.anchors,
    ranges,
    rangeModels,
    radialZeroOffsetMm: config.radialZeroOffsetMm,
  });
}

function normalizeAnchors(anchors, anchorCount) {
  const defaults = [
    { id: "A1", xMm: -125, yMm: 40 },
    { id: "A2", xMm: 125, yMm: 40 },
    { id: "A3", xMm: -125, yMm: -40 },
    { id: "A4", xMm: 125, yMm: -40 },
  ];
  const source =
    Array.isArray(anchors) && anchors.length > 0 ? anchors : defaults;
  const count = anchorCount ?? source.filter((anchor) => anchor.enabled !== false).length;
  return source
    .filter((anchor) => anchor.enabled !== false)
    .slice(0, count)
    .map((anchor, index) => ({
      id: normalizeAnchorId(anchor.id ?? index + 1),
      xMm: finiteNumber(anchor.xMm, `anchors[${index}].xMm`),
      yMm: finiteNumber(anchor.yMm, `anchors[${index}].yMm`),
    }));
}

function normalizeAnchorId(value) {
  const text = String(value);
  return /^A/i.test(text) ? `A${text.slice(1)}` : `A${text}`;
}

function normalizeDistance(frame) {
  if (Number.isFinite(Number(frame.distanceMm))) {
    return Number(frame.distanceMm);
  }
  if (Number.isFinite(Number(frame.distanceCm))) {
    return Number(frame.distanceCm) * 10;
  }
  return Number.NaN;
}

function integerInRange(value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new RangeError(`数值必须在 ${minimum}～${maximum} 之间`);
  }
  return number;
}

function percentile(values, ratio) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
}

function variance(values) {
  if (values.length < 2) {
    return 0;
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return (
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (values.length - 1)
  );
}

function calibrationError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.status = 422;
  error.details = details;
  return error;
}

function sanitizeName(value) {
  const name = String(value).replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(name) ? name : `_${name}`;
}

export {
  CALIBRATION_ANGLES_DEG,
  CALIBRATION_RADII_MM,
};
