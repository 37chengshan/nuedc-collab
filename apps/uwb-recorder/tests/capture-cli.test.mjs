import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../cli.mjs", import.meta.url));

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function withAgentApi(callback) {
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
        : {};
      const data =
        request.method === "POST"
          ? {
              id: "capture-1",
              label: body.label,
              durationSeconds: body.durationSeconds,
              status: "recording",
            }
          : [{ id: "capture-1", status: "completed", frameCount: 22 }];
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          data,
          meta: { schemaVersion: "1.0.0" },
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("Agent CLI可以启动和列出同一批独立采集", async () => {
  await withAgentApi(async (apiUrl) => {
    const started = await runCli([
      "capture",
      "start",
      "--label",
      "双路-中轴-1m",
      "--duration",
      "45",
      "--api-url",
      apiUrl,
    ]);
    assert.equal(started.code, 0);
    assert.deepEqual(JSON.parse(started.stdout).data, {
      id: "capture-1",
      label: "双路-中轴-1m",
      durationSeconds: 45,
      status: "recording",
    });

    const listed = await runCli(["captures", "--api-url", apiUrl]);
    assert.equal(listed.code, 0);
    assert.equal(JSON.parse(listed.stdout).data[0].frameCount, 22);
  });
});
