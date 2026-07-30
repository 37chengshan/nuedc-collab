import { predictRange } from "./range-models.js";
import {
  clamp,
  finiteNumber,
  median,
  medianAbsoluteDeviation,
  roundTo,
  solveLinearSystem,
  squaredDistance,
} from "./utils.js";

export function solvePosition({
  anchors,
  ranges,
  radialZeroOffsetMm = 300,
  history,
  rangeModels,
  residualThresholdMm = 180,
  maxIterations = 5,
  stopThresholdMm = 1,
} = {}) {
  if (!Array.isArray(anchors) || anchors.length < 2 || anchors.length > 4) {
    throw new RangeError("定位必须配置 2 到 4 个锚点");
  }
  const normalizedAnchors = anchors.map((anchor, index) => ({
    id: String(anchor.id ?? `A${index + 1}`),
    xMm: finiteNumber(anchor.xMm, `anchors[${index}].xMm`),
    yMm: finiteNumber(anchor.yMm, `anchors[${index}].yMm`),
  }));
  const rangeByAnchor = new Map(
    (ranges ?? [])
      .filter((range) => range?.valid !== false)
      .map((range) => [String(range.anchorId), range]),
  );
  const validMask = normalizedAnchors.map((anchor) => {
    const range = rangeByAnchor.get(anchor.id);
    return Number.isFinite(Number(range?.distanceMm));
  });
  const observations = normalizedAnchors
    .map((anchor, index) => {
      const range = rangeByAnchor.get(anchor.id);
      if (!validMask[index]) {
        return null;
      }
      const measuredMm = Number(range.distanceMm);
      const model = rangeModels?.[anchor.id] ?? range.model;
      return {
        anchor,
        anchorIndex: index,
        distanceMm: model ? predictRange(model, measuredMm) : measuredMm,
        weight: observationWeight(range),
      };
    })
    .filter(Boolean);

  if (observations.length < 2) {
    return invalidResult(validMask);
  }
  if (observations.length === 2) {
    const two = solveTwoObservations(observations, history);
    return two
      ? makeResult(two.point, observations, validMask, {
          mode: "two-circle",
          iterations: 0,
          qualityCap: 0.65,
          radialZeroOffsetMm,
        })
      : invalidResult(validMask);
  }

  const full = solveLm(observations, history, {
    maxIterations,
    stopThresholdMm,
  });
  if (!full) {
    return invalidResult(validMask);
  }
  const maximumResidual = Math.max(
    ...full.residuals.map((residual) => Math.abs(residual)),
  );

  if (observations.length === 4 && maximumResidual > residualThresholdMm) {
    const leaveOneOut = observations
      .map((omitted, omittedIndex) => {
        const subset = observations.filter((_, index) => index !== omittedIndex);
        const solution = solveLm(subset, history, {
          maxIterations,
          stopThresholdMm,
        });
        return solution
          ? {
              omitted,
              subset,
              solution,
              score: rootMeanSquare(solution.residuals),
            }
          : null;
      })
      .filter(Boolean)
      .sort((left, right) => left.score - right.score)[0];
    if (
      leaveOneOut &&
      (leaveOneOut.score < residualThresholdMm ||
        leaveOneOut.score < rootMeanSquare(full.residuals) * 0.7)
    ) {
      const mask = [...validMask];
      mask[leaveOneOut.omitted.anchorIndex] = false;
      return makeResult(leaveOneOut.solution.point, leaveOneOut.subset, mask, {
        mode: "lm-loo",
        iterations: leaveOneOut.solution.iterations,
        qualityCap: 0.82,
        radialZeroOffsetMm,
      });
    }
  }

  if (observations.length === 3 && maximumResidual > residualThresholdMm) {
    const degraded = bestTwoAnchorDegradation(observations, history);
    if (degraded) {
      const mask = [...validMask];
      observations.forEach((observation) => {
        mask[observation.anchorIndex] = degraded.observations.includes(observation);
      });
      return makeResult(degraded.point, degraded.observations, mask, {
        mode: "two-anchor-degraded",
        iterations: full.iterations,
        qualityCap: 0.55,
        radialZeroOffsetMm,
      });
    }
  }

  return makeResult(full.point, observations, validMask, {
    mode: "lm",
    iterations: full.iterations,
    qualityCap: 1,
    radialZeroOffsetMm,
  });
}

function solveTwoObservations(observations, history) {
  const [left, right] = observations;
  const first = left.anchor;
  const second = right.anchor;
  const dx = second.xMm - first.xMm;
  const dy = second.yMm - first.yMm;
  const baseline = Math.hypot(dx, dy);
  if (baseline < 1e-9) {
    return null;
  }
  const a =
    (left.distanceMm * left.distanceMm -
      right.distanceMm * right.distanceMm +
      baseline * baseline) /
    (2 * baseline);
  let heightSquared = left.distanceMm * left.distanceMm - a * a;
  if (heightSquared < -1e-6) {
    return null;
  }
  heightSquared = Math.max(0, heightSquared);
  const height = Math.sqrt(heightSquared);
  const centerX = first.xMm + (a * dx) / baseline;
  const centerY = first.yMm + (a * dy) / baseline;
  const perpendicularX = -dy / baseline;
  const perpendicularY = dx / baseline;
  const candidates = [
    {
      xMm: centerX + height * perpendicularX,
      yMm: centerY + height * perpendicularY,
    },
    {
      xMm: centerX - height * perpendicularX,
      yMm: centerY - height * perpendicularY,
    },
  ];
  const front = candidates.filter((candidate) => candidate.yMm >= 0);
  const selectable = front.length > 0 ? front : candidates;
  let point;
  if (history && Number.isFinite(history.xMm) && Number.isFinite(history.yMm)) {
    point = [...selectable].sort(
      (one, another) =>
        squaredDistance(one, history) - squaredDistance(another, history),
    )[0];
  } else {
    point = [...selectable].sort((one, another) => another.yMm - one.yMm)[0];
  }
  return { point, candidates };
}

function solveLm(
  observations,
  history,
  { maxIterations = 5, stopThresholdMm = 1 } = {},
) {
  let point =
    history && Number.isFinite(history.xMm) && Number.isFinite(history.yMm)
      ? { xMm: Number(history.xMm), yMm: Number(history.yMm) }
      : linearizedInitialGuess(observations);
  if (!point) {
    point = weightedCentroid(observations);
  }
  let lambda = 1;
  let iterations = 0;

  for (; iterations < Math.min(5, maxIterations); iterations += 1) {
    const state = residualState(observations, point);
    const robustScale = Math.max(
      10,
      1.4826 *
        (medianAbsoluteDeviation(state.residuals, median(state.residuals)) ?? 0),
    );
    const huberDelta = 1.345 * robustScale;
    const normal = [
      [lambda, 0],
      [0, lambda],
    ];
    const right = [0, 0];

    for (let index = 0; index < observations.length; index += 1) {
      const residual = state.residuals[index];
      const absolute = Math.abs(residual);
      const robustWeight = absolute <= huberDelta ? 1 : huberDelta / absolute;
      const weight = observations[index].weight * robustWeight;
      const [jx, jy] = state.jacobians[index];
      normal[0][0] += weight * jx * jx;
      normal[0][1] += weight * jx * jy;
      normal[1][0] += weight * jy * jx;
      normal[1][1] += weight * jy * jy;
      right[0] -= weight * jx * residual;
      right[1] -= weight * jy * residual;
    }
    const step = solveLinearSystem(normal, right);
    if (!step) {
      break;
    }
    const next = { xMm: point.xMm + step[0], yMm: point.yMm + step[1] };
    const currentCost = robustCost(state.residuals, huberDelta);
    const nextResiduals = residualState(observations, next).residuals;
    if (robustCost(nextResiduals, huberDelta) <= currentCost) {
      point = next;
      lambda = Math.max(1e-4, lambda * 0.3);
    } else {
      lambda = Math.min(1e6, lambda * 10);
    }
    if (Math.hypot(step[0], step[1]) < stopThresholdMm) {
      iterations += 1;
      break;
    }
  }

  const finalState = residualState(observations, point);
  return {
    point,
    residuals: finalState.residuals,
    iterations,
  };
}

function linearizedInitialGuess(observations) {
  const reference = observations[0];
  const rows = [];
  const targets = [];
  for (let index = 1; index < observations.length; index += 1) {
    const current = observations[index];
    rows.push([
      2 * (current.anchor.xMm - reference.anchor.xMm),
      2 * (current.anchor.yMm - reference.anchor.yMm),
    ]);
    targets.push(
      reference.distanceMm * reference.distanceMm -
        current.distanceMm * current.distanceMm +
        current.anchor.xMm * current.anchor.xMm +
        current.anchor.yMm * current.anchor.yMm -
        reference.anchor.xMm * reference.anchor.xMm -
        reference.anchor.yMm * reference.anchor.yMm,
    );
  }
  let a00 = 0;
  let a01 = 0;
  let a11 = 0;
  let b0 = 0;
  let b1 = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const [x, y] = rows[index];
    a00 += x * x;
    a01 += x * y;
    a11 += y * y;
    b0 += x * targets[index];
    b1 += y * targets[index];
  }
  const solved = solveLinearSystem(
    [
      [a00, a01],
      [a01, a11],
    ],
    [b0, b1],
  );
  return solved ? { xMm: solved[0], yMm: solved[1] } : null;
}

function weightedCentroid(observations) {
  const total = observations.reduce(
    (sum, observation) => sum + observation.weight,
    0,
  );
  return {
    xMm:
      observations.reduce(
        (sum, observation) =>
          sum + observation.anchor.xMm * observation.weight,
        0,
      ) / total,
    yMm:
      observations.reduce(
        (sum, observation) =>
          sum + observation.anchor.yMm * observation.weight,
        0,
      ) / total,
  };
}

function residualState(observations, point) {
  const residuals = [];
  const jacobians = [];
  for (const observation of observations) {
    const dx = point.xMm - observation.anchor.xMm;
    const dy = point.yMm - observation.anchor.yMm;
    const predicted = Math.max(1e-9, Math.hypot(dx, dy));
    residuals.push(predicted - observation.distanceMm);
    jacobians.push([dx / predicted, dy / predicted]);
  }
  return { residuals, jacobians };
}

function bestTwoAnchorDegradation(observations, history) {
  const candidates = [];
  for (let left = 0; left < observations.length - 1; left += 1) {
    for (let right = left + 1; right < observations.length; right += 1) {
      const pair = [observations[left], observations[right]];
      const solved = solveTwoObservations(pair, history);
      if (!solved) {
        continue;
      }
      const omitted = observations.find((observation) => !pair.includes(observation));
      const omittedResidual = Math.abs(
        Math.hypot(
          solved.point.xMm - omitted.anchor.xMm,
          solved.point.yMm - omitted.anchor.yMm,
        ) - omitted.distanceMm,
      );
      const historyDistance =
        history && Number.isFinite(history.xMm) && Number.isFinite(history.yMm)
          ? Math.hypot(
              solved.point.xMm - history.xMm,
              solved.point.yMm - history.yMm,
            )
          : 0;
      candidates.push({
        point: solved.point,
        observations: pair,
        score: historyDistance + omittedResidual * (history ? 0.05 : 1),
      });
    }
  }
  return candidates.sort((left, right) => left.score - right.score)[0] ?? null;
}

function makeResult(
  point,
  observations,
  validMask,
  { mode, iterations, qualityCap, radialZeroOffsetMm },
) {
  const normalizedPoint = {
    xMm: roundTo(point.xMm, 12),
    yMm: roundTo(point.yMm, 12),
  };
  const state = residualState(observations, normalizedPoint);
  const residualMm = rootMeanSquare(state.residuals);
  const positionRadiusMm = Math.hypot(
    normalizedPoint.xMm,
    normalizedPoint.yMm,
  );
  const boundaryDistanceMm = positionRadiusMm - radialZeroOffsetMm;
  const bearingDeg =
    (Math.atan2(normalizedPoint.xMm, normalizedPoint.yMm) * 180) / Math.PI;
  const quality = clamp(
    qualityCap *
      Math.exp(-residualMm / 180) *
      (0.55 + 0.45 * (observations.length / 4)),
    0,
    1,
  );
  return {
    valid: true,
    xMm: normalizedPoint.xMm,
    yMm: normalizedPoint.yMm,
    positionRadiusMm,
    boundaryDistanceMm,
    radialMm: boundaryDistanceMm,
    bearingDeg,
    residual: residualMm,
    residualMm,
    residualsMm: Object.fromEntries(
      observations.map((observation, index) => [
        observation.anchor.id,
        state.residuals[index],
      ]),
    ),
    quality,
    mode,
    validMask,
    usedAnchorIds: observations.map((observation) => observation.anchor.id),
    iterations,
    withinBearingRange: Math.abs(bearingDeg) <= 45,
  };
}

function invalidResult(validMask) {
  return {
    valid: false,
    xMm: null,
    yMm: null,
    positionRadiusMm: null,
    boundaryDistanceMm: null,
    radialMm: null,
    bearingDeg: null,
    residual: null,
    residualMm: null,
    residualsMm: {},
    quality: 0,
    mode: "invalid",
    validMask,
    usedAnchorIds: [],
    iterations: 0,
    withinBearingRange: false,
  };
}

function observationWeight(range) {
  if (Number.isFinite(Number(range.weight))) {
    return clamp(Number(range.weight), 0.05, 20);
  }
  if (Number.isFinite(Number(range.snrDb))) {
    return clamp(10 ** (Number(range.snrDb) / 20), 0.25, 4);
  }
  return 1;
}

function robustCost(residuals, delta) {
  return residuals.reduce((total, residual) => {
    const absolute = Math.abs(residual);
    return (
      total +
      (absolute <= delta
        ? 0.5 * residual * residual
        : delta * (absolute - 0.5 * delta))
    );
  }, 0);
}

function rootMeanSquare(values) {
  return Math.sqrt(
    values.reduce((total, value) => total + value * value, 0) /
      Math.max(1, values.length),
  );
}
