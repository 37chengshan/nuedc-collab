import { createDomainResolver } from "./domain.js";
import {
  DigitalKeyAgentError,
  normalizeAgentError,
} from "./errors.js";
import { AgentEventStream } from "./events.js";
import { clone, createId, sha256 } from "./json.js";
import { UwbRecorderReadOnlyProxy } from "./live-proxy.js";
import { DigitalKeyCommandRegistry } from "./registry.js";

const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{16,160}$/;

function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DigitalKeyAgentError(
      "VALIDATION_ERROR",
      `${label} 必须是 JSON 对象`,
      { status: 400, details: { field: label } },
    );
  }
}

function normalizedRequest(request = {}) {
  assertObject(request, "request");
  const operation = String(request.operation ?? "").trim();
  if (!operation) {
    throw new DigitalKeyAgentError(
      "VALIDATION_ERROR",
      "operation 不能为空",
      { status: 400, details: { field: "operation" } },
    );
  }
  const argumentsValue = request.arguments ?? {};
  assertObject(argumentsValue, "arguments");
  return {
    operation,
    arguments: clone(argumentsValue),
    requestId:
      typeof request.requestId === "string" && request.requestId
        ? request.requestId
        : createId("req"),
    expectedStateRevision:
      request.expectedStateRevision ?? request.expectedRevision ?? null,
    idempotencyKey: request.idempotencyKey ?? null,
    planId: request.planId ?? null,
    dryRun: request.dryRun === true,
  };
}

function requireIdempotencyKey(request) {
  if (
    typeof request.idempotencyKey !== "string" ||
    !IDEMPOTENCY_PATTERN.test(request.idempotencyKey)
  ) {
    throw new DigitalKeyAgentError(
      "IDEMPOTENCY_KEY_REQUIRED",
      "写操作必须提供 16—160 字符的合法 idempotencyKey",
      {
        status: 400,
        details: { idempotencyKey: request.idempotencyKey },
      },
    );
  }
}

function replayOf(result) {
  return {
    ...clone(result),
    idempotentReplay: true,
  };
}

export class DigitalKeyRuntime {
  constructor(options = {}) {
    this.mode = options.mode ?? "simulation";
    this.registry =
      options.registry ?? new DigitalKeyCommandRegistry({ mode: this.mode });
    this.events =
      options.events ??
      new AgentEventStream({
        now: options.now,
      });
    this.liveProxy =
      options.liveProxy ??
      (this.mode === "live" || this.mode === "workbench"
        ? new UwbRecorderReadOnlyProxy(options.liveProxyOptions)
        : null);
    this.resolveDomain = createDomainResolver(options);
    this.now = options.now ?? (() => new Date().toISOString());
    this.planIdFactory =
      options.planIdFactory ?? (() => createId("plan"));
    this.operationIdFactory =
      options.operationIdFactory ?? (() => createId("op"));
    this.plans = new Map();
    this.receipts = new Map();
    this.operationRecords = new Map();
    this.operations = {
      get: (id) => this.getOperation(id),
      cancel: (id) => this.cancelOperation(id),
      list: () =>
        [...this.operationRecords.values()].map((record) => clone(record)),
    };
  }

  async query(rawRequest = {}) {
    const request = normalizedRequest(rawRequest);
    const definition = this.registry.describe(request.operation);
    if (definition.kind !== "query") {
      throw new DigitalKeyAgentError(
        "QUERY_OPERATION_REQUIRED",
        `${request.operation} 必须通过 plan/execute 调用`,
        { status: 405, details: { operation: request.operation } },
      );
    }
    const argumentsValue = this.registry.validate(
      request.operation,
      request.arguments,
    );
    const data =
      this.isLiveOperation(request.operation)
        ? await this.liveProxy.query(request.operation, argumentsValue)
        : await (
            await this.resolveDomain()
          ).query(request.operation, argumentsValue);
    return {
      requestId: request.requestId,
      operation: request.operation,
      arguments: argumentsValue,
      data: clone(data),
      stateRevision: sha256(data),
    };
  }

  async plan(rawRequest = {}) {
    const request = normalizedRequest(rawRequest);
    if (
      this.mode === "live" &&
      !this.isLiveCommandOperation(request.operation)
    ) {
      throw this.liveModeError(request.operation);
    }
    const definition = this.registry.describe(request.operation);
    if (definition.kind !== "command") {
      throw new DigitalKeyAgentError(
        "COMMAND_OPERATION_REQUIRED",
        `${request.operation} 是只读查询，请使用 query`,
        { status: 405, details: { operation: request.operation } },
      );
    }
    requireIdempotencyKey(request);
    const argumentsValue = this.registry.validate(
      request.operation,
      request.arguments,
    );
    const currentStateRevision = definition.requiresStateRevision
      ? await this.currentStateRevision(request.operation)
      : null;
    if (
      request.expectedStateRevision &&
      request.expectedStateRevision !== currentStateRevision
    ) {
      throw this.revisionConflict(
        request.expectedStateRevision,
        currentStateRevision,
      );
    }
    const plan = {
      planId: this.planIdFactory(),
      requestId: request.requestId,
      operation: request.operation,
      arguments: argumentsValue,
      idempotencyKey: request.idempotencyKey,
      expectedStateRevision: currentStateRevision,
      registryRevision: this.registry.revision,
      dryRun: true,
      changesState: definition.changesState,
      execution: definition.execution,
      risk: clone(definition.risk),
      createdAt: this.now(),
    };
    this.plans.set(plan.planId, {
      ...clone(plan),
      fingerprint: this.planFingerprint(plan),
    });
    return clone(plan);
  }

  async execute(rawRequest = {}) {
    const request = normalizedRequest(rawRequest);
    if (
      this.mode === "live" &&
      !this.isLiveCommandOperation(request.operation)
    ) {
      throw this.liveModeError(request.operation);
    }
    const definition = this.registry.describe(request.operation);
    if (definition.kind !== "command") {
      throw new DigitalKeyAgentError(
        "COMMAND_OPERATION_REQUIRED",
        `${request.operation} 是只读查询，请使用 query`,
        { status: 405, details: { operation: request.operation } },
      );
    }
    requireIdempotencyKey(request);
    const argumentsValue = this.registry.validate(
      request.operation,
      request.arguments,
    );
    if (request.dryRun) {
      return this.plan({
        ...request,
        arguments: argumentsValue,
      });
    }

    const expectedStateRevision = this.resolveExpectedRevision({
      request,
      argumentsValue,
      definition,
    });
    const receiptFingerprint = sha256({
      operation: request.operation,
      arguments: argumentsValue,
      expectedStateRevision,
    });
    const existingReceipt = this.receipts.get(request.idempotencyKey);
    if (existingReceipt) {
      if (existingReceipt.fingerprint !== receiptFingerprint) {
        throw new DigitalKeyAgentError(
          "IDEMPOTENCY_KEY_REUSED",
          "同一 idempotencyKey 已绑定不同请求",
          {
            status: 409,
            details: {
              idempotencyKey: request.idempotencyKey,
              operation: request.operation,
            },
          },
        );
      }
      return replayOf(existingReceipt.result);
    }

    const previousStateRevision = definition.requiresStateRevision
      ? await this.currentStateRevision(request.operation)
      : null;
    if (
      definition.requiresStateRevision &&
      expectedStateRevision !== previousStateRevision
    ) {
      throw this.revisionConflict(
        expectedStateRevision,
        previousStateRevision,
      );
    }

    if (definition.execution === "async") {
      const accepted = this.startOperation({
        request,
        argumentsValue,
        definition,
        previousStateRevision,
      });
      this.receipts.set(request.idempotencyKey, {
        fingerprint: receiptFingerprint,
        result: clone(accepted),
      });
      return accepted;
    }

    const data = await this.executeOperation(
      request.operation,
      argumentsValue,
      this.executionContext(null),
    );
    const stateRevision = definition.changesState
      ? await this.currentStateRevision(request.operation)
      : previousStateRevision;
    const result = {
      requestId: request.requestId,
      operation: request.operation,
      arguments: argumentsValue,
      data: clone(data),
      stateRevision,
      idempotencyKey: request.idempotencyKey,
      idempotentReplay: false,
      accepted: false,
    };
    if (definition.changesState) {
      this.emitStateChanged({
        request,
        previousStateRevision,
        stateRevision,
        data,
      });
    }
    this.receipts.set(request.idempotencyKey, {
      fingerprint: receiptFingerprint,
      result: clone(result),
    });
    return result;
  }

  getOperation(id) {
    const operation = this.operationRecords.get(String(id ?? ""));
    if (!operation) {
      throw new DigitalKeyAgentError(
        "OPERATION_NOT_FOUND",
        `找不到操作记录：${id}`,
        { status: 404, details: { operationId: id } },
      );
    }
    return clone(operation);
  }

  cancelOperation(id) {
    const operation = this.operationRecords.get(String(id ?? ""));
    if (!operation) {
      throw new DigitalKeyAgentError(
        "OPERATION_NOT_FOUND",
        `找不到操作记录：${id}`,
        { status: 404, details: { operationId: id } },
      );
    }
    if (["succeeded", "failed", "cancelled"].includes(operation.status)) {
      return clone(operation);
    }
    operation.cancelRequested = true;
    operation.status = "cancelled";
    operation.finishedAt = this.now();
    this.events.emit(
      "operation.cancelled",
      { operation: operation.operation },
      { operationId: operation.id },
    );
    return clone(operation);
  }

  resolveExpectedRevision({ request, argumentsValue, definition }) {
    if (request.planId) {
      const plan = this.plans.get(request.planId);
      if (!plan) {
        throw new DigitalKeyAgentError(
          "PLAN_NOT_FOUND",
          `找不到命令计划：${request.planId}`,
          { status: 404, details: { planId: request.planId } },
        );
      }
      const actualFingerprint = this.planFingerprint({
        operation: request.operation,
        arguments: argumentsValue,
        idempotencyKey: request.idempotencyKey,
        expectedStateRevision: plan.expectedStateRevision,
      });
      if (actualFingerprint !== plan.fingerprint) {
        throw new DigitalKeyAgentError(
          "PLAN_MISMATCH",
          "执行请求与命令计划不一致",
          {
            status: 409,
            details: {
              planId: request.planId,
              operation: request.operation,
            },
          },
        );
      }
      return plan.expectedStateRevision;
    }
    if (
      definition.requiresStateRevision &&
      !request.expectedStateRevision
    ) {
      throw new DigitalKeyAgentError(
        "STATE_REVISION_REQUIRED",
        "写操作必须提供 expectedStateRevision 或有效 planId",
        {
          status: 428,
          details: { operation: request.operation },
        },
      );
    }
    return request.expectedStateRevision;
  }

  planFingerprint(plan) {
    return sha256({
      operation: plan.operation,
      arguments: plan.arguments,
      idempotencyKey: plan.idempotencyKey,
      expectedStateRevision: plan.expectedStateRevision,
    });
  }

  isLiveOperation(operation) {
    return (
      String(operation ?? "").startsWith("recorder.") ||
      String(operation ?? "").startsWith("calibration.") ||
      String(operation ?? "").startsWith("device.")
    );
  }

  isLiveCommandOperation(operation) {
    return (
      String(operation ?? "").startsWith("calibration.") ||
      String(operation ?? "").startsWith("device.serial.")
    );
  }

  async executeOperation(operation, argumentsValue, context) {
    if (this.isLiveCommandOperation(operation)) {
      return this.liveProxy.execute(operation, argumentsValue, context);
    }
    const domain = await this.resolveDomain();
    return domain.execute(operation, argumentsValue, context);
  }

  async currentStateRevision(operation = "") {
    if (String(operation).startsWith("calibration.")) {
      const state = await this.liveProxy.query(
        "calibration.candidate.get",
        {},
      );
      return sha256(state);
    }
    if (
      String(operation).startsWith("device.serial.") ||
      this.mode === "live"
    ) {
      const state = await this.liveProxy.query("recorder.status.get", {});
      return sha256(state);
    }
    const domain = await this.resolveDomain();
    const state = await domain.query("simulation.state.get", {});
    return sha256(state);
  }

  startOperation({
    request,
    argumentsValue,
    definition,
    previousStateRevision,
  }) {
    const operationRecord = {
      id: this.operationIdFactory(),
      requestId: request.requestId,
      operation: request.operation,
      status: "queued",
      arguments: clone(argumentsValue),
      idempotencyKey: request.idempotencyKey,
      createdAt: this.now(),
      startedAt: null,
      finishedAt: null,
      stateRevision: previousStateRevision,
      result: null,
      error: null,
      cancelRequested: false,
    };
    this.operationRecords.set(operationRecord.id, operationRecord);
    this.events.emit(
      "operation.queued",
      { operation: request.operation },
      { operationId: operationRecord.id },
    );
    setImmediate(async () => {
      if (operationRecord.cancelRequested) {
        return;
      }
      try {
        operationRecord.status = "running";
        operationRecord.startedAt = this.now();
        this.events.emit(
          "operation.started",
          { operation: request.operation },
          { operationId: operationRecord.id },
        );
        const result = await this.executeOperation(
          request.operation,
          argumentsValue,
          this.executionContext(operationRecord.id),
        );
        if (operationRecord.cancelRequested) {
          return;
        }
        const stateRevision = definition.changesState
          ? await this.currentStateRevision(request.operation)
          : previousStateRevision;
        operationRecord.status = "succeeded";
        operationRecord.finishedAt = this.now();
        operationRecord.result = clone(result);
        operationRecord.stateRevision = stateRevision;
        if (definition.changesState) {
          this.emitStateChanged({
            request,
            previousStateRevision,
            stateRevision,
            data: result,
            operationId: operationRecord.id,
          });
        }
        this.events.emit(
          "operation.succeeded",
          {
            operation: request.operation,
            stateRevision,
          },
          { operationId: operationRecord.id },
        );
      } catch (error) {
        const normalized = normalizeAgentError(error);
        operationRecord.status = "failed";
        operationRecord.finishedAt = this.now();
        operationRecord.error = {
          code: normalized.code,
          message: normalized.message,
          retryable: normalized.retryable,
          details: normalized.details,
        };
        this.events.emit(
          "operation.failed",
          {
            operation: request.operation,
            error: operationRecord.error,
          },
          { operationId: operationRecord.id },
        );
      }
    });
    return {
      requestId: request.requestId,
      operation: request.operation,
      idempotencyKey: request.idempotencyKey,
      idempotentReplay: false,
      accepted: true,
      operationRecord: clone(operationRecord),
    };
  }

  executionContext(operationId) {
    return {
      emit: (type, data) =>
        this.events.emit(type, data, {
          operationId,
        }),
      isCancelled: () =>
        this.operationRecords.get(operationId)?.cancelRequested === true,
    };
  }

  emitStateChanged({
    request,
    previousStateRevision,
    stateRevision,
    data,
    operationId = null,
  }) {
    this.events.emit(
      "state.changed",
      {
        requestId: request.requestId,
        operation: request.operation,
        previousStateRevision,
        stateRevision,
        data: clone(data),
      },
      { operationId },
    );
  }

  revisionConflict(expectedStateRevision, actualStateRevision) {
    return new DigitalKeyAgentError(
      "REVISION_CONFLICT",
      "状态 revision 已变化，请重新 query/plan 后再执行",
      {
        status: 409,
        details: {
          expectedStateRevision,
          actualStateRevision,
        },
      },
    );
  }

  liveModeError(operation) {
    return new DigitalKeyAgentError(
      "LIVE_MODE_READ_ONLY",
      `实机模式只允许监看查询和受控持续标定：${operation}`,
      {
        status: 403,
        details: {
          operation,
          allowedOperations: [
            "recorder.status.get",
            "recorder.position.get",
            "recorder.calibration.get",
            "recorder.measurements.list",
            "recorder.sessions.list",
            "device.ports.list",
            "device.serial.connect",
            "device.serial.disconnect",
            "calibration.candidate.get",
            "calibration.setup.configure",
            "calibration.point.capture",
            "calibration.model.activate",
            "calibration.model.rollback",
          ],
          serialOwnership: "uwb-recorder:4173",
          forcedUnlockAllowed: false,
        },
      },
    );
  }
}
