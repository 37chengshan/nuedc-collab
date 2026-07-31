import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readApp = (path) => readFile(join(appRoot, path), "utf8");

test("工作台提供独立现场标定模式并只通过 Agent 命令访问业务", async () => {
  const [app, calibration] = await Promise.all([
    readApp("src/ui/App.tsx"),
    readApp("src/ui/CalibrationWorkbench.tsx"),
  ]);

  assert.match(app, /type WorkbenchMode = .*"calibration"/);
  assert.match(app, /\["calibration",\s*"现场标定"\]/);
  assert.match(app, /<CalibrationWorkbench/);

  assert.doesNotMatch(calibration, /\bfetch\s*\(/);
  assert.doesNotMatch(calibration, /\bCOM\d+\b/i);
  for (const operation of [
    "calibration.candidate.get",
    "calibration.setup.configure",
    "calibration.point.capture",
    "calibration.model.activate",
    "calibration.model.rollback",
  ]) {
    assert.ok(
      calibration.includes(`"${operation}"`),
      `缺少 Agent 命令接线：${operation}`,
    );
  }
  assert.match(calibration, /agentClient\.operation\(/);
  assert.match(calibration, /agentClient\.cancel\(/);
  for (const forbidden of [
    "calibration.status.get",
    "calibration.capture.start",
    "calibration.capture.status",
    "calibration.capture.cancel",
    "calibration.point.accept",
    "calibration.model.promote",
    "calibration.model.autoSwitch.set",
  ]) {
    assert.ok(
      !calibration.includes(`"${forbidden}"`),
      `不得继续使用临时命令：${forbidden}`,
    );
  }
  assert.match(
    calibration,
    /durationSeconds:\s*15[\s\S]*warmupSeconds:\s*2[\s\S]*minimumSynchronizedGroups:\s*MIN_SYNC_GROUPS/,
  );
  assert.match(calibration, /operationRecord.*\.id|operationIdOf/);
});

test("现场标定地图以门锁中心为零点并支持2到4基站与键盘点选", async () => {
  const calibration = await readApp("src/ui/CalibrationWorkbench.tsx");

  assert.match(calibration, /const MIN_ANCHORS = 2/);
  assert.match(calibration, /const MAX_ANCHORS = 4/);
  assert.match(
    calibration,
    /type CalibrationPanel = "capture" \| "anchors" \| "analysis" \| "models"/,
  );
  assert.match(calibration, /useState<CalibrationPanel>\("capture"\)/);
  assert.match(calibration, /xMm:/);
  assert.match(calibration, /yMm:/);
  assert.match(calibration, /zMm:/);
  assert.match(calibration, /Math\.hypot/);
  assert.match(calibration, /Math\.atan2/);
  assert.match(calibration, /role="application"/);
  assert.match(calibration, /tabIndex=\{0\}/);
  assert.match(calibration, /onKeyDown/);
  assert.match(calibration, /onPointerDown/);

  for (const label of [
    "门锁中心 O",
    "基站坐标",
    "钥匙真值",
    "径向距离",
    "方位角",
  ]) {
    assert.ok(calibration.includes(label), `地图缺少文本：${label}`);
  }
});

test("现场采集完整呈现稳定、进度、同步门槛和质量拒绝", async () => {
  const calibration = await readApp("src/ui/CalibrationWorkbench.tsx");

  assert.match(calibration, /STABILITY_DURATION_MS = 2_000/);
  assert.match(calibration, /CAPTURE_DURATION_MS = 15_000/);
  assert.match(calibration, /MIN_SYNC_GROUPS = 100/);
  assert.match(calibration, /标定距离 \/ m/);
  assert.match(calibration, /标定角度 \/ °/);
  assert.match(calibration, /setPolarTruth/);
  assert.match(calibration, /Math\.sin\(radians\)/);
  assert.match(calibration, /Math\.cos\(radians\)/);

  for (const label of [
    "稳定倒计时",
    "采集进度",
    "同步组门槛",
    "质量",
    "取消采集",
  ]) {
    assert.ok(calibration.includes(label), `采集流程缺少文本：${label}`);
  }
});

test("现场标定提供模型对比、热力图、推荐点和安全模型操作", async () => {
  const [calibration, styles] = await Promise.all([
    readApp("src/ui/CalibrationWorkbench.tsx"),
    readApp("styles.css"),
  ]);

  for (const label of [
    "候选位置",
    "正式位置",
    "误差热力图",
    "下一点",
    "模型版本",
    "提升为正式模型",
    "回退模型",
  ]) {
    assert.ok(calibration.includes(label), `模型区缺少文本：${label}`);
  }

  assert.match(styles, /\.calibration-workbench/);
  assert.match(styles, /\.calibration-map/);
  assert.match(styles, /\.error-heatmap/);
  assert.match(styles, /\.calibration-mobile-fold/);
  assert.match(styles, /@media\s*\(max-width:\s*720px\)/);
  assert.match(styles, /prefers-reduced-motion:\s*reduce/);
});

test("现场标定使用紧凑仪表文案，不重复解释操作流程", async () => {
  const [app, calibration, styles] = await Promise.all([
    readApp("src/ui/App.tsx"),
    readApp("src/ui/CalibrationWorkbench.tsx"),
    readApp("styles.css"),
  ]);

  for (const compactLabel of [
    "真值地图",
    "采集",
    "基站",
    "分析",
    "模型",
    "无异常",
    "暂无推荐",
    "暂无误差",
    "位置对比",
  ]) {
    assert.ok(
      calibration.includes(compactLabel),
      `缺少紧凑标签：${compactLabel}`,
    );
  }

  for (const verboseCopy of [
    "FIELD CALIBRATION / ORIGIN LOCKED",
    "门锁中心 O 固定为坐标零点。先核对基站坐标，再点选钥匙真值并采集同步组。",
    "连续稳定 2 秒后进入采集",
    "等待 Agent 根据覆盖空洞和误差峰值推荐下一点。",
    "MODEL OUTPUT / TRUTH",
    "SETUP <strong>",
    "OPERATION <strong>",
    "2–4 ANCHORS",
  ]) {
    assert.ok(
      !calibration.includes(verboseCopy),
      `仍存在冗长文案：${verboseCopy}`,
    );
  }

  assert.ok(!app.includes("<option>FIELD</option>"), "现场通道不应残留英文值");
  assert.match(calibration, /const hasHeatmapData = heatmap\.some/);
  assert.match(calibration, /className="heatmap-empty"/);
  assert.ok(
    calibration.indexOf('className="next-point-card"') <
      calibration.indexOf('className="calibration-secondary-grid"'),
    "下一点应靠近采集主路径",
  );
  assert.match(
    styles,
    /@media\s*\(max-width:\s*720px\)[\s\S]*\.capture-actions \.calibration-primary-action[\s\S]*width:\s*100%/,
  );
});
