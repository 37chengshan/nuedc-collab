import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_SCHEMA_VERSION,
  createDigitalKeyRuntime,
  normalizeAgentError,
} from "../agent/index.js";

const API_PREFIX = "/api/agent/v1";
const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".tsx": "text/plain; charset=utf-8",
};

function writeJson(response, status, payload, requestId = null) {
  response.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  const envelope =
    payload?.ok === false
      ? payload
      : {
          ok: true,
          data: payload,
          meta: {
            schemaVersion: AGENT_SCHEMA_VERSION,
            timestamp: new Date().toISOString(),
            ...(requestId ? { requestId } : {}),
          },
        };
  response.end(`${JSON.stringify(envelope)}\n`);
}

function writeError(response, error) {
  const normalized = normalizeAgentError(error);
  writeJson(response, normalized.status, {
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
      details: normalized.details,
    },
    meta: {
      schemaVersion: AGENT_SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
    },
  });
}

function readBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        rejectBody(
          Object.assign(new Error("请求体超过 1MB"), {
            code: "PAYLOAD_TOO_LARGE",
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
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(text));
      } catch {
        rejectBody(
          Object.assign(new Error("请求体不是有效 JSON"), {
            code: "INVALID_JSON",
            status: 400,
          }),
        );
      }
    });
    request.on("error", rejectBody);
  });
}

function sendSse(response, event) {
  response.write(`id: ${event.id}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function streamEvents(request, response, runtime, requestUrl, operationId) {
  response.writeHead(200, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream; charset=utf-8",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders?.();
  response.write(
    `event: ready\ndata: ${JSON.stringify({
      schemaVersion: AGENT_SCHEMA_VERSION,
      mode: runtime.mode,
    })}\n\n`,
  );
  const after = Number(
    request.headers["last-event-id"] ??
      requestUrl.searchParams.get("after") ??
      0,
  );
  for (const event of runtime.events.list({ after, operationId })) {
    sendSse(response, event);
  }
  const unsubscribe = runtime.events.subscribe((event) => {
    if (!operationId || event.operationId === operationId) {
      sendSse(response, event);
    }
  });
  const heartbeat = setInterval(() => {
    response.write(`: heartbeat ${Date.now()}\n\n`);
  }, 15000);
  heartbeat.unref?.();
  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  request.on("close", cleanup);
  response.on("close", cleanup);
}

async function serveStatic(requestUrl, response, options) {
  const rootUrl = options.root ?? new URL("../../", import.meta.url);
  const root = resolve(fileURLToPath(rootUrl));
  const pathname =
    requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const relative = decodeURIComponent(pathname).replace(/^[/\\]+/, "");
  const filePath = resolve(root, relative);
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      throw new Error("not a file");
    }
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type":
        CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, {
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end("Not Found");
  }
}

function operationIdFrom(pathname) {
  const prefix = `${API_PREFIX}/operations/`;
  return pathname.startsWith(prefix)
    ? decodeURIComponent(pathname.slice(prefix.length))
    : null;
}

export function createDigitalKeyServer(options = {}) {
  const runtime =
    options.runtime ??
    createDigitalKeyRuntime({
      mode: options.mode ?? "workbench",
      ...(options.runtimeOptions ?? {}),
    });

  return createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Headers":
          "Accept,Content-Type,Last-Event-ID",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
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
      if (!pathname.startsWith(API_PREFIX)) {
        await serveStatic(requestUrl, response, options);
        return;
      }

      if (
        request.method === "GET" &&
        pathname === `${API_PREFIX}/registry`
      ) {
        writeJson(response, 200, runtime.registry.list());
        return;
      }
      if (
        request.method === "GET" &&
        pathname.startsWith(`${API_PREFIX}/registry/`)
      ) {
        const operation = decodeURIComponent(
          pathname.slice(`${API_PREFIX}/registry/`.length),
        );
        writeJson(response, 200, runtime.registry.describe(operation));
        return;
      }
      if (
        request.method === "POST" &&
        pathname === `${API_PREFIX}/query`
      ) {
        const body = await readBody(request);
        writeJson(
          response,
          200,
          await runtime.query(body),
          body.requestId,
        );
        return;
      }
      if (
        request.method === "POST" &&
        pathname === `${API_PREFIX}/commands:plan`
      ) {
        const body = await readBody(request);
        writeJson(
          response,
          200,
          await runtime.plan(body),
          body.requestId,
        );
        return;
      }
      if (
        request.method === "POST" &&
        pathname === `${API_PREFIX}/commands:execute`
      ) {
        const body = await readBody(request);
        const result = await runtime.execute(body);
        writeJson(
          response,
          result.accepted ? 202 : 200,
          result,
          body.requestId,
        );
        return;
      }

      const cancelSuffix = ":cancel";
      if (
        request.method === "POST" &&
        pathname.startsWith(`${API_PREFIX}/operations/`) &&
        pathname.endsWith(cancelSuffix)
      ) {
        const operationId = decodeURIComponent(
          pathname.slice(
            `${API_PREFIX}/operations/`.length,
            -cancelSuffix.length,
          ),
        );
        await readBody(request);
        writeJson(response, 200, runtime.operations.cancel(operationId));
        return;
      }

      const operationId = operationIdFrom(pathname);
      if (request.method === "GET" && operationId) {
        writeJson(response, 200, runtime.operations.get(operationId));
        return;
      }

      if (
        request.method === "GET" &&
        pathname === `${API_PREFIX}/events`
      ) {
        const wantsSse =
          request.headers.accept?.includes("text/event-stream") ||
          requestUrl.searchParams.get("stream") === "true";
        if (wantsSse) {
          streamEvents(
            request,
            response,
            runtime,
            requestUrl,
            requestUrl.searchParams.get("operationId"),
          );
          return;
        }
        const events = runtime.events.list({
          after: requestUrl.searchParams.get("after") ?? 0,
          limit: requestUrl.searchParams.get("limit") ?? 200,
          operationId: requestUrl.searchParams.get("operationId"),
          type: requestUrl.searchParams.get("type"),
        });
        writeJson(response, 200, {
          events,
          count: events.length,
          latestSequence: events.at(-1)?.seq ?? 0,
        });
        return;
      }

      throw Object.assign(new Error(`Agent API 路径不存在：${pathname}`), {
        code: "NOT_FOUND",
        status: 404,
      });
    } catch (error) {
      writeError(response, error);
    }
  });
}
