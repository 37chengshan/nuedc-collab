import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("原版网页只增加45秒采集控件并调用采集API", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  assert.match(html, /id="capture-label"/);
  assert.match(html, /id="capture-button"/);
  assert.match(html, /采集45秒/);
  assert.match(html, /id="capture-download-button"/);
  assert.match(app, /\/api\/captures/);
  assert.match(app, /durationSeconds:\s*45/);
});
