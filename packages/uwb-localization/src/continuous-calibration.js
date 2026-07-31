import {
  estimateSparseRealtime,
  trainSparseRealtimeModel,
} from "./sparse-realtime.js";
import { median } from "./utils.js";

const DEFAULT_LIMITS = Object.freeze({
  distanceMaxErrorM: 0.3,
  angleMaxErrorDeg: 10,
  boundaryMaxErrorM: 0.2,
  maximumP95RegressionRatio: 1.02,
});
const BOUNDARIES_M = Object.freeze([1, 2]);
const BOUNDARY_WINDOW_M = 0.2;

export function normalizeCalibrationSetup(input = {}) {
  const id = String(input.id ?? "").trim();
  if (!id) {
    throw new TypeError("setup.id不能为空");
  }
  const revision = Number(input.revision);
  if (!Number.isInteger(revision) || revision < 1) {
    throw new RangeError("setup.revision必须是大于等于1的整数");
  }
  const anchors = Array.isArray(input.anchors) ? input.anchors : [];
  if (anchors.length < 2 || anchors.length > 4) {
    throw new RangeError("固定场地必须配置2～4个锚点");
  }
  const normalizedAnchors = anchors.map((anchor, index) => ({
    id: normalizeAnchorId(anchor.id ?? index + 1),
    ...normalizePoint3d(anchor, `anchors[${index}]`),
  }));
  if (
    new Set(normalizedAnchors.map((anchor) => anchor.id)).size !==
    normalizedAnchors.length
  ) {
    throw new RangeError("锚点ID不能重复");
  }
  return {
    id,
    revision,
    doorLockOrigin: normalizePoint3d(
      input.doorLockOrigin ?? input.lock,
      "doorLockOrigin",
    ),
    anchors: normalizedAnchors,
  };
}

export function setupRevisionKey(setup) {
  const normalized = normalizeCalibrationSetup(setup);
  return `${normalized.id}@${normalized.revision}`;
}

export function mapGroundTruthToDoorPolar(setup, truth) {
  const normalizedSetup = normalizeCalibrationSetup(setup);
  const normalizedTruth = normalizePoint3d(truth, "truth");
  const dxM = normalizedTruth.xM - normalizedSetup.doorLockOrigin.xM;
  const dyM = normalizedTruth.yM - normalizedSetup.doorLockOrigin.yM;
  return {
    distanceM: Math.hypot(dxM, dyM),
    angleDeg: (Math.atan2(dxM, dyM) * 180) / Math.PI,
    radialZeroOffsetM: 0,
    relative: {
      xM: dxM,
      yM: dyM,
      zM: normalizedTruth.zM - normalizedSetup.doorLockOrigin.zM,
    },
  };
}

export function normalizeContinuousCalibrationRecord(input, { setup } = {}) {
  const normalizedSetup = normalizeCalibrationSetup(setup);
  const setupId = String(input?.setupId ?? "").trim();
  const setupRevision = Number(input?.setupRevision);
  if (
    setupId !== normalizedSetup.id ||
    setupRevision !== normalizedSetup.revision
  ) {
    throw new RangeError("记录的setup revision与当前固定场地不一致");
  }
  const id = String(input.id ?? input.captureId ?? "").trim();
  if (!id) {
    throw new TypeError("record.id不能为空");
  }
  const capturedAt = new Date(input.capturedAt);
  if (!Number.isFinite(capturedAt.getTime())) {
    throw new TypeError("record.capturedAt必须是有效时间");
  }
  const split = String(input.split ?? "train").toLowerCase();
  if (!["train", "validation"].includes(split)) {
    throw new RangeError("record.split必须是train或validation");
  }
  const truth = normalizePoint3d(input.truth, "record.truth");
  const anchorIds = new Set(normalizedSetup.anchors.map((anchor) => anchor.id));
  const perAnchor = (input.perAnchor ?? input.anchors ?? [])
    .map((anchor, index) => {
      const anchorId = normalizeAnchorId(anchor.anchorId ?? anchor.id ?? index + 1);
      if (!anchorIds.has(anchorId)) {
        throw new RangeError(`记录包含setup之外的锚点：${anchorId}`);
      }
      return {
        anchorId,
        medianMm: finiteNumber(
          anchor.medianMm ??
            (anchor.medianCm === undefined
              ? Number.NaN
              : Number(anchor.medianCm) * 10),
          `perAnchor[${index}].medianMm`,
        ),
        madMm: optionalFiniteNumber(
          anchor.madMm ??
            (anchor.spreadCm === undefined
              ? null
              : (Number(anchor.spreadCm) * 10) / 1.4826),
        ),
        snrDb: optionalFiniteNumber(anchor.snrDb),
      };
    });
  if (perAnchor.length < 2) {
    throw new RangeError("持续标定记录至少需要2路锚点汇总");
  }
  return {
    id,
    capturedAt: capturedAt.toISOString(),
    setupId,
    setupRevision,
    setupKey: `${setupId}@${setupRevision}`,
    physicalPointId:
      String(input.physicalPointId ?? "").trim() || coordinatePointKey(truth),
    split,
    accepted: input.accepted === true,
    truth,
    perAnchor,
  };
}

export function aggregateContinuousCalibrationRecords(
  records,
  { setup, split = "train", limitPerPoint = 5 } = {},
) {
  const normalizedSetup = normalizeCalibrationSetup(setup);
  const key = setupRevisionKey(normalizedSetup);
  const normalized = [];
  for (const record of records ?? []) {
    try {
      const item = normalizeContinuousCalibrationRecord(record, {
        setup: normalizedSetup,
      });
      if (
        item.accepted &&
        item.setupKey === key &&
        item.split === split
      ) {
        normalized.push(item);
      }
    } catch {
      // Other setup revisions and malformed historical records are isolated.
    }
  }
  const groups = new Map();
  for (const record of normalized) {
    const group = groups.get(record.physicalPointId) ?? [];
    group.push(record);
    groups.set(record.physicalPointId, group);
  }
  const samples = [];
  for (const [physicalPointId, group] of groups) {
    const selected = [...group]
      .sort(
        (left, right) =>
          Date.parse(right.capturedAt) - Date.parse(left.capturedAt),
      )
      .slice(0, limitPerPoint)
      .sort(
        (left, right) =>
          Date.parse(left.capturedAt) - Date.parse(right.capturedAt),
      );
    const truth = {
      xM: robustEqualLocation(selected.map((record) => record.truth.xM)),
      yM: robustEqualLocation(selected.map((record) => record.truth.yM)),
      zM: robustEqualLocation(selected.map((record) => record.truth.zM)),
    };
    const polar = mapGroundTruthToDoorPolar(normalizedSetup, truth);
    const anchorIds = [
      ...new Set(
        selected.flatMap((record) =>
          record.perAnchor.map((anchor) => anchor.anchorId),
        ),
      ),
    ].sort();
    const perAnchor = anchorIds
      .map((anchorId) => {
        const values = selected
          .map((record) =>
            record.perAnchor.find((anchor) => anchor.anchorId === anchorId),
          )
          .filter(Boolean);
        return {
          anchorId,
          medianMm: robustEqualLocation(
            values.map((anchor) => anchor.medianMm),
          ),
          madMm: robustEqualLocation(
            values.map((anchor) => anchor.madMm).filter(Number.isFinite),
          ),
          snrDb: robustEqualLocation(
            values.map((anchor) => anchor.snrDb).filter(Number.isFinite),
          ),
          recordCount: values.length,
        };
      })
      .filter((anchor) => Number.isFinite(anchor.medianMm));
    if (perAnchor.length < 2) {
      continue;
    }
    samples.push({
      sampleId: `${key}:${split}:${physicalPointId}`,
      captureId: `${key}:${split}:${physicalPointId}`,
      label: physicalPointId,
      pointId: physicalPointId,
      physicalPointId,
      setupKey: key,
      split,
      truth,
      distanceM: polar.distanceM,
      angleDeg: polar.angleDeg,
      radialZeroOffsetM: 0,
      perAnchor,
      recordCount: selected.length,
      captureIds: selected.map((record) => record.id),
    });
  }
  return samples.sort((left, right) =>
    left.physicalPointId.localeCompare(right.physicalPointId),
  );
}

export function evaluateContinuousCalibrationModel(
  model,
  samples,
  { estimator = estimateSparseRealtime } = {},
) {
  const rows = (samples ?? []).map((sample) => {
    let estimate;
    try {
      estimate = estimator(model, { anchors: sample.perAnchor });
    } catch {
      estimate = { valid: false, angleValid: false };
    }
    const distanceErrorM =
      estimate?.valid && Number.isFinite(Number(estimate.distanceM))
        ? Number(estimate.distanceM) - Number(sample.distanceM)
        : null;
    const angleErrorDeg =
      estimate?.angleValid && Number.isFinite(Number(estimate.angleDeg))
        ? normalizeAngleDeg(Number(estimate.angleDeg) - Number(sample.angleDeg))
        : null;
    return {
      pointId: sample.pointId ?? sample.physicalPointId,
      trueDistanceM: Number(sample.distanceM),
      estimatedDistanceM:
        distanceErrorM === null ? null : Number(estimate.distanceM),
      distanceErrorM,
      trueAngleDeg: Number(sample.angleDeg),
      estimatedAngleDeg:
        angleErrorDeg === null ? null : Number(estimate.angleDeg),
      angleErrorDeg,
      boundaryPoint: isBoundaryPoint(Number(sample.distanceM)),
      boundaryCrossings:
        distanceErrorM === null
          ? null
          : countBoundaryCrossings(
              Number(sample.distanceM),
              Number(estimate.distanceM),
            ),
    };
  });
  return summarizeEvaluationRows(rows);
}

function summarizeEvaluationRows(rows) {
  const distanceErrors = rows
    .map((row) => row.distanceErrorM)
    .filter(Number.isFinite)
    .map(Math.abs);
  const angleErrors = rows
    .map((row) => row.angleErrorDeg)
    .filter(Number.isFinite)
    .map(Math.abs);
  const boundaryRows = rows.filter((row) => row.boundaryPoint);
  const boundaryErrors = boundaryRows
    .map((row) => row.distanceErrorM)
    .filter(Number.isFinite)
    .map(Math.abs);
  return {
    pointCount: rows.length,
    validDistancePointCount: distanceErrors.length,
    validAnglePointCount: angleErrors.length,
    distanceMaxErrorM: maximumOrNull(distanceErrors),
    distanceP95M: percentileOrNull(distanceErrors, 0.95),
    angleMaxErrorDeg: maximumOrNull(angleErrors),
    angleP95Deg: percentileOrNull(angleErrors, 0.95),
    boundaryPointCount: boundaryRows.length,
    boundaryMaxErrorM: maximumOrNull(boundaryErrors),
    boundaryP95M: percentileOrNull(boundaryErrors, 0.95),
    boundaryCrossingCount: rows.reduce(
      (sum, row) => sum + Number(row.boundaryCrossings ?? 0),
      0,
    ),
    rows,
  };
}

export function assessContinuousCandidate(
  metrics,
  activeMetrics = null,
  limits = {},
) {
  const applied = { ...DEFAULT_LIMITS, ...limits };
  const reasons = [];
  requireFiniteMaximum(
    reasons,
    metrics.distanceMaxErrorM,
    applied.distanceMaxErrorM,
    "DISTANCE_MAX_EXCEEDED",
    "距离最大误差",
  );
  requireFiniteMaximum(
    reasons,
    metrics.angleMaxErrorDeg,
    applied.angleMaxErrorDeg,
    "ANGLE_MAX_EXCEEDED",
    "角度最大误差",
  );
  if (Number(metrics.boundaryPointCount) <= 0) {
    reasons.push({
      code: "BOUNDARY_VALIDATION_MISSING",
      message: "缺少1m或2m边界附近的独立验证点",
    });
  } else {
    requireFiniteMaximum(
      reasons,
      metrics.boundaryMaxErrorM,
      applied.boundaryMaxErrorM,
      "BOUNDARY_MAX_EXCEEDED",
      "边界最大误差",
    );
  }
  if (activeMetrics) {
    compareP95(
      reasons,
      "DISTANCE_P95_REGRESSION",
      "距离P95",
      metrics.distanceP95M,
      activeMetrics.distanceP95M,
      applied.maximumP95RegressionRatio,
    );
    compareP95(
      reasons,
      "ANGLE_P95_REGRESSION",
      "角度P95",
      metrics.angleP95Deg,
      activeMetrics.angleP95Deg,
      applied.maximumP95RegressionRatio,
    );
    if (
      Number(metrics.boundaryCrossingCount) >
      Number(activeMetrics.boundaryCrossingCount)
    ) {
      reasons.push({
        code: "BOUNDARY_CROSSING_REGRESSION",
        message:
          `边界跨越错误由${activeMetrics.boundaryCrossingCount}次增加到` +
          `${metrics.boundaryCrossingCount}次`,
      });
    }
  }
  return {
    passed: reasons.length === 0,
    limits: applied,
    reasons,
  };
}

export function buildContinuousCalibrationCandidate({
  setup,
  records,
  activeModel = null,
  limits = {},
  modelOptions = {},
} = {}) {
  const normalizedSetup = normalizeCalibrationSetup(setup);
  const trainingSamples = aggregateContinuousCalibrationRecords(records, {
    setup: normalizedSetup,
    split: "train",
  });
  const validationSamples = aggregateContinuousCalibrationRecords(records, {
    setup: normalizedSetup,
    split: "validation",
  });
  if (trainingSamples.length < 3) {
    throw new RangeError("候选模型至少需要3个独立训练物理点");
  }
  const model = trainSparseRealtimeModel(trainingSamples, modelOptions);
  model.continuousCalibration = {
    setupKey: setupRevisionKey(normalizedSetup),
    setup: normalizedSetup,
    radialZeroOffsetM: 0,
    aggregation: "latest-5-qualified-record-medians-equal-weight",
  };
  let metrics;
  let validation;
  if (validationSamples.length > 0) {
    metrics = evaluateContinuousCalibrationModel(model, validationSamples);
    validation = {
      mode: "independent-records",
      pointCount: validationSamples.length,
      samples: validationSamples,
    };
  } else {
    if (trainingSamples.length < 4) {
      throw new RangeError(
        "没有独立validation记录时，候选模型至少需要4个训练物理点进行逐点交叉验证",
      );
    }
    metrics = crossValidateContinuousCalibrationModel(
      trainingSamples,
      modelOptions,
    );
    validation = {
      mode: "leave-one-physical-point-out",
      pointCount: trainingSamples.length,
      samples: trainingSamples,
    };
  }
  const baselineMetrics = activeModel
    ? evaluateContinuousCalibrationModel(
        activeModel,
        validationSamples.length > 0
          ? validationSamples
          : trainingSamples,
      )
    : null;
  return {
    model,
    metrics,
    baselineMetrics,
    admission: assessContinuousCandidate(metrics, baselineMetrics, limits),
    training: {
      pointCount: trainingSamples.length,
      samples: trainingSamples,
    },
    validation,
  };
}

function crossValidateContinuousCalibrationModel(samples, modelOptions) {
  const rows = [];
  for (const heldOut of samples) {
    const training = samples.filter(
      (sample) => sample.physicalPointId !== heldOut.physicalPointId,
    );
    const foldModel = trainSparseRealtimeModel(training, {
      ...modelOptions,
      computeMetrics: false,
    });
    rows.push(
      ...evaluateContinuousCalibrationModel(foldModel, [heldOut]).rows,
    );
  }
  return summarizeEvaluationRows(rows);
}

function normalizePoint3d(input, label) {
  if (!input || typeof input !== "object") {
    throw new TypeError(`${label}必须包含xM/yM/zM`);
  }
  const millimeterInput =
    input.xM === undefined &&
    input.yM === undefined &&
    input.zM === undefined;
  return {
    xM:
      finiteNumber(
        millimeterInput ? input.xMm : input.xM,
        millimeterInput ? `${label}.xMm` : `${label}.xM`,
      ) / (millimeterInput ? 1000 : 1),
    yM:
      finiteNumber(
        millimeterInput ? input.yMm : input.yM,
        millimeterInput ? `${label}.yMm` : `${label}.yM`,
      ) / (millimeterInput ? 1000 : 1),
    zM:
      finiteNumber(
        millimeterInput ? input.zMm : input.zM,
        millimeterInput ? `${label}.zMm` : `${label}.zM`,
      ) / (millimeterInput ? 1000 : 1),
  };
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(`${label}必须是有效数字`);
  }
  return number;
}

function optionalFiniteNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeAnchorId(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new TypeError("锚点ID不能为空");
  }
  return /^A/i.test(text) ? `A${text.slice(1)}` : `A${text}`;
}

function coordinatePointKey(point) {
  return [point.xM, point.yM, point.zM]
    .map((value) => Math.round(value * 1000))
    .join(":");
}

function robustEqualLocation(values) {
  const finite = values.map(Number).filter(Number.isFinite);
  if (finite.length === 0) return null;
  return median(finite);
}

function normalizeAngleDeg(value) {
  let angle = value;
  while (angle > 180) angle -= 360;
  while (angle < -180) angle += 360;
  return angle;
}

function isBoundaryPoint(distanceM) {
  return BOUNDARIES_M.some(
    (boundaryM) => Math.abs(distanceM - boundaryM) <= BOUNDARY_WINDOW_M + 1e-9,
  );
}

function countBoundaryCrossings(trueDistanceM, estimatedDistanceM) {
  return BOUNDARIES_M.reduce((count, boundaryM) => {
    if (Math.abs(trueDistanceM - boundaryM) < 1e-12) return count;
    return (
      count +
      Number(
        (trueDistanceM < boundaryM && estimatedDistanceM >= boundaryM) ||
          (trueDistanceM > boundaryM && estimatedDistanceM <= boundaryM),
      )
    );
  }, 0);
}

function maximumOrNull(values) {
  return values.length > 0 ? Math.max(...values) : null;
}

function percentileOrNull(values, ratio) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
}

function requireFiniteMaximum(
  reasons,
  actual,
  limit,
  code,
  label,
) {
  if (!Number.isFinite(Number(actual)) || Number(actual) > Number(limit)) {
    reasons.push({
      code,
      message: `${label}${actual ?? "无有效数据"}，门槛为${limit}`,
    });
  }
}

function compareP95(
  reasons,
  code,
  label,
  candidate,
  active,
  ratio,
) {
  if (
    Number.isFinite(Number(active)) &&
    (!Number.isFinite(Number(candidate)) ||
      Number(candidate) > Number(active) * ratio + 1e-12)
  ) {
    reasons.push({
      code,
      message:
        `${label}由${active}恶化到${candidate ?? "无有效数据"}，` +
        `超过${((ratio - 1) * 100).toFixed(0)}%`,
    });
  }
}
