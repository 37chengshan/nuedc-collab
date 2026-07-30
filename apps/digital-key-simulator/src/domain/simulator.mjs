import { mergeConfig } from "./config.mjs";
import { distanceBetween } from "./geometry.mjs";
import {
  createLocalizationTracker,
  estimatePosition,
  ingestMeasurement,
} from "./localization.mjs";
import { createDeterministicPrng } from "./prng.mjs";
import {
  classifyZone,
  createLockFsm,
  derivePositionMetrics,
  updateLockFsm,
} from "./security.mjs";

const CHANNEL_COUNT = 3;

export function createDigitalKeySimulator(options = {}) {
  const config = mergeConfig(options.config);
  const expectedId = normalizeId(options.expectedId ?? 0);
  const faults = normalizeFaults(options.faults);
  const prng = createDeterministicPrng(options.seed ?? 1);
  const tracker = createLocalizationTracker();
  const lockFsm = createLockFsm();
  let lastTimeMs = Number.NEGATIVE_INFINITY;

  return {
    config,
    expectedId,
    step(input) {
      const truth = normalizeTruth(input, config);
      if (truth.timeMs < lastTimeMs) {
        throw new RangeError("simulation time must be monotonic");
      }
      lastTimeMs = truth.timeMs;

      const channels = config.anchors.map((anchor, channel) =>
        simulateChannel({
          anchor,
          channel,
          truth,
          faults,
          prng,
        }),
      );
      for (const channel of channels) {
        if (channel.valid) {
          ingestMeasurement(tracker, channel.channel, {
            valid: true,
            keyAddress: channel.keyAddress,
            distanceMm: channel.distanceMm,
            timestampMs: channel.timestampMs,
          });
        }
      }

      const position = estimatePosition(tracker, config, truth.timeMs);
      const zone = classifyZone(position, config);
      const lock = updateLockFsm(
        lockFsm,
        position,
        expectedId,
        config,
        truth.timeMs,
      );

      return {
        truth,
        measurement: {
          timeMs: truth.timeMs,
          channels,
        },
        estimate: {
          position,
          zone,
          lock,
        },
      };
    },
  };
}

function simulateChannel({ anchor, channel, truth, faults, prng }) {
  const trueDistanceMm = distanceBetween(anchor, truth);
  const base = {
    channel,
    anchorId: anchor.id,
    valid: false,
    keyAddress: truth.keyAddress,
    keyId: truth.keyId,
    trueDistanceMm,
    measuredDistanceMm: null,
    distanceMm: null,
    distanceBiasMm: faults.distanceBiasMm[channel],
    noiseMm: 0,
    timestampMs: truth.timeMs,
    fault: null,
  };

  if (!truth.active) {
    return { ...base, fault: "inactive" };
  }
  if (faults.disabledAnchors.has(channel)) {
    return { ...base, fault: "disabled" };
  }
  if (prng.next() < faults.dropoutProbability[channel]) {
    return { ...base, fault: "dropout" };
  }

  const noiseMm = prng.normal(
    0,
    faults.distanceNoiseStdDevMm[channel],
  );
  const measuredDistanceMm = Math.max(
    0,
    trueDistanceMm + faults.distanceBiasMm[channel] + noiseMm,
  );
  return {
    ...base,
    valid: true,
    measuredDistanceMm,
    distanceMm: measuredDistanceMm,
    noiseMm,
  };
}

function normalizeTruth(input, config) {
  if (!input || !Number.isFinite(input.timeMs)) {
    throw new TypeError("truth.timeMs must be finite");
  }
  if (!Number.isFinite(input.xMm) || !Number.isFinite(input.yMm)) {
    throw new TypeError("truth.xMm and truth.yMm must be finite");
  }

  const keyAddress = normalizeAddress(input.keyAddress ?? 0);
  const metrics = derivePositionMetrics(input, config);
  return {
    timeMs: input.timeMs,
    active: input.active !== false,
    keyAddress,
    keyId: keyAddress & 0x0f,
    xMm: input.xMm,
    yMm: input.yMm,
    radiusFromOriginMm: metrics.radiusFromOriginMm,
    radialMm: metrics.radialMm,
    bearingDeg: metrics.bearingDeg,
  };
}

function normalizeFaults(input = {}) {
  return {
    distanceNoiseStdDevMm: numericVector(
      input.distanceNoiseStdDevMm,
      0,
      "distanceNoiseStdDevMm",
      0,
    ),
    distanceBiasMm: numericVector(
      input.distanceBiasMm,
      0,
      "distanceBiasMm",
    ),
    dropoutProbability: numericVector(
      input.dropoutProbability,
      0,
      "dropoutProbability",
      0,
      1,
    ),
    disabledAnchors: new Set(input.disabledAnchors ?? []),
  };
}

function numericVector(value, fallback, name, minimum, maximum) {
  const source = Array.isArray(value)
    ? value
    : Array(CHANNEL_COUNT).fill(value ?? fallback);
  if (source.length !== CHANNEL_COUNT) {
    throw new RangeError(`${name} must contain exactly three values`);
  }
  return source.map((item, index) => {
    if (!Number.isFinite(item)) {
      throw new TypeError(`${name}[${index}] must be finite`);
    }
    if (minimum !== undefined && item < minimum) {
      throw new RangeError(`${name}[${index}] is below its minimum`);
    }
    if (maximum !== undefined && item > maximum) {
      throw new RangeError(`${name}[${index}] is above its maximum`);
    }
    return item;
  });
}

function normalizeAddress(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError("keyAddress must be a 16-bit integer");
  }
  return value;
}

function normalizeId(value) {
  if (!Number.isInteger(value)) {
    throw new TypeError("expectedId must be an integer");
  }
  return value & 0x0f;
}
