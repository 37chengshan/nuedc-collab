import { createReadStream, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

import {
  AppError,
  errorEnvelope,
  schemaAtPath,
  successEnvelope,
} from "./contracts.js";

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function writeJson(response, status, envelope) {
  response.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(envelope)}\n`);
}

function writeText(response, status, contentType, content) {
  response.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "Content-Type": contentType,
  });
  response.end(content);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(
          new AppError("PAYLOAD_TOO_LARGE", "请求体超过1MB", {
            status: 413,
          }),
        );
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new AppError("INVALID_JSON", "请求体不是有效JSON", { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function numberQuery(value, fallback = null) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

async function serveStatic(root, pathname, response) {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = resolve(root, relativePath);
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    throw new AppError("FORBIDDEN", "禁止访问该路径", { status: 403 });
  }
  try {
    if (!statSync(filePath).isFile()) {
      throw new Error("Not a file");
    }
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": contentTypes[extname(filePath)] ?? "application/octet-stream",
    });
    createReadStream(filePath).pipe(response);
  } catch {
    const fallback = resolve(root, "index.html");
    writeText(
      response,
      404,
      "text/html; charset=utf-8",
      await readFile(fallback, "utf8"),
    );
  }
}

export function createApiServer({
  http,
  service,
  calibration = null,
  finalCalibration = null,
  continuousCalibration = null,
  root,
}) {
  return http.createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Headers": "Content-Type,Idempotency-Key",
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
        "Access-Control-Allow-Origin": "*",
      });
      response.end();
      return;
    }

    const requestUrl = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "127.0.0.1"}`,
    );
    const pathname = decodeURIComponent(requestUrl.pathname);

    try {
      if (!pathname.startsWith("/api/")) {
        await serveStatic(root, pathname, response);
        return;
      }

      const parts = pathname.split("/").filter(Boolean);
      const body =
        request.method === "POST" || request.method === "PUT"
          ? await readRequestBody(request)
          : {};

      if (request.method === "GET" && pathname === "/api/schema") {
        writeJson(response, 200, successEnvelope(schemaAtPath()));
        return;
      }
      if (request.method === "GET" && parts[1] === "schema") {
        writeJson(
          response,
          200,
          successEnvelope(schemaAtPath(parts.slice(2).join("."))),
        );
        return;
      }
      if (request.method === "GET" && pathname === "/api/status") {
        writeJson(response, 200, successEnvelope(service.status()));
        return;
      }
      if (
        request.method === "GET" &&
        pathname === "/api/calibration/final"
      ) {
        if (!finalCalibration) {
          throw new AppError(
            "FINAL_CALIBRATION_UNAVAILABLE",
            "最终标定模型尚未载入",
            { status: 503 },
          );
        }
        writeJson(response, 200, successEnvelope(finalCalibration.status()));
        return;
      }
      if (request.method === "GET" && pathname === "/api/position") {
        if (!finalCalibration) {
          throw new AppError(
            "FINAL_CALIBRATION_UNAVAILABLE",
            "最终标定模型尚未载入",
            { status: 503 },
          );
        }
        writeJson(
          response,
          200,
          successEnvelope(await finalCalibration.estimateLatest()),
        );
        return;
      }
      if (
        request.method === "GET" &&
        pathname === "/api/calibration/continuous"
      ) {
        requireContinuousCalibration(continuousCalibration);
        writeJson(
          response,
          200,
          successEnvelope(
            typeof continuousCalibration.snapshot === "function"
              ? await continuousCalibration.snapshot()
              : continuousCalibration.status(),
          ),
        );
        return;
      }
      if (
        parts[1] === "calibration" &&
        parts[2] === "continuous" &&
        parts.length === 4
      ) {
        requireContinuousCalibration(continuousCalibration);
        const action = parts[3];
        const handlers = {
          setup: [["POST", "PUT"], "configureSetup"],
          "points:capture": [["POST"], "captureCalibrationPoint"],
          candidates: [["POST"], "trainCandidate"],
          activate: [["POST"], "activateCandidate"],
          "models:activate": [["POST"], "activateCandidate"],
          rollback: [["POST"], "rollback"],
          "models:rollback": [["POST"], "rollback"],
        };
        const handler = handlers[action];
        if (handler && handler[0].includes(request.method)) {
          writeJson(
            response,
            200,
            successEnvelope(
              await continuousCalibration[handler[1]](body),
            ),
          );
          return;
        }
      }
      if (request.method === "GET" && pathname === "/api/ports") {
        writeJson(response, 200, successEnvelope(await service.listPorts()));
        return;
      }
      if (request.method === "POST" && pathname === "/api/connect") {
        if (body.dryRun) {
          writeJson(
            response,
            200,
            successEnvelope({
              dryRun: true,
              action: "connect",
              path: body.path,
              baudRate: Number(body.baudRate),
              changesDeviceState: true,
            }),
          );
          return;
        }
        writeJson(
          response,
          200,
          successEnvelope(
            await service.connect({
              path: body.path,
              baudRate: body.baudRate,
            }),
          ),
        );
        return;
      }
      if (request.method === "POST" && pathname === "/api/disconnect") {
        if (body.dryRun) {
          writeJson(
            response,
            200,
            successEnvelope({
              dryRun: true,
              action: "disconnect",
              changesDeviceState: true,
            }),
          );
          return;
        }
        writeJson(response, 200, successEnvelope(await service.disconnect()));
        return;
      }
      if (request.method === "GET" && pathname === "/api/events") {
        writeJson(
          response,
          200,
          successEnvelope(
            service.getEvents({
              after: numberQuery(requestUrl.searchParams.get("after"), 0),
              limit: numberQuery(requestUrl.searchParams.get("limit"), 500),
            }),
          ),
        );
        return;
      }
      if (request.method === "GET" && pathname === "/api/measurements") {
        writeJson(
          response,
          200,
          successEnvelope(
            await service.getMeasurements({
              limit: numberQuery(requestUrl.searchParams.get("limit"), 200),
              device: numberQuery(requestUrl.searchParams.get("device")),
              sinceMs: numberQuery(requestUrl.searchParams.get("since_ms")),
              sessionId: requestUrl.searchParams.get("session_id"),
            }),
          ),
        );
        return;
      }
      if (request.method === "GET" && pathname === "/api/calibration/plan") {
        if (!calibration) {
          throw new AppError(
            "CALIBRATION_UNAVAILABLE",
            "标定服务尚未初始化",
            { status: 503 },
          );
        }
        writeJson(
          response,
          200,
          successEnvelope(
            calibration.plan({
              boundaryOffsetMm: numberQuery(
                requestUrl.searchParams.get("boundary_offset_mm"),
                300,
              ),
            }),
          ),
        );
        return;
      }
      if (
        request.method === "POST" &&
        parts[1] === "calibration" &&
        ["capture", "train", "validate", "export"].includes(parts[2]) &&
        parts.length === 3
      ) {
        if (!calibration) {
          throw new AppError(
            "CALIBRATION_UNAVAILABLE",
            "标定服务尚未初始化",
            { status: 503 },
          );
        }
        const action = parts[2];
        const input = {
          ...body,
          idempotencyKey:
            request.headers["idempotency-key"] ??
            body.idempotencyKey ??
            null,
        };
        if (
          action === "export" &&
          !input.model &&
          finalCalibration?.exportFirmware
        ) {
          writeJson(
            response,
            200,
            successEnvelope(finalCalibration.exportFirmware(input), {
              idempotencyKey: input.idempotencyKey,
            }),
          );
          return;
        }
        writeJson(
          response,
          200,
          successEnvelope(await calibration[action](input), {
            idempotencyKey: input.idempotencyKey,
          }),
        );
        return;
      }
      if (request.method === "POST" && pathname === "/api/captures") {
        writeJson(
          response,
          200,
          successEnvelope(
            await service.startCapture({
              label: body.label,
              durationSeconds: body.durationSeconds ?? 45,
            }),
          ),
        );
        return;
      }
      if (request.method === "GET" && pathname === "/api/captures/current") {
        writeJson(response, 200, successEnvelope(service.currentCapture()));
        return;
      }
      if (request.method === "GET" && pathname === "/api/captures") {
        writeJson(response, 200, successEnvelope(await service.listCaptures()));
        return;
      }
      if (
        request.method === "GET" &&
        parts[1] === "captures" &&
        parts[3] === "measurements"
      ) {
        writeJson(
          response,
          200,
          successEnvelope(await service.getCaptureMeasurements(parts[2])),
        );
        return;
      }
      if (
        request.method === "GET" &&
        parts[1] === "captures" &&
        parts[3] === "export.csv"
      ) {
        const csv = await service.exportCaptureCsv(parts[2]);
        writeText(response, 200, "text/csv; charset=utf-8", `\uFEFF${csv}`);
        return;
      }
      if (request.method === "GET" && pathname === "/api/sessions") {
        writeJson(response, 200, successEnvelope(await service.listSessions()));
        return;
      }
      if (request.method === "GET" && parts[1] === "sessions" && parts[3] === "export.csv") {
        const csv = await service.exportSessionCsv(parts[2]);
        writeText(response, 200, "text/csv; charset=utf-8", `\uFEFF${csv}`);
        return;
      }
      if (request.method === "GET" && parts[1] === "sessions" && parts[3] === "measurements") {
        writeJson(
          response,
          200,
          successEnvelope(
            await service.getMeasurements({
              sessionId: parts[2],
              limit: numberQuery(requestUrl.searchParams.get("limit"), 10000),
            }),
          ),
        );
        return;
      }
      if (request.method === "DELETE" && parts[1] === "sessions" && parts.length === 3) {
        if (body.confirm !== true && requestUrl.searchParams.get("confirm") !== "true") {
          throw new AppError(
            "CONFIRMATION_REQUIRED",
            "删除会话必须明确传入 confirm=true",
            { status: 428 },
          );
        }
        writeJson(response, 200, successEnvelope(await service.deleteSession(parts[2])));
        return;
      }
      if (request.method === "GET" && pathname === "/api/parameters") {
        writeJson(response, 200, successEnvelope(service.status().parameters));
        return;
      }
      if (request.method === "POST" && pathname === "/api/command") {
        if (body.dryRun) {
          writeJson(
            response,
            200,
            successEnvelope({
              dryRun: true,
              action: "command.send",
              text: body.text,
              lineEnding: body.lineEnding !== false,
              changesDeviceState: true,
            }),
          );
          return;
        }
        writeJson(
          response,
          200,
          successEnvelope(
            await service.send(body.text, { lineEnding: body.lineEnding !== false }),
          ),
        );
        return;
      }
      if (request.method === "POST" && parts[1] === "actions" && parts.length === 3) {
        const payload = { ...body };
        if (requestUrl.searchParams.get("dry_run") === "true") {
          payload.dryRun = true;
        }
        writeJson(
          response,
          200,
          successEnvelope(await service.executeAction(parts[2], payload)),
        );
        return;
      }

      throw new AppError("NOT_FOUND", `API路径不存在：${pathname}`, {
        status: 404,
      });
    } catch (error) {
      const envelope = errorEnvelope(error);
      writeJson(response, error.status ?? envelope.error?.status ?? 500, envelope);
    }
  });
}

function requireContinuousCalibration(service) {
  if (!service) {
    throw new AppError(
      "CONTINUOUS_CALIBRATION_UNAVAILABLE",
      "持续标定服务尚未初始化",
      { status: 503 },
    );
  }
}
