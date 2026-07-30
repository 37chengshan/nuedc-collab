import test from "node:test";
import assert from "node:assert/strict";

import {
  LOCALIZATION_MODES,
  LOCK_STATES,
  createDeterministicPrng,
  createDigitalKeySimulator,
  runFixedSeedEntryScenario,
} from "../../src/domain/index.mjs";

test("固定种子 PRNG 可重复，且不同种子产生不同序列", () => {
  const sequence = (seed) => {
    const prng = createDeterministicPrng(seed);
    return Array.from({ length: 8 }, () => prng.next());
  };

  assert.deepEqual(sequence(20260730), sequence(20260730));
  assert.notDeepEqual(sequence(20260730), sequence(20260731));
});

test("PRNG 支持字符串种子并拒绝负标准差", () => {
  const first = createDeterministicPrng("digital-key");
  const second = createDeterministicPrng("digital-key");

  assert.equal(first.next(), second.next());
  assert.ok(Number.isFinite(first.normal(10, 2)));
  assert.throws(() => first.normal(0, -1), /non-negative/);
});

test("仿真快照同时保留 truth、measurement、estimate", () => {
  const simulator = createDigitalKeySimulator({
    seed: 7,
    expectedId: 3,
  });
  const snapshot = simulator.step({
    timeMs: 100,
    active: true,
    keyAddress: 0x1113,
    xMm: 0,
    yMm: 1200,
  });

  assert.deepEqual(Object.keys(snapshot).sort(), [
    "estimate",
    "measurement",
    "truth",
  ]);
  assert.equal(snapshot.truth.radialMm, 900);
  assert.equal(snapshot.measurement.channels.length, 3);
  assert.ok(
    snapshot.measurement.channels.every(
      (channel) =>
        channel.valid &&
        channel.measuredDistanceMm === channel.trueDistanceMm,
    ),
  );
  assert.equal(
    snapshot.estimate.position.mode,
    LOCALIZATION_MODES.THREE_ANCHOR,
  );
  assert.equal(snapshot.estimate.lock.state, LOCK_STATES.UNLOCKED);
});

test("钥匙未激活时没有有效测量，且仿真时间不可倒退", () => {
  const simulator = createDigitalKeySimulator({
    seed: 7,
    expectedId: 3,
  });
  const snapshot = simulator.step({
    timeMs: 100,
    active: false,
    keyAddress: 0x1113,
    xMm: 0,
    yMm: 1200,
  });

  assert.ok(
    snapshot.measurement.channels.every(
      (channel) => !channel.valid && channel.fault === "inactive",
    ),
  );
  assert.equal(snapshot.estimate.position.mode, LOCALIZATION_MODES.NONE);
  assert.throws(
    () =>
      simulator.step({
        timeMs: 99,
        active: true,
        keyAddress: 0x1113,
        xMm: 0,
        yMm: 1200,
      }),
    /monotonic/,
  );
});

test("测量噪声、偏置和丢包由固定种子稳定复现", () => {
  const run = (seed) => {
    const simulator = createDigitalKeySimulator({
      seed,
      expectedId: 3,
      faults: {
        distanceNoiseStdDevMm: 25,
        distanceBiasMm: [40, -20, 0],
        dropoutProbability: [0.35, 0.35, 0.35],
      },
    });
    return Array.from({ length: 12 }, (_, index) =>
      simulator.step({
        timeMs: index * 50,
        active: true,
        keyAddress: 0x1113,
        xMm: 100,
        yMm: 1600,
      }),
    ).map((snapshot) => snapshot.measurement.channels);
  };

  assert.deepEqual(run(1234), run(1234));
  assert.notDeepEqual(run(1234), run(5678));
});

test("单锚点故障触发两锚点降级，并且安全锁保持关闭", () => {
  const simulator = createDigitalKeySimulator({
    seed: 9,
    expectedId: 3,
    faults: {
      disabledAnchors: [2],
    },
  });
  const snapshot = simulator.step({
    timeMs: 100,
    active: true,
    keyAddress: 0x1113,
    xMm: 0,
    yMm: 1200,
  });

  assert.equal(snapshot.measurement.channels[2].valid, false);
  assert.equal(snapshot.measurement.channels[2].fault, "disabled");
  assert.equal(
    snapshot.estimate.position.mode,
    LOCALIZATION_MODES.TWO_ANCHOR,
  );
  assert.equal(snapshot.estimate.lock.authorized, false);
  assert.equal(snapshot.estimate.lock.state, LOCK_STATES.LOCKED);
});

test("固定种子进入场景可重复经过锁定、迎宾和开锁", () => {
  const first = runFixedSeedEntryScenario({
    seed: 20260730,
    keyAddress: 0x1113,
    expectedId: 3,
    distanceNoiseStdDevMm: 1,
  });
  const second = runFixedSeedEntryScenario({
    seed: 20260730,
    keyAddress: 0x1113,
    expectedId: 3,
    distanceNoiseStdDevMm: 1,
  });

  assert.deepEqual(first, second);
  assert.deepEqual(
    first.summary.lockStateTimeline.map((entry) => entry.state),
    [LOCK_STATES.LOCKED, LOCK_STATES.WELCOME, LOCK_STATES.UNLOCKED],
  );
  assert.ok(first.samples.length > 10);
  assert.ok(first.summary.maxRadialErrorMm < 30);
  assert.ok(first.summary.maxBearingErrorDeg < 2);
});
