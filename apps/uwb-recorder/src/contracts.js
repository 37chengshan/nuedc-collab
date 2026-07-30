export const SCHEMA_VERSION = "1.2.0";

export class AppError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = options.status ?? 400;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? null;
  }
}

export function successEnvelope(data, extraMeta = {}) {
  return {
    ok: true,
    data,
    meta: {
      schemaVersion: SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      ...extraMeta,
    },
  };
}

export function errorEnvelope(error) {
  const normalized =
    error instanceof AppError
      ? error
      : new AppError("INTERNAL_ERROR", error.message ?? String(error), {
          status: 500,
          retryable: false,
        });
  return {
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
      details: normalized.details,
    },
    meta: {
      schemaVersion: SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
    },
  };
}

export const agentSchema = {
  version: SCHEMA_VERSION,
  resources: {
    status: {
      description: "读取采集服务、串口、当前会话和最新测距状态",
      actions: {
        get: { method: "GET", path: "/api/status", safety: "read" },
      },
    },
    ports: {
      description: "枚举 Windows 当前可用串口",
      actions: {
        list: { method: "GET", path: "/api/ports", safety: "read" },
      },
    },
    connection: {
      description: "连接或断开唯一串口采集通道",
      actions: {
        connect: {
          method: "POST",
          path: "/api/connect",
          safety: "mutating",
          input: {
            path: { type: "string", example: "COM6", required: true },
            baudRate: {
              type: "integer",
              enum: [
                9600, 19200, 38400, 57600, 115200, 230400, 460800,
                921600, 1000000, 2000000,
              ],
              required: true,
            },
            dryRun: { type: "boolean", default: false },
          },
        },
        disconnect: {
          method: "POST",
          path: "/api/disconnect",
          safety: "mutating",
          input: { dryRun: { type: "boolean", default: false } },
        },
      },
    },
    measurements: {
      description: "读取实时或历史测距帧",
      actions: {
        list: {
          method: "GET",
          path: "/api/measurements",
          safety: "read",
          query: {
            limit: { type: "integer", min: 1, max: 10000, default: 200 },
            device: { type: "integer", min: 1, max: 5 },
            sinceMs: { type: "integer", min: 0 },
            sessionId: { type: "string" },
          },
        },
      },
    },
    captures: {
      description: "启动和读取带测点名称的定时独立采集",
      actions: {
        start: {
          method: "POST",
          path: "/api/captures",
          safety: "mutating",
          input: {
            label: {
              type: "string",
              minLength: 1,
              maxLength: 80,
              required: true,
              example: "双路-中轴-1m",
            },
            durationSeconds: {
              type: "integer",
              min: 1,
              max: 3600,
              default: 45,
            },
          },
        },
        current: {
          method: "GET",
          path: "/api/captures/current",
          safety: "read",
        },
        list: {
          method: "GET",
          path: "/api/captures",
          safety: "read",
        },
        measurements: {
          method: "GET",
          path: "/api/captures/{id}/measurements",
          safety: "read",
        },
        export: {
          method: "GET",
          path: "/api/captures/{id}/export.csv",
          safety: "read",
        },
      },
    },
    calibration: {
      description:
        "生成77点计划、自动读取串口采样、训练/验证距离与角度模型并导出MSPM0 C模型",
      actions: {
        plan: {
          since: "1.2.0",
          method: "GET",
          path: "/api/calibration/plan",
          safety: "read",
          query: {
            boundaryOffsetMm: { type: "number", default: 300 },
          },
        },
        capture: {
          since: "1.2.0",
          method: "POST",
          path: "/api/calibration/capture",
          safety: "mutating",
          idempotent: true,
          input: {
            distanceM: { type: "number", min: 0.3, max: 3.5, required: true },
            angleDeg: { type: "number", min: -45, max: 45, required: true },
            anchorCount: { type: "integer", min: 2, max: 4, default: 2 },
            boundaryOffsetMm: { type: "number", default: 300 },
            durationSeconds: { type: "integer", default: 15 },
            warmupSeconds: { type: "integer", default: 2 },
            minimumSynchronizedGroups: { type: "integer", default: 100 },
            synchronizationWindowMs: { type: "integer", default: 120 },
            idempotencyKey: { type: "string" },
            dryRun: { type: "boolean", default: false },
          },
        },
        train: {
          since: "1.2.0",
          method: "POST",
          path: "/api/calibration/train",
          safety: "mutating",
          idempotent: true,
          longRunning: true,
          input: {
            plan: { type: "object" },
            captures: { type: "array" },
            anchors: { type: "array", minItems: 2, maxItems: 4 },
            idempotencyKey: { type: "string" },
            dryRun: { type: "boolean", default: false },
          },
        },
        validate: {
          since: "1.2.0",
          method: "POST",
          path: "/api/calibration/validate",
          safety: "read",
          idempotent: true,
          longRunning: true,
          input: {
            model: { type: "object" },
            validationPoints: { type: "array" },
            idempotencyKey: { type: "string" },
            dryRun: { type: "boolean", default: false },
          },
        },
        export: {
          since: "1.2.0",
          method: "POST",
          path: "/api/calibration/export",
          safety: "read",
          idempotent: true,
          input: {
            model: { type: "object" },
            name: { type: "string", default: "uwb_calibration_model" },
            target: { type: "string", default: "MSPM0G3507" },
            idempotencyKey: { type: "string" },
            dryRun: { type: "boolean", default: false },
          },
        },
      },
    },
    sessions: {
      description: "查看、导出和删除自动保存的采集会话",
      actions: {
        list: { method: "GET", path: "/api/sessions", safety: "read" },
        export: {
          method: "GET",
          path: "/api/sessions/{id}/export.csv",
          safety: "read",
        },
        delete: {
          method: "DELETE",
          path: "/api/sessions/{id}",
          safety: "destructive",
          input: { confirm: { type: "boolean", const: true, required: true } },
        },
      },
    },
    parameters: {
      description: "查询或写入 EWM550 参数",
      actions: {
        get: { method: "GET", path: "/api/parameters", safety: "read" },
        readFromModule: {
          method: "POST",
          path: "/api/actions/read",
          safety: "mutating",
        },
        writeToModule: {
          method: "POST",
          path: "/api/actions/write",
          safety: "mutating",
          input: {
            interval: { type: "integer", min: 20, max: 2000 },
            role: { type: "integer", enum: [0, 1, 2] },
            channel: { type: "integer", enum: [5, 9] },
            baudCode: { type: "integer", min: 0, max: 9 },
            power: { type: "integer", min: 0, max: 3 },
            responders: { type: "integer", min: 1, max: 5 },
            source: { type: "string", pattern: "^[0-9A-Fa-f]{1,4}$" },
            destinations: {
              type: "array",
              minItems: 5,
              maxItems: 5,
              items: { type: "string", pattern: "^[0-9A-Fa-f]{1,4}$" },
            },
            dryRun: { type: "boolean", default: false },
          },
        },
      },
    },
    actions: {
      description: "进入/退出配置、复位、版本、休眠、掉电和恢复出厂",
      actions: {
        execute: {
          method: "POST",
          path: "/api/actions/{name}",
          safety: "mutating",
          names: [
            "enter",
            "exit",
            "read",
            "write",
            "reset",
            "version",
            "sleep",
            "powerdown",
            "restore",
          ],
          destructiveNames: ["restore"],
        },
      },
    },
    command: {
      description: "发送自定义 AT 指令或原始文本",
      actions: {
        send: {
          method: "POST",
          path: "/api/command",
          safety: "mutating",
          input: {
            text: { type: "string", minLength: 1, required: true },
            lineEnding: { type: "boolean", default: true },
            dryRun: { type: "boolean", default: false },
          },
        },
      },
    },
  },
};

export function schemaAtPath(path) {
  if (!path) {
    return agentSchema;
  }
  const [resourceName, actionName] = path.split(".");
  const resource = agentSchema.resources[resourceName];
  if (!resource) {
    throw new AppError("SCHEMA_NOT_FOUND", `未知资源：${resourceName}`, {
      status: 404,
    });
  }
  if (!actionName) {
    return resource;
  }
  const action = resource.actions[actionName];
  if (!action) {
    throw new AppError(
      "SCHEMA_NOT_FOUND",
      `资源 ${resourceName} 没有动作 ${actionName}`,
      { status: 404 },
    );
  }
  return action;
}
