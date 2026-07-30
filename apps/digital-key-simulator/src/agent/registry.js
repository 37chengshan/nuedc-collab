import { DigitalKeyAgentError } from "./errors.js";
import { clone, sha256 } from "./json.js";
import {
  AGENT_PROTOCOL_VERSION,
  AGENT_SCHEMA_VERSION,
  DIGITAL_KEY_COMMAND_DEFINITIONS,
} from "./schemas.js";

function summaryOf(definition) {
  const {
    argumentsSchema: _argumentsSchema,
    resultSchema: _resultSchema,
    modes: _modes,
    ...summary
  } = definition;
  return clone(summary);
}

function validationError(operation, path, message, value) {
  throw new DigitalKeyAgentError(
    "VALIDATION_ERROR",
    `${operation} 参数 ${path || "/"} ${message}`,
    {
      status: 400,
      details: { operation, path, value },
    },
  );
}

function validateSchema(operation, schema, value, path = "") {
  if (schema.type === "object") {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value)
    ) {
      validationError(operation, path, "必须是对象", value);
    }
    for (const name of schema.required ?? []) {
      if (!(name in value)) {
        validationError(operation, `${path}/${name}`, "不能为空", undefined);
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const name of Object.keys(value)) {
        if (!allowed.has(name)) {
          validationError(
            operation,
            `${path}/${name}`,
            "不是允许的字段",
            value[name],
          );
        }
      }
    }
    for (const [name, childSchema] of Object.entries(
      schema.properties ?? {},
    )) {
      if (name in value) {
        validateSchema(operation, childSchema, value[name], `${path}/${name}`);
      }
    }
    return;
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      validationError(operation, path, "必须是数组", value);
    }
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      validationError(operation, path, "数组长度不足", value);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      validationError(operation, path, "数组长度过长", value);
    }
    if (schema.items) {
      value.forEach((item, index) =>
        validateSchema(operation, schema.items, item, `${path}/${index}`),
      );
    }
    return;
  }

  if (schema.type === "integer" && !Number.isInteger(value)) {
    validationError(operation, path, "必须是整数", value);
  }
  if (
    schema.type === "number" &&
    (typeof value !== "number" || !Number.isFinite(value))
  ) {
    validationError(operation, path, "必须是有限数字", value);
  }
  if (schema.type === "string" && typeof value !== "string") {
    validationError(operation, path, "必须是字符串", value);
  }
  if (schema.type === "boolean" && typeof value !== "boolean") {
    validationError(operation, path, "必须是布尔值", value);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    validationError(operation, path, "不在允许枚举中", value);
  }
  if (schema.minimum !== undefined && value < schema.minimum) {
    validationError(operation, path, `不能小于 ${schema.minimum}`, value);
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    validationError(operation, path, `不能大于 ${schema.maximum}`, value);
  }
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    validationError(operation, path, "长度不足", value);
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    validationError(operation, path, "长度过长", value);
  }
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
    validationError(operation, path, "格式不正确", value);
  }
}

export class DigitalKeyCommandRegistry {
  constructor(options = {}) {
    this.mode = options.mode ?? "simulation";
    if (!["simulation", "live", "workbench"].includes(this.mode)) {
      throw new DigitalKeyAgentError(
        "MODE_NOT_SUPPORTED",
        `不支持的运行模式：${this.mode}`,
        { status: 400, details: { mode: this.mode } },
      );
    }
    const definitions =
      options.definitions ?? DIGITAL_KEY_COMMAND_DEFINITIONS;
    this.definitions =
      this.mode === "workbench"
        ? [...definitions]
        : definitions.filter((definition) =>
            definition.modes.includes(this.mode),
          );
    this.byOperation = new Map(
      this.definitions.map((definition) => [
        definition.operation,
        definition,
      ]),
    );
    this.revision = sha256(this.definitions);
  }

  list() {
    return {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      schemaVersion: AGENT_SCHEMA_VERSION,
      mode: this.mode,
      revision: this.revision,
      commands: this.definitions.map(summaryOf),
    };
  }

  describe(operation) {
    const definition = this.byOperation.get(String(operation ?? ""));
    if (!definition) {
      throw new DigitalKeyAgentError(
        "OPERATION_NOT_ALLOWED",
        `当前 ${this.mode} 模式不允许操作：${operation}`,
        {
          status: 404,
          details: {
            operation,
            mode: this.mode,
            allowedOperations: [...this.byOperation.keys()],
          },
        },
      );
    }
    return clone(definition);
  }

  validate(operation, argumentsValue = {}) {
    const definition = this.describe(operation);
    validateSchema(
      definition.operation,
      definition.argumentsSchema,
      argumentsValue,
    );
    return clone(argumentsValue);
  }
}
