import {
  BOUNDARY_TOLERANCE,
  LOCALIZATION_MODES,
  LOCK_STATES,
  LOCK_ZONES,
} from "./config.mjs";

export function derivePositionMetrics(point, config) {
  const radiusFromOriginMm = Math.hypot(point.xMm, point.yMm);
  return {
    radiusFromOriginMm,
    radialMm: Math.max(0, radiusFromOriginMm - config.radialZeroOffsetMm),
    bearingDeg: Math.atan2(point.xMm, point.yMm) * (180 / Math.PI),
  };
}

export function classifyZone(position, config) {
  if (!position?.valid) {
    return LOCK_ZONES.INVALID;
  }
  if (
    Math.abs(position.bearingDeg) >
    config.accessBearingLimitDeg + BOUNDARY_TOLERANCE
  ) {
    return LOCK_ZONES.BACKSIDE;
  }
  if (
    position.radialMm <=
    config.unlockRadiusMm + BOUNDARY_TOLERANCE
  ) {
    return LOCK_ZONES.UNLOCK;
  }
  if (
    position.radialMm <=
    config.welcomeRadiusMm + BOUNDARY_TOLERANCE
  ) {
    return LOCK_ZONES.APPROACH;
  }
  return LOCK_ZONES.OUTSIDE;
}

export function createLockFsm() {
  return {
    state: LOCK_STATES.LOCKED,
    deniedHoldUntilMs: 0,
  };
}

export function updateLockFsm(
  stateMachine,
  position,
  expectedId,
  config,
  nowMs,
) {
  const zone = classifyZone(position, config);
  const trustedPosition =
    Boolean(position?.valid) &&
    position.mode === LOCALIZATION_MODES.THREE_ANCHOR &&
    position.anchorCount === 3;
  const observedId = position?.keyAddress === null
    ? null
    : (position?.keyAddress ?? position?.keyId ?? 0) & 0x0f;
  const authorized =
    trustedPosition && observedId === (expectedId & 0x0f);

  if (authorized && zone === LOCK_ZONES.UNLOCK) {
    stateMachine.state = LOCK_STATES.UNLOCKED;
  } else if (
    trustedPosition &&
    !authorized &&
    zone === LOCK_ZONES.UNLOCK
  ) {
    stateMachine.state = LOCK_STATES.DENIED;
    stateMachine.deniedHoldUntilMs = nowMs + config.deniedHoldMs;
  } else if (authorized && zone === LOCK_ZONES.APPROACH) {
    stateMachine.state = LOCK_STATES.WELCOME;
  } else if (nowMs < stateMachine.deniedHoldUntilMs) {
    stateMachine.state = LOCK_STATES.DENIED;
  } else {
    stateMachine.state = LOCK_STATES.LOCKED;
  }

  const unlockOutput = stateMachine.state === LOCK_STATES.UNLOCKED;
  return {
    zone,
    state: stateMachine.state,
    observedId,
    trustedPosition,
    authorized,
    unlockOutput,
    welcomeOutput:
      stateMachine.state === LOCK_STATES.WELCOME || unlockOutput,
    greenLed: unlockOutput,
    redLed:
      stateMachine.state === LOCK_STATES.LOCKED ||
      stateMachine.state === LOCK_STATES.DENIED,
    buzzerAlarm: stateMachine.state === LOCK_STATES.DENIED,
  };
}
