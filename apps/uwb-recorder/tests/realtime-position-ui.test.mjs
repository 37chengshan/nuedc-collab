import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("实时页突出显示最终标定后的距离、角度和误差状态", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  for (const id of [
    "calibrated-distance",
    "calibrated-angle",
    "calibrated-quality",
    "calibration-error-bound",
    "calibrated-zone",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /\/api\/calibration\/final/);
  assert.match(app, /\/api\/position/);
  assert.match(app, /renderCalibratedPosition/);
  assert.match(app, /window\.setInterval\(pollRealtime,\s*500\)/);
  assert.match(app, /smoothedAngleDeg:\s*0/);
  assert.match(app, /angleValid[\s\S]*smoothedAngleDeg[\s\S]*toFixed\(1\)/);
  assert.doesNotMatch(app, /calibrated-angle"\]\.textContent\s*=\s*"暂不可用"/);
});

test("侧边栏切换为真正分页并支持地址栏 hash", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const styles = await readFile(
    new URL("../styles.css", import.meta.url),
    "utf8",
  );

  assert.match(html, /class="page-section active-page"[^>]*id="monitor"|id="monitor"[^>]*class="page-section active-page"/);
  assert.match(app, /function activatePage/);
  assert.match(app, /hashchange/);
  assert.match(app, /aria-current/);
  assert.match(styles, /\.page-section:not\(\.active-page\)/);
  assert.match(styles, /\.page-section\.active-page/);
});
