import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const appRoot = new URL("../../", import.meta.url);
const recorderRoot = new URL("../../../uwb-recorder/", import.meta.url);

async function read(relativePath, root = appRoot) {
  return readFile(new URL(relativePath, root), "utf8");
}

test("数字钥匙仿真器拥有独立的包、端口与启动入口", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  const startScript = await read("start.cmd");
  const serverEntry = await read("server.mjs");

  assert.equal(packageJson.name, "@nuedc/digital-key-simulator");
  assert.match(packageJson.scripts.dev, /4180/);
  assert.match(packageJson.scripts.dev, /build/);
  assert.match(startScript, /4180/);
  assert.match(serverEntry, /DIGITAL_KEY_PORT/);
  assert.match(serverEntry, /new URL\("\.\/dist\/"/);
  assert.doesNotMatch(startScript, /uwb-recorder/i);
});

test("现有 UWB Lab 继续使用原生静态入口", async () => {
  const recorderHtml = await read("index.html", recorderRoot);
  const recorderPackage = JSON.parse(await read("package.json", recorderRoot));

  assert.match(recorderHtml, /href="\.\/styles\.css"/);
  assert.match(recorderHtml, /src="\.\/src\/app\.js"/);
  assert.doesNotMatch(recorderHtml, /main\.tsx|digital-key-simulator/);
  assert.equal(recorderPackage.name, "@nuedc/uwb-recorder");
});
