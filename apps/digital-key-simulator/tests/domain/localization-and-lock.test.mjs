import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CONFIG,
  LOCALIZATION_MODES,
  LOCK_STATES,
  LOCK_ZONES,
  classifyZone,
  createLocalizationTracker,
  createLockFsm,
  derivePositionMetrics,
  distanceBetween,
  estimatePosition,
  ingestMeasurement,
  mergeConfig,
  solveThreeAnchors,
  solveTwoAnchors,
  updateLockFsm,
} from "../../src/domain/index.mjs";

function near(actual, expected, tolerance = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

function measurement(channel, point, timestampMs, keyAddress = 0x1113) {
  return {
    valid: true,
    channel,
    keyAddress,
    distanceMm: distanceBetween(DEFAULT_CONFIG.anchors[channel], point),
    timestampMs,
  };
}

test("默认锚点和安全阈值匹配 lock_app_config.c", () => {
  assert.deepEqual(DEFAULT_CONFIG.anchors, [
    { id: "A1", xMm: -180, yMm: 220 },
    { id: "A2", xMm: 180, yMm: 220 },
    { id: "A3", xMm: 0, yMm: -220 },
  ]);
  assert.deepEqual(
    {
      radialZeroOffsetMm: DEFAULT_CONFIG.radialZeroOffsetMm,
      welcomeRadiusMm: DEFAULT_CONFIG.welcomeRadiusMm,
      unlockRadiusMm: DEFAULT_CONFIG.unlockRadiusMm,
      accessBearingLimitDeg: DEFAULT_CONFIG.accessBearingLimitDeg,
      sampleWindowMs: DEFAULT_CONFIG.sampleWindowMs,
      solutionHoldMs: DEFAULT_CONFIG.solutionHoldMs,
      deniedHoldMs: DEFAULT_CONFIG.deniedHoldMs,
    },
    {
      radialZeroOffsetMm: 300,
      welcomeRadiusMm: 2000,
      unlockRadiusMm: 1000,
      accessBearingLimitDeg: 45,
      sampleWindowMs: 120,
      solutionHoldMs: 500,
      deniedHoldMs: 700,
    },
  );
});

test("三锚点定位还原二维真值并计算残差", () => {
  const truth = { xMm: 350, yMm: 1600 };
  const ranges = DEFAULT_CONFIG.anchors.map((anchor) =>
    distanceBetween(anchor, truth),
  );

  const result = solveThreeAnchors(DEFAULT_CONFIG.anchors, ranges);

  assert.equal(result.valid, true);
  near(result.point.xMm, truth.xMm);
  near(result.point.yMm, truth.yMm);
  near(result.residualMm, 0, 1e-9);
});

test("退化锚点几何和错误配置被安全拒绝", () => {
  assert.equal(
    solveThreeAnchors(
      [
        { xMm: 0, yMm: 0 },
        { xMm: 100, yMm: 0 },
        { xMm: 200, yMm: 0 },
      ],
      [100, 100, 100],
    ).valid,
    false,
  );
  assert.equal(
    solveTwoAnchors(
      [
        { xMm: 0, yMm: 0 },
        { xMm: 0, yMm: 0 },
      ],
      [100, 100],
    ).valid,
    false,
  );
  assert.throws(() => mergeConfig({ anchors: [] }), /exactly three/);
});

test("两锚点定位按历史提示选交点，无提示时选前方交点", () => {
  const anchors = DEFAULT_CONFIG.anchors.slice(0, 2);
  const front = { xMm: 0, yMm: 1300 };
  const back = { xMm: 0, yMm: -860 };
  const ranges = anchors.map((anchor) => distanceBetween(anchor, front));

  const defaultResult = solveTwoAnchors(anchors, ranges);
  const hintedResult = solveTwoAnchors(anchors, ranges, back);

  near(defaultResult.point.xMm, front.xMm);
  near(defaultResult.point.yMm, front.yMm);
  near(hintedResult.point.xMm, back.xMm);
  near(hintedResult.point.yMm, back.yMm);
});

test("定位依次执行三锚点、两锚点降级、一路保持和保持超时", () => {
  const tracker = createLocalizationTracker();
  const truth = { xMm: 0, yMm: 1300 };

  for (let channel = 0; channel < 3; channel += 1) {
    ingestMeasurement(
      tracker,
      channel,
      measurement(channel, truth, 100 + channel),
    );
  }

  const three = estimatePosition(tracker, DEFAULT_CONFIG, 102);
  assert.equal(three.mode, LOCALIZATION_MODES.THREE_ANCHOR);
  assert.equal(three.validMask, 0b111);

  const two = estimatePosition(tracker, DEFAULT_CONFIG, 221);
  assert.equal(two.valid, true);
  assert.equal(two.mode, LOCALIZATION_MODES.TWO_ANCHOR);
  assert.equal(two.anchorCount, 2);
  assert.equal(two.validMask, 0b110);

  const hold = estimatePosition(tracker, DEFAULT_CONFIG, 222);
  assert.equal(hold.valid, true);
  assert.equal(hold.mode, LOCALIZATION_MODES.HOLD);
  assert.equal(hold.anchorCount, 1);
  assert.equal(hold.validMask, 0b100);
  near(hold.xMm, two.xMm);
  near(hold.yMm, two.yMm);

  const expired = estimatePosition(tracker, DEFAULT_CONFIG, 723);
  assert.equal(expired.valid, false);
  assert.equal(expired.mode, LOCALIZATION_MODES.NONE);
});

test("不同完整地址和过期测量不会被混合定位", () => {
  const tracker = createLocalizationTracker();
  const truth = { xMm: 0, yMm: 1300 };

  ingestMeasurement(tracker, 0, measurement(0, truth, 100, 0x1113));
  ingestMeasurement(tracker, 1, measurement(1, truth, 101, 0x1113));
  ingestMeasurement(tracker, 2, measurement(2, truth, 102, 0x2223));
  assert.equal(estimatePosition(tracker, DEFAULT_CONFIG, 102).valid, false);

  ingestMeasurement(tracker, 2, measurement(2, truth, 102, 0x1113));
  assert.equal(estimatePosition(tracker, DEFAULT_CONFIG, 223).valid, false);
});

test("径向零点和方位角使用 atan2(x, y)", () => {
  const forward = derivePositionMetrics(
    { xMm: 0, yMm: 1300 },
    DEFAULT_CONFIG,
  );
  const right = derivePositionMetrics(
    { xMm: 1300, yMm: 1300 },
    DEFAULT_CONFIG,
  );
  const left = derivePositionMetrics(
    { xMm: -1300, yMm: 1300 },
    DEFAULT_CONFIG,
  );

  near(forward.radialMm, 1000);
  near(forward.bearingDeg, 0);
  near(right.bearingDeg, 45);
  near(left.bearingDeg, -45);
});

test("区域边界吸收浮点误差，但不会吞掉真实越界", () => {
  const position = (radialMm, bearingDeg) => ({
    valid: true,
    radialMm,
    bearingDeg,
  });

  assert.equal(
    classifyZone(position(1000 + 1e-7, 45 + 1e-7), DEFAULT_CONFIG),
    LOCK_ZONES.UNLOCK,
  );
  assert.equal(
    classifyZone(position(1000.01, 0), DEFAULT_CONFIG),
    LOCK_ZONES.APPROACH,
  );
  assert.equal(
    classifyZone(position(2000 + 1e-7, 0), DEFAULT_CONFIG),
    LOCK_ZONES.APPROACH,
  );
  assert.equal(
    classifyZone(position(2000.01, 0), DEFAULT_CONFIG),
    LOCK_ZONES.OUTSIDE,
  );
  assert.equal(
    classifyZone(position(800, 45.01), DEFAULT_CONFIG),
    LOCK_ZONES.BACKSIDE,
  );
});

test("安全锁 FSM 仅信任三锚点定位，并保持非法 ID 告警 700 ms", () => {
  const fsm = createLockFsm();
  const position = ({
    keyAddress = 0x1113,
    radialMm,
    mode = LOCALIZATION_MODES.THREE_ANCHOR,
    anchorCount = 3,
    valid = true,
  }) => ({
    valid,
    keyAddress,
    keyId: keyAddress & 0x0f,
    radialMm,
    bearingDeg: 0,
    mode,
    anchorCount,
  });

  const welcome = updateLockFsm(
    fsm,
    position({ radialMm: 1500 }),
    3,
    DEFAULT_CONFIG,
    100,
  );
  assert.equal(welcome.state, LOCK_STATES.WELCOME);

  const unlocked = updateLockFsm(
    fsm,
    position({ radialMm: 800 }),
    3,
    DEFAULT_CONFIG,
    200,
  );
  assert.equal(unlocked.authorized, true);
  assert.equal(unlocked.state, LOCK_STATES.UNLOCKED);
  assert.equal(unlocked.greenLed, true);

  const degraded = updateLockFsm(
    fsm,
    position({
      radialMm: 800,
      mode: LOCALIZATION_MODES.TWO_ANCHOR,
      anchorCount: 2,
    }),
    3,
    DEFAULT_CONFIG,
    250,
  );
  assert.equal(degraded.authorized, false);
  assert.equal(degraded.state, LOCK_STATES.LOCKED);

  const denied = updateLockFsm(
    fsm,
    position({ keyAddress: 0x1114, radialMm: 800 }),
    3,
    DEFAULT_CONFIG,
    300,
  );
  assert.equal(denied.state, LOCK_STATES.DENIED);
  assert.equal(denied.redLed, true);
  assert.equal(denied.buzzerAlarm, true);

  const held = updateLockFsm(
    fsm,
    position({ radialMm: 0, valid: false }),
    3,
    DEFAULT_CONFIG,
    999,
  );
  assert.equal(held.state, LOCK_STATES.DENIED);

  const released = updateLockFsm(
    fsm,
    position({ radialMm: 0, valid: false }),
    3,
    DEFAULT_CONFIG,
    1000,
  );
  assert.equal(released.state, LOCK_STATES.LOCKED);
});
