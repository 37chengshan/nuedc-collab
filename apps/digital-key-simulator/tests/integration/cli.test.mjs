import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("CLI help 以稳定 JSON 包络返回能力入口", async () => {
  const result = await runCli(["help"]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.defaultApi, "http://127.0.0.1:4180");
  assert.ok(envelope.data.commands.includes("registry"));
  assert.ok(envelope.data.commands.includes("execute"));
});

test("CLI 将 registry 请求转发到独立仿真服务", async () => {
  const server = createServer((request, response) => {
    assert.equal(request.url, "/api/agent/v1/registry");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        data: { mode: "simulation", revision: "revision-1" },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const result = await runCli([
      "registry",
      "--api",
      `http://127.0.0.1:${address.port}`,
    ]);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      data: { mode: "simulation", revision: "revision-1" },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
