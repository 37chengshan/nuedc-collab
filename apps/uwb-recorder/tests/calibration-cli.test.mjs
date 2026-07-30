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

async function withApi(callback) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
        : {};
      requests.push({
        method: request.method,
        url: request.url,
        idempotencyKey: request.headers["idempotency-key"],
        body,
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          data:
            request.url === "/api/calibration/plan"
              ? { points: Array.from({ length: 77 }, (_, index) => ({ index })) }
              : { completed: true },
          meta: { schemaVersion: "1.2.0" },
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await callback(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("calibration plan returns exactly one JSON envelope on stdout", async () => {
  await withApi(async (apiUrl) => {
    const result = await runCli([
      "calibration",
      "plan",
      "--api-url",
      apiUrl,
    ]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim().split(/\r?\n/).length, 1);
    assert.equal(JSON.parse(result.stdout).data.points.length, 77);
  });
});

test("long-running calibration progress stays on stderr and retry key is forwarded", async () => {
  await withApi(async (apiUrl, requests) => {
    const result = await runCli([
      "calibration",
      "train",
      "--input",
      "{\"captures\":[]}",
      "--idempotency-key",
      "train-cli-1",
      "--api-url",
      apiUrl,
    ]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim().split(/\r?\n/).length, 1);
    assert.match(result.stderr, /"phase":"train"/);
    assert.equal(requests[0].idempotencyKey, "train-cli-1");
  });
});

test("calibration capture dry-run is forwarded without local writes", async () => {
  await withApi(async (apiUrl, requests) => {
    const result = await runCli([
      "calibration",
      "capture",
      "--distance",
      "1",
      "--angle",
      "0",
      "--anchors",
      "2",
      "--dry-run",
      "--idempotency-key",
      "capture-dry-1",
      "--api-url",
      apiUrl,
    ]);
    assert.equal(result.code, 0);
    assert.equal(requests[0].body.dryRun, true);
    assert.equal(requests[0].body.anchorCount, 2);
  });
});
