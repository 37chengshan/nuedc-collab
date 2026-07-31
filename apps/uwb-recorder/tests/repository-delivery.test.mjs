import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const appRoot = new URL("../", import.meta.url);
const repoRoot = new URL("../../../", import.meta.url);

test("全新克隆可从根目录启动并看到45秒采集入口", async () => {
  const rootPackage = JSON.parse(
    await readFile(new URL("package.json", repoRoot), "utf8"),
  );
  const rootReadme = await readFile(new URL("README.md", repoRoot), "utf8");
  const html = await readFile(new URL("index.html", appRoot), "utf8");

  assert.equal(
    rootPackage.scripts["uwb:lab"],
    "npm run start --workspace=@nuedc/uwb-recorder",
  );
  assert.match(rootReadme, /npm run uwb:lab/);
  assert.match(rootReadme, /127\.0\.0\.1:4173/);
  assert.match(html, /采集45秒/);
});

test("真实采集记录会随仓库交付", async () => {
  const ignoreRules = await readFile(new URL(".gitignore", appRoot), "utf8");
  const captureFiles = await readdir(new URL("data/captures/", appRoot), {
    recursive: true,
  });
  const sessionFiles = await readdir(new URL("data/sessions/", appRoot));

  assert.doesNotMatch(ignoreRules, /^data\/$/m);
  assert.ok(
    captureFiles.filter((name) => name.endsWith(".meta.json")).length >= 18,
  );
  assert.ok(
    captureFiles.filter((name) => name.endsWith(".jsonl")).length >= 18,
  );
  assert.ok(sessionFiles.some((name) => name.endsWith(".jsonl")));
});
