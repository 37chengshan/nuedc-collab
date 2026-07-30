import { buildAnchorCalibrationSamples } from "./calibration-plan.js";
import {
  clamp,
  finiteNumber,
  median,
  medianAbsoluteDeviation,
  weightedLeastSquares,
} from "./utils.js";

const DOMAIN_MM = Object.freeze([300, 3500]);
const MAX_PIECEWISE_KNOTS = 12;
const CANDIDATES = Object.freeze([
  { type: "linear", complexity: 1 },
  { type: "quadratic", complexity: 2 },
  { type: "piecewise-linear", complexity: 3 },
]);

export function fitRangeCalibration(samples, options = {}) {
  const prepared = prepareSamples(samples);
  const pointIds = [...new Set(prepared.map((sample) => sample.pointId))].sort();
  if (pointIds.length < 3) {
    throw new RangeError("测距模型至少需要 3 个不同 pointId");
  }

  const candidateScores = {};
  const fitted = new Map();
  for (const candidate of CANDIDATES) {
    const score = crossValidateCandidate(candidate.type, prepared, pointIds);
    const model = fitCandidate(candidate.type, prepared);
    const valid =
      model !== null &&
      (candidate.type === "piecewise-linear"
        ? isValidPiecewiseModel(model)
        : isMonotonicNonnegative(model));
    candidateScores[candidate.type] = {
      rmseMm: valid ? score.rmseMm : Number.POSITIVE_INFINITY,
      foldCount: pointIds.length,
      valid,
    };
    if (valid) {
      fitted.set(candidate.type, model);
    }
  }

  const finiteScores = Object.entries(candidateScores).filter(([, score]) =>
    Number.isFinite(score.rmseMm),
  );
  if (finiteScores.length === 0) {
    throw new Error("没有候选测距模型满足 0.3～3.5 m 单调且非负约束");
  }
  const bestRmse = Math.min(...finiteScores.map(([, score]) => score.rmseMm));
  const selected = CANDIDATES.find(({ type }) => {
    const score = candidateScores[type];
    return (
      score.valid &&
      score.rmseMm <= bestRmse * 1.05 + Math.max(1e-9, bestRmse * 1e-9)
    );
  });
  const model = fitted.get(selected.type);
  return {
    ...model,
    domainMm: [...DOMAIN_MM],
    cv: {
      rmseMm: candidateScores[selected.type].rmseMm,
      pointCount: pointIds.length,
      foldCount: pointIds.length,
    },
    candidateScores,
  };
}

export function fitAnchorRangeModels(samples, options = {}) {
  let prepared = samples;
  if (samples.some((sample) => sample.trueMm === undefined)) {
    if (!options.anchorConfig) {
      throw new TypeError(
        "缺少 trueMm 时必须通过 options.anchorConfig 提供锚点配置",
      );
    }
    prepared = buildAnchorCalibrationSamples(samples, options.anchorConfig);
  }
  const byAnchor = new Map();
  for (const sample of prepared) {
    const anchorId = String(sample.anchorId);
    const bucket = byAnchor.get(anchorId) ?? [];
    bucket.push(sample);
    byAnchor.set(anchorId, bucket);
  }

  return Object.fromEntries(
    [...byAnchor.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([anchorId, anchorSamples]) => [
        anchorId,
        fitRangeCalibration(anchorSamples, options),
      ]),
  );
}

export function predictRange(model, measuredMm) {
  const input = clamp(
    finiteNumber(measuredMm, "measuredMm"),
    model.domainMm?.[0] ?? DOMAIN_MM[0],
    model.domainMm?.[1] ?? DOMAIN_MM[1],
  );
  let predicted;
  if (model.type === "linear") {
    predicted = model.coefficients[0] + model.coefficients[1] * input;
  } else if (model.type === "quadratic") {
    predicted =
      model.coefficients[0] +
      model.coefficients[1] * input +
      model.coefficients[2] * input * input;
  } else if (model.type === "piecewise-linear") {
    predicted = interpolateKnots(
      model.rawKnotsMm,
      model.correctedKnotsMm,
      input,
    );
  } else {
    throw new TypeError(`未知测距模型类型: ${model.type}`);
  }
  return Math.max(0, predicted);
}

function prepareSamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new TypeError("samples 必须是非空数组");
  }
  return samples.map((sample, index) => ({
    ...sample,
    pointId: String(sample.pointId ?? `P-${index}`),
    measuredMm: finiteNumber(
      sample.measuredMm,
      `samples[${index}].measuredMm`,
    ),
    trueMm: finiteNumber(sample.trueMm, `samples[${index}].trueMm`),
  }));
}

function crossValidateCandidate(type, samples, pointIds) {
  let squaredError = 0;
  let count = 0;
  for (const pointId of pointIds) {
    const training = samples.filter((sample) => sample.pointId !== pointId);
    const validation = samples.filter((sample) => sample.pointId === pointId);
    const model = fitCandidate(type, training);
    if (!model) {
      return { rmseMm: Number.POSITIVE_INFINITY };
    }
    for (const sample of validation) {
      const residual = predictRange(model, sample.measuredMm) - sample.trueMm;
      squaredError += residual * residual;
      count += 1;
    }
  }
  return {
    rmseMm: count > 0 ? Math.sqrt(squaredError / count) : Number.POSITIVE_INFINITY,
  };
}

function fitCandidate(type, samples) {
  if (type === "linear") {
    const coefficients = fitPolynomialHuber(samples, 1);
    return coefficients ? { type, coefficients, domainMm: [...DOMAIN_MM] } : null;
  }
  if (type === "quadratic") {
    const coefficients = fitPolynomialHuber(samples, 2);
    return coefficients ? { type, coefficients, domainMm: [...DOMAIN_MM] } : null;
  }
  if (type === "piecewise-linear") {
    return fitPiecewise(samples);
  }
  return null;
}

function fitPolynomialHuber(samples, degree) {
  if (samples.length < degree + 1) {
    return null;
  }
  const center = (DOMAIN_MM[0] + DOMAIN_MM[1]) / 2;
  const scale = (DOMAIN_MM[1] - DOMAIN_MM[0]) / 2;
  const rows = samples.map((sample) => {
    const normalized = (sample.measuredMm - center) / scale;
    return degree === 1
      ? [1, normalized]
      : [1, normalized, normalized * normalized];
  });
  const targets = samples.map((sample) => sample.trueMm);
  let weights = Array(samples.length).fill(1);
  let normalizedCoefficients = null;

  for (let iteration = 0; iteration < 20; iteration += 1) {
    const next = weightedLeastSquares(rows, targets, weights);
    if (!next) {
      return null;
    }
    normalizedCoefficients = next;
    const residuals = rows.map(
      (row, index) => dot(row, normalizedCoefficients) - targets[index],
    );
    const residualCenter = median(residuals) ?? 0;
    const robustScale = Math.max(
      1e-6,
      1.4826 *
        (medianAbsoluteDeviation(residuals, residualCenter) ??
          rootMeanSquare(residuals)),
    );
    const delta = 1.345 * robustScale;
    const nextWeights = residuals.map((residual) => {
      const absolute = Math.abs(residual - residualCenter);
      return absolute <= delta ? 1 : delta / absolute;
    });
    const change = Math.max(
      ...nextWeights.map((weight, index) => Math.abs(weight - weights[index])),
    );
    weights = nextWeights;
    if (change < 1e-5) {
      break;
    }
  }

  if (degree === 1) {
    const [c0, c1] = normalizedCoefficients;
    return [c0 - (c1 * center) / scale, c1 / scale];
  }
  const [c0, c1, c2] = normalizedCoefficients;
  return [
    c0 - (c1 * center) / scale + (c2 * center * center) / (scale * scale),
    c1 / scale - (2 * c2 * center) / (scale * scale),
    c2 / (scale * scale),
  ];
}

function fitPiecewise(samples) {
  const grouped = new Map();
  for (const sample of samples) {
    const bucket = grouped.get(sample.pointId) ?? [];
    bucket.push(sample);
    grouped.set(sample.pointId, bucket);
  }
  if (grouped.size < 2) {
    return null;
  }
  const knots = [...grouped.values()]
    .map((group) => ({
      raw: robustLocation(group.map((sample) => sample.measuredMm)),
      corrected: robustLocation(group.map((sample) => sample.trueMm)),
      weight: group.length,
    }))
    .sort((left, right) => left.raw - right.raw);
  const isotonic = isotonicRegression(
    knots.map((knot) => Math.max(0, knot.corrected)),
    knots.map((knot) => knot.weight),
  );
  const selectedIndices = evenlySpacedIndices(
    knots.length,
    MAX_PIECEWISE_KNOTS,
  );
  return {
    type: "piecewise-linear",
    rawKnotsMm: selectedIndices.map((index) => knots[index].raw),
    correctedKnotsMm: selectedIndices.map((index) => isotonic[index]),
    domainMm: [...DOMAIN_MM],
  };
}

function evenlySpacedIndices(length, capacity) {
  if (length <= capacity) {
    return Array.from({ length }, (_, index) => index);
  }
  const indices = new Set([0, length - 1]);
  for (let index = 1; index < capacity - 1; index += 1) {
    indices.add(Math.round((index * (length - 1)) / (capacity - 1)));
  }
  return [...indices].sort((left, right) => left - right);
}

function robustLocation(values) {
  let estimate = median(values);
  for (let iteration = 0; iteration < 10; iteration += 1) {
    const residuals = values.map((value) => value - estimate);
    const scale = Math.max(
      1e-6,
      1.4826 * (medianAbsoluteDeviation(residuals, median(residuals)) ?? 0),
    );
    const delta = 1.345 * scale;
    let weighted = 0;
    let totalWeight = 0;
    for (const value of values) {
      const residual = Math.abs(value - estimate);
      const weight = residual <= delta ? 1 : delta / residual;
      weighted += value * weight;
      totalWeight += weight;
    }
    const next = totalWeight > 0 ? weighted / totalWeight : estimate;
    if (Math.abs(next - estimate) < 1e-6) {
      break;
    }
    estimate = next;
  }
  return estimate;
}

function isotonicRegression(values, weights) {
  const blocks = values.map((value, index) => ({
    start: index,
    end: index,
    weight: weights[index],
    value,
  }));
  for (let index = 0; index < blocks.length - 1; ) {
    if (blocks[index].value <= blocks[index + 1].value) {
      index += 1;
      continue;
    }
    const left = blocks[index];
    const right = blocks[index + 1];
    const weight = left.weight + right.weight;
    blocks.splice(index, 2, {
      start: left.start,
      end: right.end,
      weight,
      value: (left.value * left.weight + right.value * right.weight) / weight,
    });
    if (index > 0) {
      index -= 1;
    }
  }
  const result = Array(values.length);
  for (const block of blocks) {
    for (let index = block.start; index <= block.end; index += 1) {
      result[index] = block.value;
    }
  }
  return result;
}

function interpolateKnots(raw, corrected, value) {
  if (raw.length === 1) {
    return corrected[0];
  }
  let upper = raw.findIndex((knot) => knot >= value);
  if (upper === -1) {
    upper = raw.length - 1;
  } else if (upper === 0) {
    upper = 1;
  }
  const lower = upper - 1;
  const width = raw[upper] - raw[lower];
  if (Math.abs(width) < 1e-9) {
    return Math.max(corrected[lower], corrected[upper]);
  }
  const ratio = (value - raw[lower]) / width;
  const slope = Math.max(
    0,
    (corrected[upper] - corrected[lower]) / width,
  );
  return corrected[lower] + slope * width * ratio;
}

function isMonotonicNonnegative(model) {
  let previous = Number.NEGATIVE_INFINITY;
  for (let value = DOMAIN_MM[0]; value <= DOMAIN_MM[1]; value += 10) {
    const prediction = predictRange(model, value);
    if (
      !Number.isFinite(prediction) ||
      prediction < -1e-7 ||
      prediction + 1e-7 < previous
    ) {
      return false;
    }
    previous = prediction;
  }
  return true;
}

function isValidPiecewiseModel(model) {
  if (
    !Array.isArray(model.rawKnotsMm) ||
    model.rawKnotsMm.length < 2 ||
    model.rawKnotsMm.length !== model.correctedKnotsMm?.length
  ) {
    return false;
  }
  for (let index = 0; index < model.rawKnotsMm.length; index += 1) {
    if (
      !Number.isFinite(model.rawKnotsMm[index]) ||
      !Number.isFinite(model.correctedKnotsMm[index]) ||
      model.correctedKnotsMm[index] < 0
    ) {
      return false;
    }
    if (
      index > 0 &&
      (model.rawKnotsMm[index] <= model.rawKnotsMm[index - 1] ||
        model.correctedKnotsMm[index] < model.correctedKnotsMm[index - 1])
    ) {
      return false;
    }
  }
  return true;
}

function dot(left, right) {
  return left.reduce((total, value, index) => total + value * right[index], 0);
}

function rootMeanSquare(values) {
  return Math.sqrt(
    values.reduce((total, value) => total + value * value, 0) /
      Math.max(1, values.length),
  );
}
