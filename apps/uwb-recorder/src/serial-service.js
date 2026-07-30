import { createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { SerialPort } from "serialport";

import { AppError } from "./contracts.js";
import { UwbStreamParser } from "./parser.js";

const BAUD_RATES = new Set([
  9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000,
  2000000,
]);
const MAX_EVENT_RING = 5000;
const MAX_MEASUREMENT_RING = 20000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function openPort(port) {
  return new Promise((resolve, reject) => {
    port.open((error) => (error ? reject(error) : resolve()));
  });
}

function closePort(port) {
  return new Promise((resolve, reject) => {
    port.close((error) => (error ? reject(error) : resolve()));
  });
}

function writePort(port, payload) {
  return new Promise((resolve, reject) => {
    port.write(payload, (writeError) => {
      if (writeError) {
        reject(writeError);
        return;
      }
      port.drain((drainError) => (drainError ? reject(drainError) : resolve()));
    });
  });
}

function endStream(stream) {
  return new Promise((resolve) => {
    if (!stream) {
      resolve();
      return;
    }
    stream.end(resolve);
  });
}

function normalizeAddress(value, label) {
  const rawAddress = String(value ?? "").trim().toUpperCase();
  if (!/^[0-9A-F]{1,4}$/.test(rawAddress)) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${label}必须是4位十六进制，例如 0A00`,
      { details: { field: label, value } },
    );
  }
  return rawAddress.padStart(4, "0");
}

function integerInRange(value, minimum, maximum, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${label}必须是${minimum}～${maximum}之间的整数`,
      { details: { field: label, value } },
    );
  }
  return number;
}

export function validateParameters(input = {}) {
  const destinations = Array.isArray(input.destinations)
    ? input.destinations
    : [];
  if (destinations.length !== 5) {
    throw new AppError("VALIDATION_ERROR", "目标地址必须正好提供5个", {
      details: { field: "destinations", value: input.destinations },
    });
  }

  const role = integerInRange(input.role, 0, 2, "role");
  const channel = Number(input.channel);
  if (![5, 9].includes(channel)) {
    throw new AppError("VALIDATION_ERROR", "channel只能是5或9", {
      details: { field: "channel", value: input.channel },
    });
  }

  return {
    interval: integerInRange(input.interval, 20, 2000, "interval"),
    role,
    channel,
    baudCode: integerInRange(input.baudCode, 0, 9, "baudCode"),
    power: integerInRange(input.power, 0, 3, "power"),
    responders: integerInRange(input.responders, 1, 5, "responders"),
    source: normalizeAddress(input.source, "source"),
    destinations: destinations.map((address, index) =>
      normalizeAddress(address, `destinations[${index}]`),
    ),
  };
}

export function buildWriteCommands(input) {
  const parameters = validateParameters(input);
  return {
    parameters,
    commands: [
      `AT+INTV=${parameters.interval}`,
      `AT+ROLE=${parameters.role}`,
      `AT+CH=${parameters.channel}`,
      `AT+BAUD=${parameters.baudCode}`,
      `AT+POWER=${parameters.power}`,
      `AT+RESPONDER_NUM=${parameters.responders}`,
      `AT+SRCADDR=${parameters.source}`,
      `AT+DSTADDR=${parameters.destinations.join("")}`,
    ],
  };
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function measurementsToCsv(measurements) {
  const header = [
    "timestamp",
    "elapsed_ms",
    "device",
    "link_index",
    "address",
    "distance_cm",
    "snr_db",
    "raw",
  ];
  return [
    header.join(","),
    ...measurements.map((measurement) =>
      [
        measurement.timestamp,
        measurement.elapsedMs,
        measurement.device,
        measurement.linkIndex ?? "",
        measurement.address,
        measurement.distanceCm,
        measurement.snrDb ?? "",
        measurement.raw,
      ]
        .map(csvCell)
        .join(","),
    ),
  ].join("\r\n");
}

export class UwbSerialService {
  constructor({ dataDirectory, serialPortClass = SerialPort } = {}) {
    this.dataDirectory = dataDirectory;
    this.sessionsDirectory = join(dataDirectory, "sessions");
    this.capturesDirectory = join(dataDirectory, "captures");
    this.SerialPortClass = serialPortClass;
    this.port = null;
    this.parser = new UwbStreamParser();
    this.decoder = new TextDecoder();
    this.session = null;
    this.sessionStream = null;
    this.capture = null;
    this.captureStream = null;
    this.captureTimer = null;
    this.eventSequence = 0;
    this.events = [];
    this.measurements = [];
    this.atMode = false;
    this.parameters = {
      interval: null,
      role: null,
      channel: null,
      baudCode: null,
      power: null,
      responders: null,
      source: null,
      destinations: ["0000", "0000", "0000", "0000", "0000"],
      version: null,
    };
  }

  async initialize() {
    await mkdir(this.sessionsDirectory, { recursive: true });
    await mkdir(this.capturesDirectory, { recursive: true });
  }

  async listPorts() {
    return this.SerialPortClass.list();
  }

  status() {
    const latestByDevice = {};
    for (const measurement of this.measurements) {
      if (measurement.device !== null) {
        latestByDevice[measurement.device] = measurement;
      }
    }
    return {
      connected: this.port?.isOpen ?? false,
      port: this.port?.path ?? null,
      baudRate: this.port?.settings?.baudRate ?? null,
      atMode: this.atMode,
      session: this.session,
      capture: this.currentCapture(),
      latestByDevice,
      eventSequence: this.eventSequence,
      parameters: structuredClone(this.parameters),
      persistence: {
        directory: this.sessionsDirectory,
        capturesDirectory: this.capturesDirectory,
        format: "jsonl",
      },
    };
  }

  async connect({ path, baudRate }) {
    if (this.port?.isOpen) {
      throw new AppError("SERIAL_ALREADY_CONNECTED", "串口已经连接", {
        status: 409,
        details: { path: this.port.path },
      });
    }
    if (!path || typeof path !== "string") {
      throw new AppError("VALIDATION_ERROR", "path不能为空");
    }
    const normalizedBaudRate = Number(baudRate);
    if (!BAUD_RATES.has(normalizedBaudRate)) {
      throw new AppError("VALIDATION_ERROR", "不支持的串口波特率", {
        details: { baudRate },
      });
    }

    const startedAt = new Date().toISOString();
    const id = startedAt.replaceAll(":", "-").replaceAll(".", "-");
    this.session = {
      id,
      startedAt,
      endedAt: null,
      port: path,
      baudRate: normalizedBaudRate,
      frameCount: 0,
      eventCount: 0,
    };
    this.events = [];
    this.measurements = [];
    this.parser = new UwbStreamParser();
    this.decoder = new TextDecoder();
    this.atMode = false;

    const port = new this.SerialPortClass({
      path,
      baudRate: normalizedBaudRate,
      autoOpen: false,
    });
    port.on("data", (chunk) => {
      this.#processMessages(
        this.parser.push(this.decoder.decode(chunk, { stream: true })),
      );
    });
    port.on("error", (error) => {
      this.#recordEvent({
        type: "error",
        code: "SERIAL_RUNTIME_ERROR",
        message: error.message,
      });
    });
    port.on("close", () => {
      if (this.capture?.status === "recording") {
        void this.finishCapture("interrupted");
      }
      if (this.session && !this.session.endedAt) {
        this.session.endedAt = new Date().toISOString();
        void this.#persistSessionMetadata();
      }
    });

    try {
      await openPort(port);
    } catch (error) {
      this.session = null;
      throw new AppError("SERIAL_OPEN_FAILED", error.message, {
        status: 409,
        retryable: true,
        details: { path, baudRate: normalizedBaudRate },
      });
    }

    this.port = port;
    this.sessionStream = createWriteStream(this.#sessionDataPath(id), {
      flags: "a",
      encoding: "utf8",
    });
    await this.#persistSessionMetadata();
    this.#recordEvent({
      type: "status",
      state: "connected",
      path,
      baudRate: normalizedBaudRate,
    });
    return this.status();
  }

  async disconnect() {
    if (!this.port) {
      return this.status();
    }
    if (this.capture?.status === "recording") {
      await this.finishCapture("interrupted");
    }
    this.#processMessages(this.parser.flush());
    const port = this.port;
    this.port = null;
    if (port.isOpen) {
      await closePort(port).catch((error) => {
        throw new AppError("SERIAL_CLOSE_FAILED", error.message, {
          status: 500,
          retryable: true,
        });
      });
    }
    if (this.session) {
      this.session.endedAt = new Date().toISOString();
      await this.#persistSessionMetadata();
    }
    await endStream(this.sessionStream);
    this.sessionStream = null;
    this.atMode = false;
    return this.status();
  }

  async send(text, { lineEnding = true } = {}) {
    if (!this.port?.isOpen) {
      throw new AppError("SERIAL_NOT_CONNECTED", "串口尚未连接", {
        status: 409,
        retryable: true,
      });
    }
    const command = String(text ?? "");
    if (!command) {
      throw new AppError("VALIDATION_ERROR", "发送内容不能为空");
    }
    const payload = lineEnding ? `${command}\r\n` : command;
    await writePort(this.port, Buffer.from(payload, "utf8"));
    this.#recordEvent({
      type: "serial",
      direction: "TX",
      raw: command,
    });
    return { text: command, lineEnding };
  }

  async enterConfigurationMode() {
    if (this.atMode) {
      return { atMode: true, attempts: 0 };
    }
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await delay(250);
      await this.send("+++", { lineEnding: false });
      await delay(650);
      if (this.atMode) {
        return { atMode: true, attempts: attempt };
      }
    }
    throw new AppError(
      "AT_MODE_TIMEOUT",
      "发送+++后未收到AT_MODE，请确认模块处于数据模式且串口波特率正确",
      { status: 504, retryable: true },
    );
  }

  async executeAction(name, payload = {}) {
    const action = String(name);
    if (payload.dryRun) {
      return this.previewAction(action, payload);
    }
    if (action === "restore" && payload.confirm !== true) {
      throw new AppError(
        "CONFIRMATION_REQUIRED",
        "恢复出厂必须明确传入 confirm=true",
        { status: 428, details: { action } },
      );
    }

    switch (action) {
      case "enter":
        return this.enterConfigurationMode();
      case "exit":
        await this.send("AT+EXIT");
        this.atMode = false;
        return { action, atMode: false };
      case "read":
        await this.enterConfigurationMode();
        await this.#sendSequence([
          "AT+BAUD=?",
          "AT+POWER=?",
          "AT+INTV=?",
          "AT+ROLE=?",
          "AT+CH=?",
          "AT+SRCADDR=?",
          "AT+DSTADDR=?",
          "AT+RESPONDER_NUM=?",
          "AT+VERSION",
        ]);
        return { action, parameters: structuredClone(this.parameters) };
      case "write": {
        const { parameters, commands } = buildWriteCommands(payload.parameters);
        await this.enterConfigurationMode();
        await this.#sendSequence(commands);
        return { action, parameters, commands, requiresReset: true };
      }
      case "reset":
        await this.enterConfigurationMode();
        await this.send("AT+RESET");
        this.atMode = false;
        return { action, atMode: false };
      case "version":
        await this.enterConfigurationMode();
        await this.send("AT+VERSION");
        return { action };
      case "sleep":
        await this.enterConfigurationMode();
        await this.send("AT+SLEEP=0");
        return { action, wake: "WKP或重新上电" };
      case "powerdown":
        await this.enterConfigurationMode();
        await this.send("AT+SLEEP=1");
        return { action, wake: "WKP或重新上电" };
      case "restore":
        await this.enterConfigurationMode();
        await this.send("AT+RESTORE");
        return { action, requiresReconfiguration: true, requiresReset: true };
      default:
        throw new AppError("UNKNOWN_ACTION", `未知模块动作：${action}`, {
          status: 404,
        });
    }
  }

  previewAction(name, payload = {}) {
    if (name === "write") {
      const { parameters, commands } = buildWriteCommands(payload.parameters);
      return {
        dryRun: true,
        action: name,
        parameters,
        commands: ["+++", ...commands],
        changesDeviceState: true,
      };
    }
    const commandMap = {
      enter: ["+++"],
      exit: ["AT+EXIT"],
      read: [
        "+++",
        "AT+BAUD=?",
        "AT+POWER=?",
        "AT+INTV=?",
        "AT+ROLE=?",
        "AT+CH=?",
        "AT+SRCADDR=?",
        "AT+DSTADDR=?",
        "AT+RESPONDER_NUM=?",
        "AT+VERSION",
      ],
      reset: ["+++", "AT+RESET"],
      version: ["+++", "AT+VERSION"],
      sleep: ["+++", "AT+SLEEP=0"],
      powerdown: ["+++", "AT+SLEEP=1"],
      restore: ["+++", "AT+RESTORE"],
    };
    if (!commandMap[name]) {
      throw new AppError("UNKNOWN_ACTION", `未知模块动作：${name}`, {
        status: 404,
      });
    }
    return {
      dryRun: true,
      action: name,
      commands: commandMap[name],
      destructive: name === "restore",
      changesDeviceState: !["read", "version"].includes(name),
    };
  }

  getEvents({ after = 0, limit = 500 } = {}) {
    const normalizedLimit = Math.min(Math.max(Number(limit) || 500, 1), 2000);
    return this.events
      .filter((event) => event.seq > Number(after || 0))
      .slice(0, normalizedLimit);
  }

  async getMeasurements({
    limit = 200,
    device = null,
    sinceMs = null,
    sessionId = null,
  } = {}) {
    const normalizedLimit = Math.min(Math.max(Number(limit) || 200, 1), 10000);
    let measurements;
    if (!sessionId || sessionId === this.session?.id) {
      measurements = [...this.measurements];
    } else {
      measurements = (await this.#readSessionEvents(sessionId)).filter(
        (event) => event.type === "frame",
      );
    }

    if (device !== null && device !== undefined) {
      measurements = measurements.filter(
        (measurement) => measurement.device === Number(device),
      );
    }
    if (sinceMs !== null && sinceMs !== undefined) {
      const threshold = Date.now() - Number(sinceMs);
      measurements = measurements.filter(
        (measurement) => new Date(measurement.timestamp).getTime() >= threshold,
      );
    }
    return measurements.slice(-normalizedLimit);
  }

  async listSessions() {
    const entries = await readdir(this.sessionsDirectory, {
      withFileTypes: true,
    });
    const sessions = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".meta.json")) {
        continue;
      }
      try {
        sessions.push(
          JSON.parse(
            await readFile(join(this.sessionsDirectory, entry.name), "utf8"),
          ),
        );
      } catch {
        // Ignore one damaged metadata file and continue listing other sessions.
      }
    }
    return sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async exportSessionCsv(sessionId) {
    const measurements = await this.getMeasurements({
      sessionId,
      limit: 10000,
    });
    return measurementsToCsv(measurements);
  }

  async startCapture({ label, durationSeconds = 45 } = {}) {
    if (!this.port?.isOpen || !this.session) {
      throw new AppError("SERIAL_NOT_CONNECTED", "串口尚未连接", {
        status: 409,
        retryable: true,
      });
    }
    if (this.capture?.status === "recording") {
      throw new AppError("CAPTURE_ALREADY_RUNNING", "已有一项采集正在进行", {
        status: 409,
        details: { captureId: this.capture.id },
      });
    }

    const normalizedLabel = String(label ?? "").trim();
    if (!normalizedLabel || normalizedLabel.length > 80) {
      throw new AppError(
        "VALIDATION_ERROR",
        "测点名称不能为空且不能超过80个字符",
        { details: { field: "label", value: label } },
      );
    }
    const normalizedDuration = integerInRange(
      durationSeconds,
      1,
      3600,
      "durationSeconds",
    );
    const startedAt = new Date();
    const id = `capture-${startedAt
      .toISOString()
      .replaceAll(":", "-")
      .replaceAll(".", "-")}`;
    this.capture = {
      id,
      label: normalizedLabel,
      durationSeconds: normalizedDuration,
      startedAt: startedAt.toISOString(),
      endsAt: new Date(
        startedAt.getTime() + normalizedDuration * 1000,
      ).toISOString(),
      endedAt: null,
      sessionId: this.session.id,
      frameCount: 0,
      status: "recording",
    };
    this.captureStream = createWriteStream(this.#captureDataPath(id), {
      flags: "a",
      encoding: "utf8",
    });
    await this.#persistCaptureMetadata();
    this.captureTimer = setTimeout(() => {
      void this.finishCapture("completed");
    }, normalizedDuration * 1000);
    this.captureTimer.unref?.();
    return this.currentCapture();
  }

  currentCapture() {
    if (!this.capture) {
      return null;
    }
    const remainingSeconds =
      this.capture.status === "recording"
        ? Math.max(
            0,
            Math.ceil(
              (new Date(this.capture.endsAt).getTime() - Date.now()) / 1000,
            ),
          )
        : 0;
    return {
      ...structuredClone(this.capture),
      remainingSeconds,
    };
  }

  async finishCapture(status = "completed") {
    if (!this.capture || this.capture.status !== "recording") {
      return this.currentCapture();
    }
    if (!["completed", "interrupted"].includes(status)) {
      throw new AppError("VALIDATION_ERROR", "无效的采集结束状态", {
        details: { status },
      });
    }
    if (this.captureTimer) {
      clearTimeout(this.captureTimer);
      this.captureTimer = null;
    }
    this.capture.status = status;
    this.capture.endedAt = new Date().toISOString();
    await endStream(this.captureStream);
    this.captureStream = null;
    await this.#persistCaptureMetadata();
    return this.currentCapture();
  }

  async listCaptures() {
    const entries = await readdir(this.capturesDirectory, {
      withFileTypes: true,
    });
    const captures = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".meta.json")) {
        continue;
      }
      try {
        captures.push(
          JSON.parse(
            await readFile(join(this.capturesDirectory, entry.name), "utf8"),
          ),
        );
      } catch {
        // Ignore one damaged metadata file and continue listing other captures.
      }
    }
    return captures.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async getCaptureMeasurements(captureId) {
    try {
      const content = await readFile(this.#captureDataPath(captureId), "utf8");
      return content
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new AppError("CAPTURE_NOT_FOUND", "找不到指定的独立采集", {
          status: 404,
          details: { captureId },
        });
      }
      throw error;
    }
  }

  async exportCaptureCsv(captureId) {
    return measurementsToCsv(
      await this.getCaptureMeasurements(captureId),
    );
  }

  async deleteSession(sessionId) {
    if (sessionId === this.session?.id && this.port?.isOpen) {
      throw new AppError(
        "ACTIVE_SESSION_CONFLICT",
        "当前采集会话仍在运行，必须先断开串口",
        { status: 409 },
      );
    }
    await unlink(this.#sessionDataPath(sessionId)).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
    await unlink(this.#sessionMetadataPath(sessionId)).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
    return { sessionId, deleted: true };
  }

  async #sendSequence(commands) {
    for (const command of commands) {
      await this.send(command);
      await delay(160);
    }
  }

  #processMessages(messages) {
    for (const message of messages) {
      if (message.kind === "frame") {
        this.#recordEvent({
          type: "frame",
          device: message.device,
          linkIndex: message.linkIndex,
          address: message.address,
          distanceCm: message.distanceCm,
          snrDb: message.snrDb,
          raw: message.raw,
        });
      } else {
        this.#parseAtResponse(message.raw);
        this.#recordEvent({
          type: "serial",
          direction: "RX",
          raw: message.raw,
        });
      }
    }
  }

  #parseAtResponse(raw) {
    const text = String(raw).replace(/^re:/i, "").trim();
    let match;
    if (/AT_MODE/i.test(text)) {
      this.atMode = true;
      return;
    }
    if ((match = text.match(/BAUD\s*:\s*(\d+)/i))) {
      this.parameters.baudCode = Number(match[1]);
    } else if ((match = text.match(/POWER\s*:\s*(\d+)/i))) {
      this.parameters.power = Number(match[1]);
    } else if ((match = text.match(/INTV\s*:\s*(\d+)/i))) {
      this.parameters.interval = Number(match[1]);
    } else if ((match = text.match(/ROLE\s*:\s*(\d+)/i))) {
      this.parameters.role = Number(match[1]);
    } else if ((match = text.match(/CH\s*:\s*(\d+)/i))) {
      this.parameters.channel = Number(match[1]);
    } else if ((match = text.match(/SRC_ADDR\s*:\s*([0-9A-F]{4})/i))) {
      this.parameters.source = match[1].toUpperCase();
    } else if (
      (match = text.match(/DST_ADDR([1-5])\s*:\s*([0-9A-F]{4})/i))
    ) {
      this.parameters.destinations[Number(match[1]) - 1] =
        match[2].toUpperCase();
    } else if (
      (match = text.match(/DST_ADDR\s*:\s*([0-9A-F]{4,20})/i))
    ) {
      const addresses = match[1].toUpperCase().padEnd(20, "0").slice(0, 20);
      this.parameters.destinations = Array.from({ length: 5 }, (_, index) =>
        addresses.slice(index * 4, index * 4 + 4),
      );
    } else if (
      (match = text.match(/RESPONDERR?_NUM\s*:\s*(\d+)/i))
    ) {
      this.parameters.responders = Number(match[1]);
    } else if ((match = text.match(/VERSION\s*:\s*(.+)/i))) {
      this.parameters.version = match[1].trim();
    }
  }

  #recordEvent(event) {
    const now = new Date();
    const record = {
      seq: ++this.eventSequence,
      timestamp: now.toISOString(),
      elapsedMs: this.session
        ? now.getTime() - new Date(this.session.startedAt).getTime()
        : 0,
      ...event,
    };
    this.events.push(record);
    if (this.events.length > MAX_EVENT_RING) {
      this.events.splice(0, this.events.length - MAX_EVENT_RING);
    }
    if (record.type === "frame") {
      this.measurements.push(record);
      if (this.measurements.length > MAX_MEASUREMENT_RING) {
        this.measurements.splice(
          0,
          this.measurements.length - MAX_MEASUREMENT_RING,
        );
      }
      if (this.session) {
        this.session.frameCount += 1;
      }
      if (this.capture?.status === "recording") {
        this.capture.frameCount += 1;
        this.captureStream?.write(`${JSON.stringify(record)}\n`);
        if (this.capture.frameCount % 20 === 0) {
          void this.#persistCaptureMetadata();
        }
      }
    }
    if (this.session) {
      this.session.eventCount += 1;
      this.sessionStream?.write(`${JSON.stringify(record)}\n`);
      if (this.session.eventCount % 20 === 0) {
        void this.#persistSessionMetadata();
      }
    }
    return record;
  }

  async #persistSessionMetadata() {
    if (!this.session) {
      return;
    }
    await writeFile(
      this.#sessionMetadataPath(this.session.id),
      `${JSON.stringify(this.session, null, 2)}\n`,
      "utf8",
    );
  }

  async #persistCaptureMetadata() {
    if (!this.capture) {
      return;
    }
    await writeFile(
      this.#captureMetadataPath(this.capture.id),
      `${JSON.stringify(this.capture, null, 2)}\n`,
      "utf8",
    );
  }

  async #readSessionEvents(sessionId) {
    try {
      const content = await readFile(this.#sessionDataPath(sessionId), "utf8");
      return content
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new AppError("SESSION_NOT_FOUND", "找不到指定采集会话", {
          status: 404,
          details: { sessionId },
        });
      }
      throw error;
    }
  }

  #sessionDataPath(sessionId) {
    return join(this.sessionsDirectory, `${sessionId}.jsonl`);
  }

  #sessionMetadataPath(sessionId) {
    return join(this.sessionsDirectory, `${sessionId}.meta.json`);
  }

  #captureDataPath(captureId) {
    return join(this.capturesDirectory, `${captureId}.jsonl`);
  }

  #captureMetadataPath(captureId) {
    return join(this.capturesDirectory, `${captureId}.meta.json`);
  }
}
