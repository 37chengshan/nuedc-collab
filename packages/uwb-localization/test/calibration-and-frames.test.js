import test from "node:test";
import assert from "node:assert/strict";

import {
  CALIBRATION_ANGLES_DEG,
  CALIBRATION_RADII_MM,
  buildAnchorCalibrationSamples,
  createCalibrationPlan,
  groupFramesByWindow,
  hampelFilter,
  normalizeReplayFrame,
  replayFrameSession,
  summarizeFrameGroups,
  synchronizeFrames,
  validateAnchorConfig,
} from "../src/index.js";

test("77 点标定计划覆盖 11 个径向和 7 个角度", () => {
  assert.deepEqual(CALIBRATION_RADII_MM, [
    500, 800, 950, 1000, 1050, 1500, 1950, 2000, 2050, 2500, 3000,
  ]);
  assert.deepEqual(CALIBRATION_ANGLES_DEG, [-45, -30, -15, 0, 15, 30, 45]);

  const plan = createCalibrationPlan();
  assert.equal(plan.length, 77);
  assert.equal(new Set(plan.map((point) => point.pointId)).size, 77);
  assert.deepEqual(plan[0], {
    pointId: "R0500_A-45",
    boundaryDistanceMm: 500,
    positionRadiusMm: 800,
    angleDeg: -45,
    xMm: -565.685,
    yMm: 565.685,
  });
  assert.deepEqual(plan.at(-1), {
    pointId: "R3000_A+45",
    boundaryDistanceMm: 3000,
    positionRadiusMm: 3300,
    angleDeg: 45,
    xMm: 2333.452,
    yMm: 2333.452,
  });
});

test("标定计划允许覆盖径向零点", () => {
  const [point] = createCalibrationPlan({ radialZeroOffsetMm: 0 });
  assert.equal(Math.hypot(point.xMm, point.yMm), 500);
  assert.equal(point.boundaryDistanceMm, 500);
  assert.equal(point.positionRadiusMm, 500);
});

test("训练真值把 0.5 m 解释为边界距离，并加 300 mm 后计算锚点真实距离", () => {
  const [sample] = buildAnchorCalibrationSamples(
    [
      {
        pointId: "R0500_A+00",
        boundaryDistanceMm: 500,
        angleDeg: 0,
        anchorId: "A1",
        measuredMm: 772,
      },
    ],
    {
      anchors: [{ id: "A1", xMm: -125, yMm: 40 }],
      radialZeroOffsetMm: 300,
    },
  );

  assert.equal(sample.positionRadiusMm, 800);
  assert.equal(sample.xMm, 0);
  assert.equal(sample.yMm, 800);
  assert.ok(Math.abs(sample.trueMm - Math.hypot(125, 760)) < 1e-9);
});

test("默认锚点配置为两基站并带 300 mm 径向零点", () => {
  const config = validateAnchorConfig();
  assert.deepEqual(config, {
    anchors: [
      { id: "A1", xMm: -125, yMm: 40 },
      { id: "A2", xMm: 125, yMm: 40 },
    ],
    radialZeroOffsetMm: 300,
  });
});

test("锚点配置只接受 2 到 4 个不同坐标的基站", () => {
  assert.throws(
    () => validateAnchorConfig({ anchors: [{ id: "A1", xMm: 0, yMm: 0 }] }),
    /2.*4/,
  );
  assert.throws(
    () =>
      validateAnchorConfig({
        anchors: Array.from({ length: 5 }, (_, index) => ({
          id: `A${index}`,
          xMm: index,
          yMm: index * 2,
        })),
      }),
    /2.*4/,
  );
  assert.throws(
    () =>
      validateAnchorConfig({
        anchors: [
          { id: "A1", xMm: 0, yMm: 0 },
          { id: "A1", xMm: 10, yMm: 0 },
        ],
      }),
    /id/i,
  );
  assert.throws(
    () =>
      validateAnchorConfig({
        anchors: [
          { id: "A1", xMm: 0, yMm: 0 },
          { id: "A2", xMm: 0, yMm: 0 },
        ],
      }),
    /坐标/,
  );
});

test("帧按 120 ms 窗口、完整地址和设备分组", () => {
  const groups = groupFramesByWindow([
    frame(119, "KEY-A", "uart-1", "A2", 1002),
    frame(0, "KEY-A", "uart-1", "A1", 1000),
    frame(50, "KEY-B", "uart-1", "A1", 900),
    frame(121, "KEY-A", "uart-1", "A1", 1001),
    frame(30, "KEY-A", "uart-1", "A2", 999),
    frame(60, "KEY-A", "uart-2", "A1", 1100),
  ]);

  assert.equal(groups.length, 4);
  const first = groups.find(
    (group) =>
      group.address === "KEY-A" &&
      group.deviceId === "uart-1" &&
      group.startMs === 0,
  );
  assert.equal(first.frames.length, 3);
  assert.equal(first.endMs, 119);
  assert.deepEqual(
    first.frames.map((item) => item.timestampMs),
    [0, 30, 119],
  );
});

test("7 点 Hampel/MAD 会移除孤立 NLOS 跳变", () => {
  const result = hampelFilter(
    [1000, 999, 1001, 1000, 4500, 1002, 998, 1001, 1000],
    { windowSize: 7, threshold: 3 },
  );
  assert.equal(result.accepted.length, 8);
  assert.deepEqual(result.rejectedIndices, [4]);
});

test("预热丢弃、Hampel 清洗和末 5 点中位统计能拒绝不稳定锚点", () => {
  const frames = [];
  const stable = [300, 1000, 1001, 999, 1000, 4500, 1002, 998, 1001, 1000];
  const unstable = [200, 700, 1300, 650, 1400, 600, 1500, 550, 1600, 500];

  stable.forEach((distanceMm, index) => {
    frames.push(frame(index * 10, "KEY-A", "uart-1", "A1", distanceMm, 18 + index));
  });
  unstable.forEach((distanceMm, index) => {
    frames.push(frame(index * 10 + 1, "KEY-A", "uart-1", "A2", distanceMm, 5));
  });

  const [summary] = summarizeFrameGroups(frames, {
    expectedAnchorIds: ["A1", "A2", "A3"],
    warmupSamples: 1,
    stabilityMadMm: 30,
    minValidSamples: 5,
  });

  assert.equal(summary.address, "KEY-A");
  assert.equal(summary.deviceId, "uart-1");
  assert.equal(summary.anchors.A1.medianMm, 1000);
  assert.equal(summary.anchors.A1.madMm, 1);
  assert.equal(summary.anchors.A1.validCount, 5);
  assert.equal(summary.anchors.A1.stable, true);
  assert.equal(summary.anchors.A1.rejectedCount, 1);
  assert.equal(summary.anchors.A1.snrDb, 25);

  assert.equal(summary.anchors.A2.stable, false);
  assert.equal(summary.anchors.A2.accepted, false);
  assert.equal(summary.anchors.A3.missing, true);
  assert.deepEqual(summary.validMask, [true, false, false]);
});

test("丢帧不会把其他地址或设备的锚点拼进同一结果", () => {
  const summaries = summarizeFrameGroups(
    [
      frame(0, "KEY-A", "uart-1", "A1", 1000),
      frame(1, "KEY-A", "uart-2", "A2", 1000),
      frame(2, "KEY-B", "uart-1", "A3", 1000),
    ],
    {
      expectedAnchorIds: ["A1", "A2", "A3"],
      warmupSamples: 0,
      minValidSamples: 1,
    },
  );

  assert.equal(summaries.length, 3);
  assert.ok(summaries.every((summary) => summary.validMask.filter(Boolean).length === 1));
});

test("黄金会话原始 frame 字段可直接归一化为定位帧", () => {
  const normalized = normalizeReplayFrame({
    seq: 4,
    timestamp: "2026-07-30T17:49:11.661Z",
    elapsedMs: 24544,
    type: "frame",
    device: 1,
    linkIndex: 0,
    address: "0100",
    distanceCm: 105,
    snrDb: -6,
    raw: "P0,0100,105cm,-6dB",
  });

  assert.deepEqual(normalized, {
    seq: 4,
    timestampMs: Date.parse("2026-07-30T17:49:11.661Z"),
    elapsedMs: 24544,
    deviceId: 1,
    anchorId: "A1",
    address: "0100",
    keyId: 0,
    distanceMm: 1050,
    snrDb: -6,
    raw: "P0,0100,105cm,-6dB",
  });
});

test("120 ms 同步匹配中每个通道帧最多消费一次", () => {
  const synchronized = synchronizeFrames(
    [
      rawFrame(1, 0, 1, "0100", 100),
      rawFrame(2, 40, 2, "0100", 101),
      rawFrame(3, 100, 1, "0100", 102),
    ],
    {
      requiredDevices: [1, 2],
      windowMs: 120,
    },
  );

  assert.equal(synchronized.groups.length, 1);
  assert.equal(synchronized.groups[0].frames.length, 2);
  assert.equal(
    new Set(synchronized.groups[0].frames.map((item) => item.deviceId)).size,
    2,
  );
  assert.equal(synchronized.usedFrameCount, 2);
  assert.equal(synchronized.unpairedFrames.length, 1);
  assert.equal(
    new Set(synchronized.groups.flatMap((group) => group.frames.map((item) => item.seq)))
      .size,
    2,
  );
});

test("回放可按每通道 address 和 keyId 过滤", () => {
  const records = [
    rawFrame(1, 0, 1, "0100", 100),
    rawFrame(2, 20, 2, "0100", 101),
    rawFrame(3, 100, 1, "0103", 102),
    rawFrame(4, 120, 2, "0103", 103),
  ];
  const replay = replayFrameSession(
    records.map((record) => JSON.stringify(record)).join("\n"),
    {
      address: "0100",
      keyId: 0,
      requiredDevices: [1, 2],
      warmupMs: 0,
      minSynchronizedGroups: 1,
    },
  );

  assert.equal(replay.filteredFrameCount, 2);
  assert.equal(replay.synchronizedGroupCount, 1);
  assert.equal(replay.accepted, true);
  assert.deepEqual(
    replay.groups[0].frames.map((item) => item.address),
    ["0100", "0100"],
  );
});

test("15 秒 10 Hz 回放去前 2 秒后得到约 130 个一次性同步组并通过 100 组门槛", () => {
  const records = [];
  for (let index = 0; index < 150; index += 1) {
    records.push(rawFrame(index * 2 + 1, index * 100, 1, "0A00", 100));
    records.push(rawFrame(index * 2 + 2, index * 100 + 20, 2, "0A00", 101));
  }

  const replay = replayFrameSession(records, {
    address: "0A00",
    keyId: 0,
    requiredDevices: [1, 2],
    warmupMs: 2000,
    windowMs: 120,
    minSynchronizedGroups: 100,
  });

  assert.equal(replay.inputFrameCount, 300);
  assert.equal(replay.filteredFrameCount, 260);
  assert.equal(replay.synchronizedGroupCount, 130);
  assert.equal(replay.accepted, true);
  assert.equal(replay.usedFrameCount, 260);
});

test("同 keyId 但完整 address 不同的黄金会话帧全部可解析且不会误拼双路组", () => {
  const records = [
    ...Array.from({ length: 3778 }, (_, index) =>
      rawFrame(index + 1, index * 100, 1, "0100", 100),
    ),
    ...Array.from({ length: 4708 }, (_, index) =>
      rawFrame(index + 3779, index * 100 + 50, 2, "0200", 101),
    ),
  ];
  const replay = replayFrameSession(records, {
    keyId: 0,
    requiredDevices: [1, 2],
    warmupMs: 0,
    windowMs: 120,
    minSynchronizedGroups: 1,
  });

  assert.equal(replay.inputFrameCount, 8486);
  assert.equal(replay.parsedFrameCount, 8486);
  assert.equal(replay.filteredFrameCount, 8486);
  assert.equal(replay.synchronizedGroupCount, 3778);
  assert.equal(replay.usedFrameCount, 7556);
  assert.equal(replay.unpairedFrames.length, 930);
  assert.equal(replay.accepted, true);
});

function frame(timestampMs, address, deviceId, anchorId, distanceMm, snrDb) {
  return { timestampMs, address, deviceId, anchorId, distanceMm, snrDb };
}

function rawFrame(seq, elapsedMs, device, address, distanceCm) {
  return {
    seq,
    timestamp: new Date(Date.UTC(2026, 6, 30, 17, 0, 0, elapsedMs)).toISOString(),
    elapsedMs,
    type: "frame",
    device,
    linkIndex: device - 1,
    address,
    distanceCm,
    snrDb: 10,
    raw: `P${device - 1},${address},${distanceCm}cm,10dB`,
  };
}
