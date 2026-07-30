import { LOCALIZATION_MODES } from "./config.mjs";
import { derivePositionMetrics } from "./security.mjs";
import { solveThreeAnchors, solveTwoAnchors } from "./geometry.mjs";

export function createLocalizationTracker() {
  return {
    channels: [null, null, null],
    lastSolution: emptyPosition(),
  };
}

export function ingestMeasurement(tracker, channel, measurement) {
  if (!Number.isInteger(channel) || channel < 0 || channel >= 3) {
    return false;
  }
  if (!measurement?.valid) {
    return false;
  }

  tracker.channels[channel] = {
    ...measurement,
    channel,
    keyId: measurement.keyAddress & 0x0f,
  };
  return true;
}

export function estimatePosition(tracker, config, nowMs) {
  const fresh = tracker.channels
    .map((measurement, channel) => ({ measurement, channel }))
    .filter(({ measurement }) =>
      isFresh(measurement, nowMs, config.sampleWindowMs),
    );

  if (fresh.length === 0) {
    return emptyPosition();
  }

  const newest = fresh.reduce((latest, candidate) =>
    candidate.measurement.timestampMs > latest.measurement.timestampMs
      ? candidate
      : latest,
  );
  const matching = fresh.filter(
    ({ measurement }) =>
      measurement.keyAddress === newest.measurement.keyAddress,
  );
  const validMask = matching.reduce(
    (mask, { channel }) => mask | (1 << channel),
    0,
  );

  if (matching.length === 1) {
    const canHold =
      tracker.lastSolution.valid &&
      tracker.lastSolution.keyAddress === newest.measurement.keyAddress &&
      nowMs - tracker.lastSolution.updatedMs <= config.solutionHoldMs;
    if (!canHold) {
      return emptyPosition();
    }

    const held = {
      ...tracker.lastSolution,
      anchorCount: 1,
      validMask,
      updatedMs: nowMs,
      mode: LOCALIZATION_MODES.HOLD,
    };
    tracker.lastSolution = { ...held };
    return held;
  }

  const anchors = matching.map(({ channel }) => config.anchors[channel]);
  const distancesMm = matching.map(
    ({ measurement }) => measurement.distanceMm,
  );
  let result;
  let mode;

  if (matching.length >= 3) {
    result = solveThreeAnchors(anchors, distancesMm);
    mode = LOCALIZATION_MODES.THREE_ANCHOR;
  } else {
    const hint =
      tracker.lastSolution.valid &&
      tracker.lastSolution.keyAddress === newest.measurement.keyAddress
        ? {
            xMm: tracker.lastSolution.xMm,
            yMm: tracker.lastSolution.yMm,
          }
        : null;
    result = solveTwoAnchors(anchors, distancesMm, hint);
    mode = LOCALIZATION_MODES.TWO_ANCHOR;
  }

  if (!result.valid) {
    return emptyPosition();
  }

  const metrics = derivePositionMetrics(result.point, config);
  const solution = {
    valid: true,
    keyAddress: newest.measurement.keyAddress,
    keyId: newest.measurement.keyAddress & 0x0f,
    anchorCount: matching.length,
    validMask,
    updatedMs: nowMs,
    xMm: result.point.xMm,
    yMm: result.point.yMm,
    radiusFromOriginMm: metrics.radiusFromOriginMm,
    radialMm: metrics.radialMm,
    bearingDeg: metrics.bearingDeg,
    residualMm: result.residualMm,
    mode,
  };
  tracker.lastSolution = { ...solution };
  return solution;
}

export function emptyPosition() {
  return {
    valid: false,
    keyAddress: null,
    keyId: null,
    anchorCount: 0,
    validMask: 0,
    updatedMs: null,
    xMm: null,
    yMm: null,
    radiusFromOriginMm: null,
    radialMm: null,
    bearingDeg: null,
    residualMm: null,
    mode: LOCALIZATION_MODES.NONE,
  };
}

function isFresh(measurement, nowMs, windowMs) {
  if (!measurement?.valid) {
    return false;
  }
  const ageMs = nowMs - measurement.timestampMs;
  return ageMs >= 0 && ageMs <= windowMs;
}
