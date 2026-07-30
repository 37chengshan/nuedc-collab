export const LOCALIZATION_MODES = Object.freeze({
  NONE: "none",
  HOLD: "hold",
  TWO_ANCHOR: "two-anchor",
  THREE_ANCHOR: "three-anchor",
});

export const LOCK_ZONES = Object.freeze({
  INVALID: "invalid",
  OUTSIDE: "outside",
  APPROACH: "approach",
  UNLOCK: "unlock",
  BACKSIDE: "backside",
});

export const LOCK_STATES = Object.freeze({
  LOCKED: "locked",
  WELCOME: "welcome",
  UNLOCKED: "unlocked",
  DENIED: "denied",
});

export const BOUNDARY_TOLERANCE = 1e-6;

export const DEFAULT_CONFIG = Object.freeze({
  anchors: Object.freeze([
    Object.freeze({ id: "A1", xMm: -180, yMm: 220 }),
    Object.freeze({ id: "A2", xMm: 180, yMm: 220 }),
    Object.freeze({ id: "A3", xMm: 0, yMm: -220 }),
  ]),
  radialZeroOffsetMm: 300,
  welcomeRadiusMm: 2000,
  unlockRadiusMm: 1000,
  accessBearingLimitDeg: 45,
  sampleWindowMs: 120,
  solutionHoldMs: 500,
  deniedHoldMs: 700,
});

export function mergeConfig(overrides = {}) {
  const anchors = overrides.anchors ?? DEFAULT_CONFIG.anchors;
  if (!Array.isArray(anchors) || anchors.length !== 3) {
    throw new RangeError("config requires exactly three anchors");
  }

  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    anchors: anchors.map((anchor, index) => ({
      id: anchor.id ?? `A${index + 1}`,
      xMm: finiteNumber(anchor.xMm, `anchors[${index}].xMm`),
      yMm: finiteNumber(anchor.yMm, `anchors[${index}].yMm`),
    })),
  };
}

function finiteNumber(value, name) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be finite`);
  }
  return value;
}
