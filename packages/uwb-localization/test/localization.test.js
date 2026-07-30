import test from "node:test";
import assert from "node:assert/strict";

import { solvePosition } from "../src/index.js";

test("两锚点两圆交点优先选择门锁前方，消除镜像", () => {
  const anchors = [
    { id: "A1", xMm: -125, yMm: 40 },
    { id: "A2", xMm: 125, yMm: 40 },
  ];
  const target = { xMm: 100, yMm: 1000 };
  const result = solvePosition({
    anchors,
    ranges: rangesFor(anchors, target),
  });

  assert.equal(result.mode, "two-circle");
  assert.ok(Math.abs(result.xMm - target.xMm) < 1);
  assert.ok(Math.abs(result.yMm - target.yMm) < 1);
  assert.equal(result.positionRadiusMm, Math.hypot(100, 1000));
  assert.equal(result.boundaryDistanceMm, Math.hypot(100, 1000) - 300);
  assert.ok(Math.abs(result.bearingDeg - 5.710593) < 1e-5);
  assert.deepEqual(result.validMask, [true, true]);
});

test("定位输出明确区分圆心位置半径和圆柱外边界比赛距离", () => {
  const anchors = [
    { id: "A1", xMm: -125, yMm: 40 },
    { id: "A2", xMm: 125, yMm: 40 },
  ];
  const target = { xMm: 0, yMm: 800 };
  const result = solvePosition({
    anchors,
    ranges: rangesFor(anchors, target),
    radialZeroOffsetMm: 300,
  });

  assert.equal(result.positionRadiusMm, 800);
  assert.equal(result.boundaryDistanceMm, 500);
  assert.equal(result.bearingDeg, 0);
});

test("两圆交点都在前方时使用历史位置提示", () => {
  const anchors = [
    { id: "A1", xMm: -200, yMm: 500 },
    { id: "A2", xMm: 200, yMm: 500 },
  ];
  const target = { xMm: 0, yMm: 1000 };
  const result = solvePosition({
    anchors,
    ranges: rangesFor(anchors, target),
    history: { xMm: 20, yMm: 980 },
  });

  assert.ok(Math.abs(result.yMm - 1000) < 1);
});

test("三锚点用加权 Huber LM 定位并在毫米级收敛", () => {
  const anchors = triangleAnchors();
  const target = { xMm: 140, yMm: 1250 };
  const result = solvePosition({
    anchors,
    ranges: rangesFor(anchors, target),
  });

  assert.equal(result.mode, "lm");
  assert.ok(Math.hypot(result.xMm - target.xMm, result.yMm - target.yMm) < 1);
  assert.ok(result.iterations <= 5);
  assert.ok(result.residualMm < 1);
  assert.deepEqual(result.validMask, [true, true, true]);
});

test("三锚点丢一路时自动降为两圆定位", () => {
  const anchors = triangleAnchors();
  const target = { xMm: -80, yMm: 900 };
  const allRanges = rangesFor(anchors, target);
  const result = solvePosition({
    anchors,
    ranges: allRanges.slice(0, 2),
  });

  assert.equal(result.mode, "two-circle");
  assert.ok(Math.hypot(result.xMm - target.xMm, result.yMm - target.yMm) < 1);
  assert.deepEqual(result.validMask, [true, true, false]);
});

test("三锚点单路 NLOS 异常可借助历史位置降级为两路", () => {
  const anchors = triangleAnchors();
  const target = { xMm: 120, yMm: 1150 };
  const ranges = rangesFor(anchors, target);
  ranges[2].distanceMm += 550;

  const result = solvePosition({
    anchors,
    ranges,
    history: { xMm: 110, yMm: 1140 },
    residualThresholdMm: 120,
  });

  assert.equal(result.mode, "two-anchor-degraded");
  assert.ok(Math.hypot(result.xMm - target.xMm, result.yMm - target.yMm) < 20);
  assert.equal(result.validMask.filter(Boolean).length, 2);
  assert.ok(result.quality < 0.7);
});

test("四锚点正常数据统一走 LM 并使用全部锚点", () => {
  const anchors = squareAnchors();
  const target = { xMm: -170, yMm: 1350 };
  const result = solvePosition({
    anchors,
    ranges: rangesFor(anchors, target).map((range, index) => ({
      ...range,
      snrDb: 10 + index * 3,
    })),
  });

  assert.equal(result.mode, "lm");
  assert.ok(Math.hypot(result.xMm - target.xMm, result.yMm - target.yMm) < 1);
  assert.deepEqual(result.validMask, [true, true, true, true]);
});

test("四锚点单路 NLOS 通过 leave-one-out 剔除异常锚点", () => {
  const anchors = squareAnchors();
  const target = { xMm: 160, yMm: 1450 };
  const ranges = rangesFor(anchors, target);
  ranges[3].distanceMm += 650;

  const result = solvePosition({
    anchors,
    ranges,
    residualThresholdMm: 120,
  });

  assert.equal(result.mode, "lm-loo");
  assert.ok(Math.hypot(result.xMm - target.xMm, result.yMm - target.yMm) < 20);
  assert.deepEqual(result.validMask, [true, true, true, false]);
  assert.ok(result.residualMm < 20);
});

test("少于两路有效距离时返回安全无效结果", () => {
  const anchors = triangleAnchors();
  const result = solvePosition({
    anchors,
    ranges: [{ anchorId: "A1", distanceMm: 1000 }],
  });

  assert.equal(result.mode, "invalid");
  assert.equal(result.quality, 0);
  assert.equal(result.xMm, null);
  assert.equal(result.positionRadiusMm, null);
  assert.equal(result.boundaryDistanceMm, null);
  assert.deepEqual(result.validMask, [true, false, false]);
});

function rangesFor(anchors, point) {
  return anchors.map((anchor) => ({
    anchorId: anchor.id,
    distanceMm: Math.hypot(point.xMm - anchor.xMm, point.yMm - anchor.yMm),
  }));
}

function triangleAnchors() {
  return [
    { id: "A1", xMm: -300, yMm: 0 },
    { id: "A2", xMm: 300, yMm: 0 },
    { id: "A3", xMm: 0, yMm: -300 },
  ];
}

function squareAnchors() {
  return [
    { id: "A1", xMm: -300, yMm: 0 },
    { id: "A2", xMm: 300, yMm: 0 },
    { id: "A3", xMm: 0, yMm: -300 },
    { id: "A4", xMm: 0, yMm: 300 },
  ];
}
