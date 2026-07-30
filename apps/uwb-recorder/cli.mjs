#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, parse, resolve } from "node:path";

import {
  AppError,
  errorEnvelope,
  SCHEMA_VERSION,
  successEnvelope,
} from "./src/contracts.js";

const DEFAULT_API_URL = process.env.UWB_API_URL ?? "http://127.0.0.1:4173";

const HELP = `
UWB Lab Agent CLI

读取命令：
  status
  ports
  measurements [--limit 200] [--device 1] [--since-ms 30000] [--session ID]
  sessions
  captures
  capture status
  capture measurements --id CAPTURE_ID
  parameters get
  schema [resource.action]
  calibration plan

状态变更：
  capture start --label "双路-中轴-1m" [--duration 45]
  connect --port COM6 --baud 115200 [--dry-run]
  disconnect [--dry-run]
  command --text "AT+VERSION" [--raw] [--dry-run]
  action enter|exit|read|reset|version|sleep|powerdown [--dry-run]
  action restore --yes [--dry-run]
  parameters set --interval 100 --role 1 --channel 9 --baud-code 4
    --power 3 --responders 2 --source 0A00
    --destinations "0100,0200,0000,0000,0000" [--dry-run]
  export --session ID --output path.csv
  capture export --id CAPTURE_ID --output path.csv
  delete-session --session ID --yes
  calibration capture --distance 1 --angle 0 --anchors 2
    [--capture-id CAPTURE_ID] [--idempotency-key KEY] [--dry-run]
  calibration train [--input JSON|--input-file FILE]
    [--idempotency-key KEY] [--dry-run]
  calibration validate [--input JSON|--input-file FILE]
    [--idempotency-key KEY] [--dry-run]
  calibration export [--input JSON|--input-file FILE]
    [--name calibration_model_data] [--output DIR]
    [--idempotency-key KEY] [--dry-run]

公共参数：
  --api-url http://127.0.0.1:4173

退出码：
  0成功  1运行错误  2参数错误  3服务不可用  4串口错误
  5标定数据不足  6需要确认  7幂等冲突  8算法引擎不可用
`;

function parseArguments(argv) {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[name] = true;
    } else {
      flags[name] = next;
      index += 1;
    }
  }
  return { positionals, flags };
}

function requireFlag(flags, name) {
  const value = flags[name];
  if (value === undefined || value === true || value === "") {
    throw new AppError("CLI_VALIDATION_ERROR", `缺少 --${name}`, {
      status: 400,
      details: { flag: name },
    });
  }
  return value;
}

function numberFlag(flags, name, fallback = undefined) {
  if (flags[name] === undefined) {
    return fallback;
  }
  const value = Number(flags[name]);
  if (!Number.isFinite(value)) {
    throw new AppError("CLI_VALIDATION_ERROR", `--${name} 必须是数字`, {
      details: { flag: name, value: flags[name] },
    });
  }
  return value;
}

async function apiRequest(apiUrl, path, options = {}) {
  let response;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers ?? {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch (error) {
    throw new AppError(
      "SERVICE_UNAVAILABLE",
      `无法连接UWB Lab服务：${error.message}`,
      {
        status: 503,
        retryable: true,
        details: { apiUrl },
      },
    );
  }

  if (options.raw) {
    if (!response.ok) {
      throw new AppError("HTTP_ERROR", `服务返回HTTP ${response.status}`, {
        status: response.status,
      });
    }
    return {
      contentType: response.headers.get("content-type"),
      buffer: Buffer.from(await response.arrayBuffer()),
    };
  }

  const envelope = await response.json();
  if (!response.ok || !envelope.ok) {
    throw new AppError(
      envelope.error?.code ?? "API_ERROR",
      envelope.error?.message ?? `服务返回HTTP ${response.status}`,
      {
        status: response.status,
        retryable: envelope.error?.retryable ?? false,
        details: envelope.error?.details ?? null,
      },
    );
  }
  return envelope;
}

function writeEnvelope(envelope) {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function writeProgress(phase, state, extra = {}) {
  process.stderr.write(
    `${JSON.stringify({
      type: "progress",
      phase,
      state,
      timestamp: new Date().toISOString(),
      ...extra,
    })}\n`,
  );
}

async function inputObject(flags) {
  let text = null;
  if (flags.input !== undefined) {
    text = requireFlag(flags, "input");
  } else if (flags["input-file"] !== undefined) {
    text = await readFile(resolve(requireFlag(flags, "input-file")), "utf8");
  }
  if (text === null) {
    return {};
  }
  try {
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== "object") {
      throw new Error("input must be an object");
    }
    return value;
  } catch (error) {
    throw new AppError(
      "CLI_VALIDATION_ERROR",
      `--input/--input-file必须包含JSON对象：${error.message}`,
      { details: { inputFile: flags["input-file"] ?? null } },
    );
  }
}

function idempotencyHeaders(flags) {
  const key = flags["idempotency-key"];
  return key && key !== true ? { "Idempotency-Key": String(key) } : {};
}

function exitCodeFor(error) {
  if (error.code === "CONFIRMATION_REQUIRED") {
    return 6;
  }
  if (
    error.code === "VALIDATION_ERROR" ||
    error.code === "CLI_VALIDATION_ERROR"
  ) {
    return 2;
  }
  if (error.code === "SERVICE_UNAVAILABLE") {
    return 3;
  }
  if (String(error.code).startsWith("SERIAL_")) {
    return 4;
  }
  if (
    String(error.code).includes("INSUFFICIENT") ||
    String(error.code).includes("RECAPTURE")
  ) {
    return 5;
  }
  if (error.code === "IDEMPOTENCY_CONFLICT") {
    return 7;
  }
  if (
    error.code === "CALIBRATION_ENGINE_UNAVAILABLE" ||
    error.code === "CALIBRATION_UNAVAILABLE"
  ) {
    return 8;
  }
  return 1;
}

async function main() {
  const { positionals, flags } = parseArguments(process.argv.slice(2));
  const [command, subcommand] = positionals;
  if (!command || command === "help" || flags.help) {
    writeEnvelope(
      successEnvelope({
        command: "help",
        text: HELP.trim(),
        outputContract: {
          stdout: "single-json-envelope",
          stderr: "structured-progress",
        },
      }),
    );
    return;
  }

  const apiUrl = flags["api-url"] ?? DEFAULT_API_URL;
  const dryRun = flags["dry-run"] === true;
  let envelope;

  switch (command) {
    case "status":
      envelope = await apiRequest(apiUrl, "/api/status");
      break;
    case "ports":
      envelope = await apiRequest(apiUrl, "/api/ports");
      break;
    case "measurements": {
      const query = new URLSearchParams();
      if (flags.limit) query.set("limit", flags.limit);
      if (flags.device) query.set("device", flags.device);
      if (flags["since-ms"]) query.set("since_ms", flags["since-ms"]);
      if (flags.session) query.set("session_id", flags.session);
      envelope = await apiRequest(
        apiUrl,
        `/api/measurements?${query.toString()}`,
      );
      break;
    }
    case "sessions":
      envelope = await apiRequest(apiUrl, "/api/sessions");
      break;
    case "captures":
      envelope = await apiRequest(apiUrl, "/api/captures");
      break;
    case "capture":
      if (subcommand === "start") {
        envelope = await apiRequest(apiUrl, "/api/captures", {
          method: "POST",
          body: {
            label: requireFlag(flags, "label"),
            durationSeconds: numberFlag(flags, "duration", 45),
          },
        });
        break;
      }
      if (subcommand === "status") {
        envelope = await apiRequest(apiUrl, "/api/captures/current");
        break;
      }
      if (subcommand === "measurements") {
        const captureId = requireFlag(flags, "id");
        envelope = await apiRequest(
          apiUrl,
          `/api/captures/${encodeURIComponent(captureId)}/measurements`,
        );
        break;
      }
      if (subcommand === "export") {
        const captureId = requireFlag(flags, "id");
        const output = resolve(requireFlag(flags, "output"));
        if (dryRun) {
          envelope = successEnvelope({
            dryRun: true,
            action: "captures.export",
            captureId,
            output,
            changesFileSystem: true,
          });
          break;
        }
        const result = await apiRequest(
          apiUrl,
          `/api/captures/${encodeURIComponent(captureId)}/export.csv`,
          { raw: true },
        );
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, result.buffer);
        envelope = successEnvelope({
          captureId,
          output,
          bytes: result.buffer.length,
        });
        break;
      }
      throw new AppError(
        "CLI_VALIDATION_ERROR",
        "capture只支持 start、status、measurements 或 export",
      );
    case "calibration": {
      if (subcommand === "plan") {
        envelope = await apiRequest(apiUrl, "/api/calibration/plan");
        break;
      }
      if (!["capture", "train", "validate", "export"].includes(subcommand)) {
        throw new AppError(
          "CLI_VALIDATION_ERROR",
          "calibration只支持 plan、capture、train、validate 或 export",
        );
      }
      const common = {
        ...(await inputObject(flags)),
        dryRun,
      };
      if (subcommand === "capture") {
        Object.assign(common, {
          distanceM: numberFlag(flags, "distance"),
          angleDeg: numberFlag(flags, "angle"),
          anchorCount: numberFlag(flags, "anchors", 2),
          boundaryOffsetMm: numberFlag(flags, "boundary-offset-mm", 300),
          durationSeconds: numberFlag(flags, "duration", 15),
          warmupSeconds: numberFlag(flags, "warmup", 2),
          minimumSynchronizedGroups: numberFlag(flags, "minimum-groups", 100),
          synchronizationWindowMs: numberFlag(flags, "sync-window-ms", 120),
          captureId:
            flags["capture-id"] === undefined
              ? undefined
              : requireFlag(flags, "capture-id"),
        });
      }
      if (subcommand === "export") {
        common.name =
          flags.name === undefined
            ? common.name
            : requireFlag(flags, "name");
      }
      writeProgress(subcommand, "started", { dryRun });
      envelope = await apiRequest(
        apiUrl,
        `/api/calibration/${subcommand}`,
        {
          method: "POST",
          headers: idempotencyHeaders(flags),
          body: common,
        },
      );
      if (
        subcommand === "export" &&
        !dryRun &&
        flags.output &&
        envelope.data?.header &&
        envelope.data?.source
      ) {
        const output = resolve(requireFlag(flags, "output"));
        const requestedName =
          common.name ?? envelope.data.name ?? "calibration_model_data";
        let outputDirectory = output;
        let sourceName =
          envelope.data.sourceFileName ?? `${requestedName}.c`;
        let headerName =
          envelope.data.headerFileName ?? `${requestedName}.h`;
        if (extname(output).toLowerCase() === ".c") {
          outputDirectory = dirname(output);
          sourceName = parse(output).base;
          headerName = `${parse(output).name}.h`;
        }
        await mkdir(outputDirectory, { recursive: true });
        await Promise.all([
          writeFile(join(outputDirectory, headerName), envelope.data.header, "utf8"),
          writeFile(join(outputDirectory, sourceName), envelope.data.source, "utf8"),
        ]);
        envelope.data.files = {
          header: join(outputDirectory, headerName),
          source: join(outputDirectory, sourceName),
        };
      }
      writeProgress(subcommand, "completed", { ok: true });
      break;
    }
    case "schema":
      envelope = await apiRequest(
        apiUrl,
        subcommand ? `/api/schema/${encodeURIComponent(subcommand)}` : "/api/schema",
      );
      break;
    case "connect":
      envelope = await apiRequest(apiUrl, "/api/connect", {
        method: "POST",
        body: {
          path: requireFlag(flags, "port"),
          baudRate: numberFlag(flags, "baud"),
          dryRun,
        },
      });
      break;
    case "disconnect":
      envelope = await apiRequest(apiUrl, "/api/disconnect", {
        method: "POST",
        body: { dryRun },
      });
      break;
    case "command":
      envelope = await apiRequest(apiUrl, "/api/command", {
        method: "POST",
        body: {
          text: requireFlag(flags, "text"),
          lineEnding: flags.raw !== true,
          dryRun,
        },
      });
      break;
    case "action": {
      const action = subcommand;
      if (!action) {
        throw new AppError(
          "CLI_VALIDATION_ERROR",
          "action后必须提供动作名称",
        );
      }
      if (action === "restore" && flags.yes !== true && !dryRun) {
        throw new AppError(
          "CONFIRMATION_REQUIRED",
          "恢复出厂必须带 --yes；可先使用 --dry-run 查看将发送的命令",
          { status: 428 },
        );
      }
      envelope = await apiRequest(
        apiUrl,
        `/api/actions/${encodeURIComponent(action)}`,
        {
          method: "POST",
          body: { confirm: flags.yes === true, dryRun },
        },
      );
      break;
    }
    case "parameters":
      if (subcommand === "get") {
        envelope = await apiRequest(apiUrl, "/api/parameters");
        break;
      }
      if (subcommand !== "set") {
        throw new AppError(
          "CLI_VALIDATION_ERROR",
          "parameters只支持get或set",
        );
      }
      envelope = await apiRequest(apiUrl, "/api/actions/write", {
        method: "POST",
        body: {
          dryRun,
          parameters: {
            interval: numberFlag(flags, "interval"),
            role: numberFlag(flags, "role"),
            channel: numberFlag(flags, "channel"),
            baudCode: numberFlag(flags, "baud-code"),
            power: numberFlag(flags, "power"),
            responders: numberFlag(flags, "responders"),
            source: requireFlag(flags, "source"),
            destinations: requireFlag(flags, "destinations")
              .split(",")
              .map((value) => value.trim()),
          },
        },
      });
      break;
    case "export": {
      const sessionId = requireFlag(flags, "session");
      const output = resolve(requireFlag(flags, "output"));
      if (dryRun) {
        envelope = successEnvelope({
          dryRun: true,
          action: "sessions.export",
          sessionId,
          output,
          changesFileSystem: true,
        });
        break;
      }
      const result = await apiRequest(
        apiUrl,
        `/api/sessions/${encodeURIComponent(sessionId)}/export.csv`,
        { raw: true },
      );
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, result.buffer);
      envelope = successEnvelope({
        sessionId,
        output,
        bytes: result.buffer.length,
      });
      break;
    }
    case "delete-session": {
      const sessionId = requireFlag(flags, "session");
      if (flags.yes !== true) {
        throw new AppError(
          "CONFIRMATION_REQUIRED",
          "删除会话必须带 --yes",
          { status: 428 },
        );
      }
      envelope = await apiRequest(
        apiUrl,
        `/api/sessions/${encodeURIComponent(sessionId)}?confirm=true`,
        { method: "DELETE" },
      );
      break;
    }
    default:
      throw new AppError("CLI_COMMAND_NOT_FOUND", `未知命令：${command}`, {
        status: 404,
      });
  }

  writeEnvelope(envelope);
}

try {
  await main();
} catch (error) {
  const normalized =
    error instanceof AppError
      ? error
      : new AppError("CLI_INTERNAL_ERROR", error.message ?? String(error), {
          status: 500,
        });
  writeEnvelope(errorEnvelope(normalized));
  process.exitCode = exitCodeFor(normalized);
}
