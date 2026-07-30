import { clamp, median, medianAbsoluteDeviation } from "./utils.js";

const MIN_DISTANCE_MM = 300;
const MAX_DISTANCE_MM = 3500;
const DEFAULT_SECONDARY_MIN_SNR_DB = 6;
const DEFAULT_SECONDARY_MAX_MAD_MM = 120;

export function parseSparseCalibrationLabel(label) {
  const text = String(label ?? "")
    .trim()
    .replaceAll("。", ".");
  const explicit = text.match(/R(\d+(?:\.\d+)?)\s*-\s*A([+-]?\d+(?:\.\d+)?)/i);
  if (explicit) {
    return {
      distanceM: Number(explicit[1]) / 100,
      angleDeg: Number(explicit[2]),
      angleSource: "explicit",
    };
  }

  const centerline = text.match(/中轴\s*(\d+(?:\.\d+)?)/i);
  if (centerline) {
    return {
      distanceM: Number(centerline[1]),
      angleDeg: 0,
      angleSource: "centerline",
    };
  }

  const distanceOnly = text.match(/^d[1-4]\s+(\d+(?:\.\d+)?)/i);
  if (distanceOnly) {
    return {
      distanceM: Number(distanceOnly[1]),
      angleDeg: null,
      angleSource: "distance-only",
    };
  }

  return null;
}

export function trainSparseRealtimeModel(samples, options = {}) {
  const normalized = (samples ?? [])
    .map(normalizeTrainingSample)
    .filter(Boolean);
  if (normalized.length < 3) {
    throw new RangeError("稀疏实时标定至少需要 3 个有效测点");
  }

  const anchorIds = [
    ...new Set(
      normalized.flatMap((sample) =>
        sample.anchors.map((anchor) => anchor.anchorId),
      ),
    ),
  ].sort();
  const primaryAnchorId = String(options.primaryAnchorId ?? anchorIds[0] ?? "A1");
  const secondaryAnchorId = String(
    options.secondaryAnchorId ?? anchorIds.find((id) => id !== primaryAnchorId) ?? "",
  );
  const rangeKnots = Object.fromEntries(
    anchorIds.map((anchorId) => [
      anchorId,
      buildRangeKnots(normalized, anchorId),
    ]),
  );
  if ((rangeKnots[primaryAnchorId] ?? []).length < 2) {
    throw new RangeError("主测距链路至少需要两个不同距离的标定点");
  }

  const angleSamples = normalized.filter(
    (sample) =>
      Number.isFinite(sample.angleDeg) &&
      sample.anchors.some((anchor) => anchor.anchorId === primaryAnchorId) &&
      sample.anchors.some((anchor) => anchor.anchorId === secondaryAnchorId),
  );
  const featureScales = buildFeatureScales(angleSamples, [
    primaryAnchorId,
    secondaryAnchorId,
  ]);
  const anglePrototypes = angleSamples.map((sample) => ({
    label: sample.label,
    distanceM: sample.distanceMm / 1000,
    angleDeg: sample.angleDeg,
    features: featureVector(
      sample.anchors,
      [primaryAnchorId, secondaryAnchorId],
      featureScales,
    ),
  }));

  const model = {
    version: 1,
    mode: "sparse-final-captures",
    primaryAnchorId,
    secondaryAnchorId,
    rangeKnots,
    anglePrototypes,
    featureScales,
    limits: {
      minimumDistanceMm: MIN_DISTANCE_MM,
      maximumDistanceMm: MAX_DISTANCE_MM,
      secondaryMinSnrDb:
        options.secondaryMinSnrDb ?? DEFAULT_SECONDARY_MIN_SNR_DB,
      secondaryMaxMadMm:
        options.secondaryMaxMadMm ?? DEFAULT_SECONDARY_MAX_MAD_MM,
    },
    calibratedRangeM: {
      minimum: Math.min(...normalized.map((sample) => sample.distanceMm)) / 1000,
      maximum: Math.max(...normalized.map((sample) => sample.distanceMm)) / 1000,
    },
    calibratedAngleDeg: {
      minimum:
        angleSamples.length > 0
          ? Math.min(...angleSamples.map((sample) => sample.angleDeg))
          : null,
      maximum:
        angleSamples.length > 0
          ? Math.max(...angleSamples.map((sample) => sample.angleDeg))
          : null,
    },
    metrics: {},
  };

  const validationRows = normalized.map((sample) => {
    const estimate = estimateSparseRealtime(model, {
      anchors: sample.anchors,
    });
    return {
      label: sample.label,
      distanceErrorM: estimate.distanceM - sample.distanceMm / 1000,
      angleErrorDeg:
        Number.isFinite(sample.angleDeg) && estimate.angleValid
          ? estimate.angleDeg - sample.angleDeg
          : null,
    };
  });
  const distanceErrors = validationRows.map((row) =>
    Math.abs(row.distanceErrorM),
  );
  const angleErrors = validationRows
    .map((row) => row.angleErrorDeg)
    .filter(Number.isFinite)
    .map(Math.abs);
  model.metrics = {
    trainingPointCount: normalized.length,
    anglePointCount: angleSamples.length,
    distanceMaxErrorM: Math.max(...distanceErrors),
    distanceP95M: percentile(distanceErrors, 0.95),
    angleMaxErrorDeg: angleErrors.length > 0 ? Math.max(...angleErrors) : null,
    angleP95Deg: angleErrors.length > 0 ? percentile(angleErrors, 0.95) : null,
    validationRows,
  };
  return model;
}

export function estimateSparseRealtime(model, input = {}) {
  if (!model?.rangeKnots || !model.primaryAnchorId) {
    throw new TypeError("稀疏实时标定模型无效");
  }
  const anchors = normalizeObservationAnchors(input.anchors ?? []);
  const byId = new Map(anchors.map((anchor) => [anchor.anchorId, anchor]));
  const primary = byId.get(model.primaryAnchorId);
  if (!primary || !Number.isFinite(primary.medianMm)) {
    return invalidEstimate("主测距链路暂无有效数据");
  }

  const rawDistanceMm = interpolateRange(
    model.rangeKnots[model.primaryAnchorId],
    primary.medianMm,
  );
  const distanceMm = clamp(
    rawDistanceMm,
    model.limits?.minimumDistanceMm ?? MIN_DISTANCE_MM,
    model.limits?.maximumDistanceMm ?? MAX_DISTANCE_MM,
  );
  const secondary = byId.get(model.secondaryAnchorId);
  const secondaryGood =
    secondary &&
    Number.isFinite(secondary.medianMm) &&
    (secondary.snrDb === null ||
      secondary.snrDb >=
        (model.limits?.secondaryMinSnrDb ?? DEFAULT_SECONDARY_MIN_SNR_DB)) &&
    (secondary.madMm === null ||
      secondary.madMm <=
        (model.limits?.secondaryMaxMadMm ?? DEFAULT_SECONDARY_MAX_MAD_MM));

  let angleDeg = null;
  let angleConfidence = 0;
  if (secondaryGood && model.anglePrototypes?.length > 0) {
    const features = featureVector(
      [primary, secondary],
      [model.primaryAnchorId, model.secondaryAnchorId],
      model.featureScales,
    );
    const neighbors = model.anglePrototypes
      .map((prototype) => ({
        prototype,
        distance: euclidean(features, prototype.features),
      }))
      .sort((left, right) => left.distance - right.distance);
    const exact = neighbors.filter((neighbor) => neighbor.distance < 1e-9);
    if (exact.length > 0) {
      angleDeg =
        exact.reduce((sum, item) => sum + item.prototype.angleDeg, 0) /
        exact.length;
      angleConfidence = 1;
    } else {
      const selected = neighbors.slice(0, Math.min(4, neighbors.length));
      const weighted = selected.map((neighbor) => ({
        ...neighbor,
        weight: 1 / Math.max(0.02, neighbor.distance) ** 2,
      }));
      const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
      angleDeg =
        weighted.reduce(
          (sum, item) => sum + item.prototype.angleDeg * item.weight,
          0,
        ) / totalWeight;
      angleConfidence = clamp(1 / (1 + selected[0].distance), 0, 1);
    }
    const minimumAngle = model.calibratedAngleDeg?.minimum;
    const maximumAngle = model.calibratedAngleDeg?.maximum;
    if (Number.isFinite(minimumAngle) && Number.isFinite(maximumAngle)) {
      angleDeg = clamp(angleDeg, minimumAngle, maximumAngle);
    }
  }

  return {
    valid: true,
    distanceM: distanceMm / 1000,
    distanceMm,
    angleValid: Number.isFinite(angleDeg),
    angleDeg,
    angleConfidence,
    quality: secondaryGood ? "good" : "degraded",
    usedAnchors: secondaryGood
      ? [model.primaryAnchorId, model.secondaryAnchorId]
      : [model.primaryAnchorId],
    calibratedRangeM: model.calibratedRangeM,
    calibratedAngleDeg: model.calibratedAngleDeg,
    expectedMaxCalibrationErrorM: model.metrics?.distanceMaxErrorM ?? null,
  };
}

function normalizeTrainingSample(sample) {
  const parsed =
    Number.isFinite(Number(sample?.distanceM)) || sample?.distanceMm !== undefined
      ? {
          distanceM: Number(
            sample.distanceM ?? Number(sample.distanceMm) / 1000,
          ),
          angleDeg:
            sample.angleDeg === null || sample.angleDeg === undefined
              ? null
              : Number(sample.angleDeg),
        }
      : parseSparseCalibrationLabel(sample?.label);
  if (
    !parsed ||
    !Number.isFinite(parsed.distanceM) ||
    parsed.distanceM < 0.3 ||
    parsed.distanceM > 3.5
  ) {
    return null;
  }
  const anchors = normalizeObservationAnchors(sample.perAnchor ?? sample.anchors);
  if (anchors.length === 0) {
    return null;
  }
  return {
    label: String(sample.label ?? sample.pointId ?? ""),
    distanceMm: parsed.distanceM * 1000,
    angleDeg: Number.isFinite(parsed.angleDeg) ? parsed.angleDeg : null,
    anchors,
  };
}

function normalizeObservationAnchors(anchors) {
  return (anchors ?? [])
    .map((anchor, index) => {
      const medianMm = Number(
        anchor.medianMm ??
          (anchor.medianCm === undefined ? Number.NaN : anchor.medianCm * 10),
      );
      return {
        anchorId: normalizeAnchorId(anchor.anchorId ?? index + 1),
        medianMm,
        snrDb:
          anchor.snrDb === null || anchor.snrDb === undefined
            ? null
            : Number(anchor.snrDb),
        madMm:
          anchor.madMm === null || anchor.madMm === undefined
            ? anchor.spreadCm === null || anchor.spreadCm === undefined
              ? null
              : (Number(anchor.spreadCm) * 10) / 1.4826
            : Number(anchor.madMm),
      };
    })
    .filter((anchor) => Number.isFinite(anchor.medianMm));
}

function buildRangeKnots(samples, anchorId) {
  const byDistance = new Map();
  for (const sample of samples) {
    const anchor = sample.anchors.find((item) => item.anchorId === anchorId);
    if (!anchor) continue;
    const values = byDistance.get(sample.distanceMm) ?? [];
    values.push(anchor.medianMm);
    byDistance.set(sample.distanceMm, values);
  }
  return [...byDistance.entries()]
    .map(([distanceMm, measured]) => ({
      distanceMm,
      measuredMm: robustLocation(measured),
      sampleCount: measured.length,
    }))
    .sort(
      (left, right) =>
        left.measuredMm - right.measuredMm ||
        left.distanceMm - right.distanceMm,
    );
}

function buildFeatureScales(samples, anchorIds) {
  return anchorIds.map((anchorId) => {
    const values = samples
      .map((sample) =>
        sample.anchors.find((anchor) => anchor.anchorId === anchorId),
      )
      .filter(Boolean)
      .map((anchor) => anchor.medianMm);
    const center = median(values) ?? 0;
    const mad = medianAbsoluteDeviation(values, center) ?? 0;
    return Math.max(50, 1.4826 * mad);
  });
}

function featureVector(anchors, anchorIds, scales) {
  const byId = new Map(anchors.map((anchor) => [anchor.anchorId, anchor]));
  return anchorIds.map(
    (anchorId, index) =>
      (byId.get(anchorId)?.medianMm ?? 0) / Math.max(1, scales[index] ?? 1),
  );
}

function interpolateRange(knots, measuredMm) {
  if (!Array.isArray(knots) || knots.length < 2) {
    throw new RangeError("测距校正折线至少需要两个节点");
  }
  let left = knots[0];
  let right = knots[1];
  if (measuredMm >= knots.at(-1).measuredMm) {
    left = knots.at(-2);
    right = knots.at(-1);
  } else if (measuredMm > knots[0].measuredMm) {
    for (let index = 1; index < knots.length; index += 1) {
      if (measuredMm <= knots[index].measuredMm) {
        left = knots[index - 1];
        right = knots[index];
        break;
      }
    }
  }
  const span = right.measuredMm - left.measuredMm;
  if (Math.abs(span) < 1e-9) {
    return (left.distanceMm + right.distanceMm) / 2;
  }
  const ratio = (measuredMm - left.measuredMm) / span;
  return left.distanceMm + ratio * (right.distanceMm - left.distanceMm);
}

function robustLocation(values) {
  let estimate = median(values);
  if (estimate === null) return Number.NaN;
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const residuals = values.map((value) => value - estimate);
    const scale = Math.max(
      1,
      1.4826 * (medianAbsoluteDeviation(values, estimate) ?? 0),
    );
    let weighted = 0;
    let totalWeight = 0;
    for (let index = 0; index < values.length; index += 1) {
      const ratio = Math.abs(residuals[index]) / (1.5 * scale);
      const weight = ratio <= 1 ? 1 : 1 / ratio;
      weighted += values[index] * weight;
      totalWeight += weight;
    }
    const next = weighted / totalWeight;
    if (Math.abs(next - estimate) < 1e-6) break;
    estimate = next;
  }
  return estimate;
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
}

function euclidean(left, right) {
  return Math.sqrt(
    left.reduce((sum, value, index) => sum + (value - right[index]) ** 2, 0),
  );
}

function normalizeAnchorId(value) {
  const text = String(value);
  return /^A/i.test(text) ? `A${text.slice(1)}` : `A${text}`;
}

function invalidEstimate(reason) {
  return {
    valid: false,
    reason,
    distanceM: null,
    distanceMm: null,
    angleValid: false,
    angleDeg: null,
    angleConfidence: 0,
    quality: "invalid",
    usedAnchors: [],
  };
}
