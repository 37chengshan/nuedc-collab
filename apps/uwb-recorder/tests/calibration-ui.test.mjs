import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("web UI exposes the 77-point calibration wizard and all result views", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  for (const id of [
    "calibration-plan",
    "calibration-start-button",
    "calibration-recapture-button",
    "calibration-train-button",
    "calibration-validate-button",
    "calibration-export-c-button",
    "calibration-export-png-button",
    "calibration-export-csv-button",
    "calibration-export-json-button",
    "calibration-bias-chart",
    "calibration-distance-heatmap",
    "calibration-angle-heatmap",
    "calibration-trajectory-chart",
    "calibration-dynamic-error-chart",
    "calibration-boundary-chart",
    "calibration-geometry-chart",
    "calibration-quality-table",
    "calibration-rejection-reasons",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /0\.5,\s*0\.8,\s*0\.95,\s*1,\s*1\.05/);
  assert.match(app, /-45,\s*-30,\s*-15,\s*0,\s*15,\s*30,\s*45/);
  assert.match(app, /\/api\/calibration\/capture/);
  assert.match(app, /\/api\/calibration\/train/);
  assert.doesNotMatch(app, /\brenderCalibrationReports\s*\(/);
  assert.match(app, /\bdrawCalibrationReports\s*\(/);
  assert.match(app, /toDataURL\("image\/png"\)/);
  assert.match(html, /圆柱外边界距离/);
  assert.match(html, /位置半径/);
  assert.match(html, /300\s*mm/);
  assert.match(html, /≤\s*1\s*m.*开锁/s);
  assert.match(html, /1\s*～\s*2\s*m.*迎宾/s);
  assert.match(html, /2\s*～\s*3\s*m.*感应/s);
  assert.match(html, /±0\.30\s*m/);
  assert.match(html, /±10°/);
  assert.match(html, /正前方.*\+y/s);
  assert.match(html, /右侧.*正角/s);
  assert.match(html, /样本数/);
  assert.match(html, /中位数/);
  assert.match(html, /spread/i);
  assert.match(html, /SNR/);
  assert.match(html, /拒绝原因/);
});
