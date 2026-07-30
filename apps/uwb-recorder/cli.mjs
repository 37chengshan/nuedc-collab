#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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
  parameters get
  schema [resource.action]

状态变更：
  connect --port COM6 --baud 115200 [--dry-run]
  disconnect [--dry-run]
  command --text "AT+VERSION" [--raw] [--dry-run]
  action enter|exit|read|reset|version|sleep|powerdown [--dry-run]
  action restore --yes [--dry-run]
  parameters set --interval 100 --role 1 --channel 9 --baud-code 4
    --power 3 --responders 2 --source 0A00
    --destinations "0100,0200,0000,0000,0000" [--dry-run]
  export --session ID --output path.csv
  delete-session --session ID --yes

公共参数：
  --format json|table
  --api-url http://127.0.0.1:4173
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
      headers: options.body
        ? { "Content-Type": "application/json" }
        : undefined,
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

function tableValue(data) {
  if (Array.isArray(data)) {
    return data.length === 0 ? "[]" : JSON.stringify(data, null, 2);
  }
  return JSON.stringify(data, null, 2);
}

function writeEnvelope(envelope, format) {
  if (format === "table" && envelope.ok) {
    process.stdout.write(`${tableValue(envelope.data)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
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
  return 1;
}

async function main() {
  const { positionals, flags } = parseArguments(process.argv.slice(2));
  const [command, subcommand] = positionals;
  if (!command || command === "help" || flags.help) {
    process.stdout.write(HELP.trimStart());
    return;
  }

  const format =
    flags.format ?? (process.stdout.isTTY ? "table" : "json");
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

  writeEnvelope(envelope, format);
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
  writeEnvelope(errorEnvelope(normalized), "json");
  process.exitCode = exitCodeFor(normalized);
}
