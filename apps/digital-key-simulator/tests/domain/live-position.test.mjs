import assert from "node:assert/strict";
import test from "node:test";

import { createFittedPositionFrame } from "../../src/domain/live-position.mjs";

test("最终距离和角度直接转换为页面坐标，不重新使用原始测距定位", () => {
  const frame = createFittedPositionFrame({
    valid: true,
    distanceM: 1.2,
    angleValid: true,
    angleDeg: 30,
    angleConfidence: 0.82,
    quality: "good",
    source: "final-captures",
    sampleCount: 18,
    usedAnchors: ["A1", "A2"],
  });

  assert.equal(frame.valid, true);
  assert.equal(frame.positionMode, "fitted-2d");
  assert.ok(Math.abs(frame.xM - 0.6) < 1e-9);
  assert.ok(Math.abs(frame.yM - 1.0392304845413265) < 1e-9);
  assert.equal(frame.confidencePercent, 82);
  assert.deepEqual(frame.usedAnchors, ["A1", "A2"]);
});

test("只有拟合距离时标记为方向不确定，不伪造精确横向坐标", () => {
  const frame = createFittedPositionFrame({
    valid: true,
    distanceMm: 900,
    angleValid: false,
    angleDeg: null,
    quality: "degraded",
    source: "final-captures",
  });

  assert.equal(frame.valid, true);
  assert.equal(frame.positionMode, "range-only");
  assert.equal(frame.xM, null);
  assert.equal(frame.yM, null);
  assert.equal(frame.plotX, 0);
  assert.equal(frame.plotY, 0.9);
  assert.equal(frame.confidencePercent, 0);
});

test("无效或缺失的拟合距离不会生成页面位置", () => {
  const frame = createFittedPositionFrame({
    valid: false,
    reason: "有效基站不足",
    distanceM: null,
  });

  assert.equal(frame.valid, false);
  assert.equal(frame.positionMode, "unavailable");
  assert.equal(frame.plotX, null);
  assert.equal(frame.plotY, null);
  assert.equal(frame.reason, "有效基站不足");
});
