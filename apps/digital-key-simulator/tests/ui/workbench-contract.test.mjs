import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readApp = (path) => readFile(join(appRoot, path), "utf8");

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const results = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesBelow(path) : [path];
    }),
  );
  return results.flat();
}

test("React 入口独立加载数字钥匙工作台", async () => {
  const [html, main] = await Promise.all([
    readApp("index.html"),
    readApp("src/main.tsx"),
  ]);

  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /<div id="root"><\/div>/);
  assert.match(html, /type="module" src="\/src\/main\.tsx"/);
  assert.match(main, /createRoot/);
  assert.match(main, /<App\s*\/>/);
});

test("只有统一 Agent 客户端可以直接 fetch", async () => {
  const uiRoot = join(appRoot, "src", "ui");
  const sourcePaths = (await filesBelow(uiRoot)).filter((path) =>
    /\.[cm]?[jt]sx?$/.test(path),
  );
  const sources = await Promise.all(
    sourcePaths.map(async (path) => [path, await readFile(path, "utf8")]),
  );
  const fetchOwners = sources
    .filter(([, source]) => /\bfetch\s*\(/.test(source))
    .map(([path]) => path.split(/[\\/]/).at(-1));

  assert.deepEqual(fetchOwners, ["agent-client.ts"]);

  const client = await readApp("src/ui/agent-client.ts");
  assert.match(client, /window\.digitalKeyAgent/);
  assert.match(client, /\/api\/agent\/v1\/registry/);
  assert.match(client, /\/api\/agent\/v1\/query/);
  assert.match(client, /\/api\/agent\/v1\/commands:plan/);
  assert.match(client, /\/api\/agent\/v1\/commands:execute/);
  assert.match(client, /\/api\/agent\/v1\/events/);
  assert.match(client, /cancel\(/);
  assert.match(client, /subscribe\(/);
  assert.match(client, /idempotencyKey/);
});

test("主场景包含三区、45度边界、三锚点和可操作钥匙", async () => {
  const scene = await readApp("src/ui/DigitalKeyScene.tsx");

  assert.match(scene, /<svg/);
  assert.match(scene, /解锁区/);
  assert.match(scene, /迎宾区/);
  assert.match(scene, /监测区/);
  assert.match(scene, /-45°/);
  assert.match(scene, /\+45°/);
  assert.match(scene, /anchor-a1/);
  assert.match(scene, /anchor-a2/);
  assert.match(scene, /anchor-a3/);
  assert.match(scene, /role="slider"/);
  assert.match(scene, /onPointerMove/);
  assert.match(scene, /onKeyDown/);
});

test("工作台提供顶部控制、调试台、时间轴和无障碍状态", async () => {
  const [app, styles] = await Promise.all([
    readApp("src/ui/App.tsx"),
    readApp("styles.css"),
  ]);

  assert.match(app, /\u5b9e\u673a\u6a21\u5f0f/);
  assert.match(app, /\u56de\u653e\u6a21\u5f0f/);
  assert.match(app, /\u4eff\u771f\u6a21\u5f0f/);
  assert.match(app, /x:\s*-0\.18,\s*y:\s*0\.22/);
  assert.match(app, /x:\s*0\.18,\s*y:\s*0\.22/);
  assert.match(app, /x:\s*0,\s*y:\s*-0\.22/);
  assert.match(app, /Math\.max\(\s*0,\s*Math\.hypot\(position\.x,\s*position\.y\)\s*-\s*0\.3/);
  assert.match(app, /simulation\.faults\.set/);

  for (const label of [
    "数字钥匙工作台",
    "实机模式",
    "回放模式",
    "仿真模式",
    "链路调试台",
    "场景注入",
    "故障注入",
    "事件时间轴",
    "串口",
    "配置",
    "记录",
  ]) {
    assert.ok(app.includes(label), `缺少界面文本：${label}`);
  }

  assert.match(app, /aria-live="polite"/);
  assert.match(app, /ID 脉冲环/);
  assert.match(styles, /prefers-reduced-motion:\s*reduce/);
  assert.match(styles, /@media\s*\(max-width:\s*720px\)/);
  assert.match(styles, /details\.mobile-fold/);
});
