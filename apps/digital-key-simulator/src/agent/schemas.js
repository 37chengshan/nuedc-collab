export const JSON_SCHEMA_DRAFT =
  "https://json-schema.org/draft/2020-12/schema";
export const AGENT_SCHEMA_VERSION = "1.0.0";
export const AGENT_PROTOCOL_VERSION = "digital-key-agent/v1";

function objectSchema(id, title, properties = {}, required = []) {
  return {
    $schema: JSON_SCHEMA_DRAFT,
    $id: `urn:nuedc:digital-key:${id}`,
    title,
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

const emptyResultSchema = objectSchema(
  "result.generic",
  "通用命令结果",
  {},
);
emptyResultSchema.additionalProperties = true;

const simulationDefinitions = [
  {
    operation: "simulation.state.get",
    title: "读取仿真状态",
    description: "读取生命周期、钥匙姿态、门锁状态和最近一次测量快照。",
    modes: ["simulation"],
    kind: "query",
    execution: "immediate",
    safety: "read",
    changesState: false,
    requiresIdempotencyKey: false,
    requiresStateRevision: false,
    risk: {
      level: "low",
      tier: "open",
      reason: "只读取内存中的仿真状态",
    },
    argumentsSchema: objectSchema(
      "simulation.state.get.arguments",
      "读取仿真状态参数",
    ),
    resultSchema: emptyResultSchema,
  },
  {
    operation: "lock.snapshot.get",
    title: "读取门锁快照",
    description: "读取当前定位、区域判定、身份校验和锁状态。",
    modes: ["simulation"],
    kind: "query",
    execution: "immediate",
    safety: "read",
    changesState: false,
    requiresIdempotencyKey: false,
    requiresStateRevision: false,
    risk: {
      level: "low",
      tier: "open",
      reason: "只读取门锁计算结果",
    },
    argumentsSchema: objectSchema(
      "lock.snapshot.get.arguments",
      "读取门锁快照参数",
    ),
    resultSchema: emptyResultSchema,
  },
  {
    operation: "simulation.lifecycle.set",
    title: "设置仿真生命周期",
    description: "启动、暂停、停止或重置仿真时钟。",
    modes: ["simulation"],
    kind: "command",
    execution: "immediate",
    safety: "mutating",
    changesState: true,
    requiresIdempotencyKey: true,
    requiresStateRevision: true,
    risk: {
      level: "medium",
      tier: "warned",
      reason: "改变仿真运行状态",
    },
    argumentsSchema: objectSchema(
      "simulation.lifecycle.set.arguments",
      "设置仿真生命周期参数",
      {
        state: {
          type: "string",
          enum: ["running", "paused", "stopped", "reset"],
        },
      },
      ["state"],
    ),
    resultSchema: emptyResultSchema,
  },
  {
    operation: "simulation.key.setPose",
    title: "设置数字钥匙姿态",
    description: "设置钥匙二维位置、地址和激活状态并重新计算门锁。",
    modes: ["simulation"],
    kind: "command",
    execution: "immediate",
    safety: "mutating",
    changesState: true,
    requiresIdempotencyKey: true,
    requiresStateRevision: true,
    risk: {
      level: "medium",
      tier: "warned",
      reason: "改变仿真钥匙位置并触发门锁状态重算",
    },
    argumentsSchema: objectSchema(
      "simulation.key.setPose.arguments",
      "设置数字钥匙姿态参数",
      {
        xMm: { type: "number" },
        yMm: { type: "number" },
        timeMs: { type: "number", minimum: 0 },
        active: { type: "boolean" },
        keyAddress: { type: "integer", minimum: 0, maximum: 65535 },
      },
      ["xMm", "yMm"],
    ),
    resultSchema: emptyResultSchema,
  },
  {
    operation: "simulation.lock.setExpectedId",
    title: "设置门锁期望 ID",
    description: "设置仿真门锁接受的低 4 bit 数字钥匙 ID。",
    modes: ["simulation"],
    kind: "command",
    execution: "immediate",
    safety: "mutating",
    changesState: true,
    requiresIdempotencyKey: true,
    requiresStateRevision: true,
    risk: {
      level: "medium",
      tier: "warned",
      reason: "改变仿真身份校验配置",
    },
    argumentsSchema: objectSchema(
      "simulation.lock.setExpectedId.arguments",
      "设置门锁期望 ID 参数",
      {
        expectedId: { type: "integer", minimum: 0, maximum: 15 },
      },
      ["expectedId"],
    ),
    resultSchema: emptyResultSchema,
  },
  {
    operation: "simulation.faults.set",
    title: "设置仿真故障",
    description: "设置锚点离线、多径偏差、ID 不匹配或数据超时故障。",
    modes: ["simulation"],
    kind: "command",
    execution: "immediate",
    safety: "mutating",
    changesState: true,
    requiresIdempotencyKey: true,
    requiresStateRevision: true,
    risk: {
      level: "medium",
      tier: "warned",
      reason: "改变仿真测量链路和门锁判定输入",
    },
    argumentsSchema: objectSchema(
      "simulation.faults.set.arguments",
      "设置仿真故障参数",
      {
        profile: {
          type: "string",
          enum: ["none", "anchor", "multipath", "id", "timeout"],
        },
      },
      ["profile"],
    ),
    resultSchema: emptyResultSchema,
  },
  {
    operation: "simulation.scenario.run",
    title: "运行仿真场景",
    description: "异步运行固定种子进入场景并保存可查询的操作结果。",
    modes: ["simulation"],
    kind: "command",
    execution: "async",
    safety: "mutating",
    changesState: true,
    requiresIdempotencyKey: true,
    requiresStateRevision: true,
    risk: {
      level: "high",
      tier: "warned",
      reason: "批量推进仿真时间和状态",
    },
    argumentsSchema: objectSchema(
      "simulation.scenario.run.arguments",
      "运行仿真场景参数",
      {
        name: { type: "string", minLength: 1, maxLength: 64 },
        seed: { type: "integer" },
        keyAddress: { type: "integer", minimum: 0, maximum: 65535 },
        expectedId: { type: "integer", minimum: 0, maximum: 15 },
        bearingDeg: { type: "number", minimum: -180, maximum: 180 },
        sampleIntervalMs: { type: "integer", minimum: 1 },
      },
    ),
    resultSchema: emptyResultSchema,
  },
  {
    operation: "diagnostics.run.start",
    title: "启动诊断",
    description: "异步检查仿真状态、三锚点测量和门锁安全条件。",
    modes: ["simulation"],
    kind: "command",
    execution: "async",
    safety: "mutating",
    changesState: false,
    requiresIdempotencyKey: true,
    requiresStateRevision: false,
    risk: {
      level: "medium",
      tier: "warned",
      reason: "启动可能持续一段时间的诊断操作",
    },
    argumentsSchema: objectSchema(
      "diagnostics.run.start.arguments",
      "启动诊断参数",
      {
        scope: {
          type: "string",
          enum: ["all", "localization", "lock", "measurements"],
        },
      },
    ),
    resultSchema: emptyResultSchema,
  },
];

const liveDefinitions = [
  {
    operation: "recorder.status.get",
    title: "读取 UWB Lab 状态",
    description: "只读代理到 127.0.0.1:4173/api/status。",
    modes: ["live"],
    kind: "query",
    execution: "immediate",
    safety: "read",
    changesState: false,
    requiresIdempotencyKey: false,
    requiresStateRevision: false,
    risk: {
      level: "low",
      tier: "open",
      reason: "只读访问现有 UWB Lab 状态",
    },
    argumentsSchema: objectSchema(
      "recorder.status.get.arguments",
      "读取 UWB Lab 状态参数",
    ),
    resultSchema: emptyResultSchema,
  },
  {
    operation: "recorder.measurements.list",
    title: "读取 UWB 测量",
    description: "只读代理到 127.0.0.1:4173/api/measurements。",
    modes: ["live"],
    kind: "query",
    execution: "immediate",
    safety: "read",
    changesState: false,
    requiresIdempotencyKey: false,
    requiresStateRevision: false,
    risk: {
      level: "low",
      tier: "open",
      reason: "只读访问现有 UWB Lab 测距数据",
    },
    argumentsSchema: objectSchema(
      "recorder.measurements.list.arguments",
      "读取 UWB 测量参数",
      {
        limit: { type: "integer", minimum: 1, maximum: 10000 },
        device: { type: "integer", minimum: 1, maximum: 5 },
        sinceMs: { type: "integer", minimum: 0 },
        sessionId: { type: "string", minLength: 1 },
      },
    ),
    resultSchema: {
      $schema: JSON_SCHEMA_DRAFT,
      $id: "urn:nuedc:digital-key:recorder.measurements.list.result",
      title: "UWB 测量列表",
      type: "array",
      items: {},
    },
  },
  {
    operation: "recorder.sessions.list",
    title: "读取 UWB 会话",
    description: "只读代理到 127.0.0.1:4173/api/sessions。",
    modes: ["live"],
    kind: "query",
    execution: "immediate",
    safety: "read",
    changesState: false,
    requiresIdempotencyKey: false,
    requiresStateRevision: false,
    risk: {
      level: "low",
      tier: "open",
      reason: "只读访问现有 UWB Lab 会话列表",
    },
    argumentsSchema: objectSchema(
      "recorder.sessions.list.arguments",
      "读取 UWB 会话参数",
    ),
    resultSchema: {
      $schema: JSON_SCHEMA_DRAFT,
      $id: "urn:nuedc:digital-key:recorder.sessions.list.result",
      title: "UWB 会话列表",
      type: "array",
      items: {},
    },
  },
];

export const DIGITAL_KEY_COMMAND_DEFINITIONS = [
  ...simulationDefinitions,
  ...liveDefinitions,
];
