import { DEFAULT_CONFIG, LOCK_STATES } from "./config.mjs";
import { createDigitalKeySimulator } from "./simulator.mjs";

const ENTRY_WAYPOINTS = Object.freeze([
  Object.freeze({ timeMs: 0, radialMm: 3000 }),
  Object.freeze({ timeMs: 2000, radialMm: 1600 }),
  Object.freeze({ timeMs: 3500, radialMm: 800 }),
  Object.freeze({ timeMs: 5000, radialMm: 600 }),
]);

export function runFixedSeedEntryScenario(options = {}) {
  const seed = options.seed ?? 20260730;
  const keyAddress = options.keyAddress ?? 0x1113;
  const expectedId = options.expectedId ?? (keyAddress & 0x0f);
  const bearingDeg = options.bearingDeg ?? 0;
  const sampleIntervalMs = options.sampleIntervalMs ?? 250;
  const config = options.config ?? DEFAULT_CONFIG;
  const simulator = createDigitalKeySimulator({
    seed,
    keyAddress,
    expectedId,
    config,
    faults: {
      ...options.faults,
      distanceNoiseStdDevMm:
        options.distanceNoiseStdDevMm ??
        options.faults?.distanceNoiseStdDevMm ??
        0,
    },
  });
  const durationMs = ENTRY_WAYPOINTS.at(-1).timeMs;
  const samples = [];

  for (let timeMs = 0; timeMs <= durationMs; timeMs += sampleIntervalMs) {
    samples.push(
      simulator.step(
        truthAt({
          timeMs,
          keyAddress,
          bearingDeg,
          radialZeroOffsetMm: config.radialZeroOffsetMm,
        }),
      ),
    );
  }
  if (samples.at(-1)?.truth.timeMs !== durationMs) {
    samples.push(
      simulator.step(
        truthAt({
          timeMs: durationMs,
          keyAddress,
          bearingDeg,
          radialZeroOffsetMm: config.radialZeroOffsetMm,
        }),
      ),
    );
  }

  return {
    seed,
    samples,
    summary: summarize(samples),
  };
}

function truthAt({
  timeMs,
  keyAddress,
  bearingDeg,
  radialZeroOffsetMm,
}) {
  const radialMm = interpolateRadial(timeMs);
  const radiusFromOriginMm = radialMm + radialZeroOffsetMm;
  const radians = bearingDeg * (Math.PI / 180);
  return {
    timeMs,
    active: true,
    keyAddress,
    xMm: Math.sin(radians) * radiusFromOriginMm,
    yMm: Math.cos(radians) * radiusFromOriginMm,
  };
}

function interpolateRadial(timeMs) {
  for (let index = 1; index < ENTRY_WAYPOINTS.length; index += 1) {
    const current = ENTRY_WAYPOINTS[index];
    if (timeMs <= current.timeMs) {
      const previous = ENTRY_WAYPOINTS[index - 1];
      const progress =
        (timeMs - previous.timeMs) /
        (current.timeMs - previous.timeMs);
      return (
        previous.radialMm +
        (current.radialMm - previous.radialMm) * progress
      );
    }
  }
  return ENTRY_WAYPOINTS.at(-1).radialMm;
}

function summarize(samples) {
  const lockStateTimeline = [];
  let maxRadialErrorMm = 0;
  let maxBearingErrorDeg = 0;

  for (const sample of samples) {
    const state = sample.estimate.lock.state;
    if (lockStateTimeline.at(-1)?.state !== state) {
      lockStateTimeline.push({
        timeMs: sample.truth.timeMs,
        state,
      });
    }

    if (sample.estimate.position.valid) {
      maxRadialErrorMm = Math.max(
        maxRadialErrorMm,
        Math.abs(
          sample.estimate.position.radialMm - sample.truth.radialMm,
        ),
      );
      maxBearingErrorDeg = Math.max(
        maxBearingErrorDeg,
        angularDistance(
          sample.estimate.position.bearingDeg,
          sample.truth.bearingDeg,
        ),
      );
    }
  }

  return {
    sampleCount: samples.length,
    lockStateTimeline,
    maxRadialErrorMm,
    maxBearingErrorDeg,
    unlockedAtLeastOnce: samples.some(
      (sample) => sample.estimate.lock.state === LOCK_STATES.UNLOCKED,
    ),
  };
}

function angularDistance(left, right) {
  const difference = ((left - right + 180) % 360 + 360) % 360 - 180;
  return Math.abs(difference);
}
