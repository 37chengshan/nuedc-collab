import {
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  assessCapture,
  buildContinuousCalibrationCandidate,
  mapGroundTruthToDoorPolar,
  normalizeCalibrationSetup,
  normalizeContinuousCalibrationRecord,
  setupRevisionKey,
} from "../../../packages/uwb-localization/src/index.js";
import { AppError } from "./contracts.js";

const STATE_SCHEMA_VERSION = 1;
const SNAPSHOT_PATTERN = /^state-(\d+)-.*\.json$/;

export async function createContinuousCalibrationService({
  stateDirectory,
  runtimeModelTarget = null,
  captureSource = null,
  captureAssessor = assessCapture,
  candidateBuilder = buildContinuousCalibrationCandidate,
  clock = () => new Date(),
  idFactory = defaultIdFactory,
} = {}) {
  if (!stateDirectory) {
    throw new TypeError("stateDirectory不能为空");
  }
  await mkdir(stateDirectory, { recursive: true });
  const state = await loadLatestState(stateDirectory);
  const service = new ContinuousCalibrationService({
    stateDirectory,
    runtimeModelTarget,
    captureSource,
    captureAssessor,
    candidateBuilder,
    clock,
    idFactory,
    state,
  });
  service.restoreRuntimeModel();
  return service;
}

class ContinuousCalibrationService {
  constructor({
    stateDirectory,
    runtimeModelTarget,
    captureSource,
    captureAssessor,
    candidateBuilder,
    clock,
    idFactory,
    state,
  }) {
    this.stateDirectory = stateDirectory;
    this.runtimeModelTarget = runtimeModelTarget;
    this.captureSource = captureSource;
    this.captureAssessor = captureAssessor;
    this.candidateBuilder = candidateBuilder;
    this.clock = clock;
    this.idFactory = idFactory;
    this.state = state;
    this.mutationTail = Promise.resolve();
  }

  status() {
    const currentKey = this.state.setup
      ? setupRevisionKey(this.state.setup)
      : null;
    const currentRecords = this.state.records.filter(
      (record) => record.setupKey === currentKey,
    );
    const candidates = this.state.candidates.filter(
      (candidate) => candidate.setupKey === currentKey,
    );
    return structuredClone({
      ready: true,
      setup: this.state.setup
        ? {
            ...this.state.setup,
            autoActivate: this.state.settings.autoActivate,
          }
        : null,
      setupKey: currentKey,
      setupRevision: currentKey,
      recordCount: currentRecords.length,
      qualifiedRecordCount: currentRecords.filter(
        (record) => record.accepted,
      ).length,
      candidateCount: candidates.length,
      candidate: candidates[0] ?? null,
      candidates,
      active: this.state.active,
      activeSetupMatches:
        this.state.active === null ||
        this.state.active.setupKey === currentKey,
      history: this.state.history,
      stateSequence: this.state.sequence,
    });
  }

  async snapshot() {
    const status = this.status();
    const candidate = status.candidate;
    const [candidatePosition, formalPosition] = await Promise.all([
      candidate?.model &&
      typeof this.runtimeModelTarget?.estimateLatestWithModel === "function"
        ? this.runtimeModelTarget.estimateLatestWithModel(candidate.model, {
            source: "continuous-calibration-candidate",
            candidateId: candidate.id,
            setupKey: candidate.setupKey,
          })
        : null,
      typeof this.runtimeModelTarget?.estimateLatest === "function"
        ? this.runtimeModelTarget.estimateLatest()
        : null,
    ]);
    return {
      ...status,
      candidatePosition: normalizePositionSnapshot(candidatePosition),
      formalPosition: normalizePositionSnapshot(formalPosition),
      heatmap: buildErrorHeatmap(candidate),
      recommendation: recommendNextPoint(
        this.state.setup,
        this.state.records,
      ),
    };
  }

  async configureSetup(input) {
    return this.#enqueueMutation(() => this.#configureSetup(input));
  }

  async #configureSetup(input) {
    let setup;
    try {
      setup = normalizeSetupRequest(input, this.state.setup);
    } catch (error) {
      throw validationError(error.message);
    }
    const autoActivate =
      input.autoActivate === undefined
        ? this.state.settings.autoActivate
        : input.autoActivate === true;
    const existing = this.state.setup;
    if (existing) {
      const sameRevision =
        existing.id === setup.id && existing.revision === setup.revision;
      if (sameRevision) {
        if (JSON.stringify(existing) !== JSON.stringify(setup)) {
          throw new AppError(
            "CALIBRATION_SETUP_REVISION_CONFLICT",
            "同一setup revision不能修改门锁原点或锚点坐标",
            { status: 409 },
          );
        }
        if (autoActivate !== this.state.settings.autoActivate) {
          await this.#commit({
            ...this.state,
            settings: { autoActivate },
          });
        }
        return {
          setup: {
            ...setup,
            autoActivate,
          },
          setupKey: setupRevisionKey(setup),
          unchanged: true,
        };
      }
      if (existing.id === setup.id && setup.revision <= existing.revision) {
        throw new AppError(
          "CALIBRATION_SETUP_REVISION_NOT_ADVANCED",
          "更新固定场地必须递增setup revision",
          { status: 409 },
        );
      }
    }
    await this.#commit({
      ...this.state,
      setup,
      settings: { autoActivate },
      candidates: [],
    });
    return {
      setup: structuredClone({
        ...setup,
        autoActivate,
      }),
      setupKey: setupRevisionKey(setup),
      unchanged: false,
    };
  }

  async addRecord(input) {
    return this.#enqueueMutation(() => this.#addRecord(input));
  }

  async #addRecord(input) {
    const setup = this.#requireSetup();
    if (
      String(input?.setupId ?? "") !== setup.id ||
      Number(input?.setupRevision) !== setup.revision
    ) {
      throw new AppError(
        "CALIBRATION_SETUP_REVISION_MISMATCH",
        "记录的setup revision与当前固定场地不一致",
        {
          status: 409,
          details: {
            expected: setupRevisionKey(setup),
            received: `${input?.setupId}@${input?.setupRevision}`,
          },
        },
      );
    }
    let record;
    try {
      record = normalizeContinuousCalibrationRecord(
        {
          ...input,
          id: input.id ?? this.idFactory("record"),
          capturedAt: input.capturedAt ?? this.clock().toISOString(),
        },
        { setup },
      );
    } catch (error) {
      throw validationError(error.message);
    }
    const records = [
      ...this.state.records.filter((item) => item.id !== record.id),
      record,
    ];
    await this.#commit({
      ...this.state,
      records,
    });
    return structuredClone(record);
  }

  async captureCalibrationPoint(input = {}) {
    const setup = this.#requireSetup();
    if (!matchesSetupRevision(input.setupRevision, setup)) {
      throw new AppError(
        "CALIBRATION_SETUP_REVISION_MISMATCH",
        "采集请求的setup revision与当前固定场地不一致",
        {
          status: 409,
          details: {
            expected: setup.revision,
            received: input.setupRevision,
          },
        },
      );
    }
    if (typeof this.captureSource?.capturePoint !== "function") {
      throw new AppError(
        "CALIBRATION_CAPTURE_UNAVAILABLE",
        "4173串口采集源尚未接入持续标定服务",
        { status: 503, retryable: true },
      );
    }
    if (typeof this.captureAssessor !== "function") {
      throw new AppError(
        "CALIBRATION_ASSESSOR_UNAVAILABLE",
        "持续标定质量评估器尚未接入",
        { status: 503 },
      );
    }
    const truth = {
      xM: finiteNumber(input.xMm, "xMm") / 1000,
      yM: finiteNumber(input.yMm, "yMm") / 1000,
      zM:
        input.zMm === undefined || input.zMm === null
          ? setup.doorLockOrigin.zM
          : finiteNumber(input.zMm, "zMm") / 1000,
    };
    const durationSeconds = integerInRange(
      input.durationSeconds ?? 15,
      1,
      3600,
      "durationSeconds",
    );
    const warmupSeconds = integerInRange(
      input.warmupSeconds ?? 2,
      0,
      durationSeconds,
      "warmupSeconds",
    );
    const minimumSynchronizedGroups = integerInRange(
      input.minimumSynchronizedGroups ?? 100,
      1,
      100000,
      "minimumSynchronizedGroups",
    );
    const synchronizationWindowMs = integerInRange(
      input.synchronizationWindowMs ?? 120,
      1,
      5000,
      "synchronizationWindowMs",
    );
    const polar = mapGroundTruthToDoorPolar(setup, truth);
    const captured = await this.captureSource.capturePoint({
      label:
        input.label ??
        `continuous-${setupRevisionKey(setup)}-${Math.round(input.xMm)}-${Math.round(input.yMm)}`,
      durationSeconds: warmupSeconds + durationSeconds,
    });
    const warmupEnd =
      Date.parse(captured.startedAt) + warmupSeconds * 1000;
    const measurements = (captured.measurements ?? []).filter(
      (measurement) =>
        !Number.isFinite(warmupEnd) ||
        Date.parse(measurement.timestamp) >= warmupEnd,
    );
    const assessment = await this.captureAssessor({
      anchorCount: setup.anchors.length,
      anchors: setup.anchors.map((anchor) => ({
        id: anchor.id,
        xMm: anchor.xM * 1000,
        yMm: anchor.yM * 1000,
        zMm: anchor.zM * 1000,
      })),
      distanceM: polar.distanceM,
      angleDeg: polar.angleDeg,
      boundaryOffsetMm: 0,
      warmupSeconds,
      minimumSynchronizedGroups,
      synchronizationWindowMs,
      measurements,
    });
    const record = await this.addRecord({
      id: captured.captureId ?? this.idFactory("record"),
      capturedAt: captured.startedAt ?? this.clock().toISOString(),
      setupId: setup.id,
      setupRevision: setup.revision,
      physicalPointId: input.physicalPointId,
      split: input.split ?? "train",
      accepted: assessment.accepted === true,
      truth,
      perAnchor: assessment.perAnchor,
    });
    if (!record.accepted) {
      return {
        record,
        assessment,
        candidate: null,
        active: null,
      };
    }

    let candidate;
    try {
      candidate = await this.trainCandidate({
        limits: input.limits,
        modelOptions: input.modelOptions,
        note: input.note,
      });
    } catch (error) {
      if (error.code !== "VALIDATION_ERROR") {
        throw error;
      }
      return {
        record,
        assessment,
        candidate: null,
        active: null,
        trainingError: {
          code: error.code,
          message: error.message,
        },
      };
    }
    const active =
      (input.autoActivate ?? this.state.settings.autoActivate) === true &&
      candidate.admission?.passed === true
        ? await this.activateCandidate({ candidateId: candidate.id })
        : null;
    return {
      record,
      assessment,
      candidate,
      active,
    };
  }

  async trainCandidate(input = {}) {
    return this.#enqueueMutation(() => this.#trainCandidate(input));
  }

  async #trainCandidate(input = {}) {
    const setup = this.#requireSetup();
    let result;
    try {
      result = await this.candidateBuilder({
        setup,
        records: this.state.records,
        activeModel: this.state.active?.model ?? null,
        input,
        limits: input.limits,
        modelOptions: input.modelOptions,
      });
    } catch (error) {
      throw validationError(error.message);
    }
    const candidate = {
      id: this.idFactory("candidate"),
      setupKey: setupRevisionKey(setup),
      createdAt: this.clock().toISOString(),
      ...result,
    };
    await this.#commit({
      ...this.state,
      candidates: [candidate, ...this.state.candidates].slice(0, 10),
    });
    return structuredClone(candidate);
  }

  async activateCandidate(input = {}) {
    return this.#enqueueMutation(() => this.#activateCandidate(input));
  }

  async #activateCandidate(input = {}) {
    const setup = this.#requireSetup();
    if (
      input.setupRevision !== undefined &&
      !matchesSetupRevision(input.setupRevision, setup)
    ) {
      throw new AppError(
        "CALIBRATION_SETUP_REVISION_MISMATCH",
        "激活请求的setup revision与当前固定场地不一致",
        { status: 409 },
      );
    }
    const candidate = this.state.candidates.find(
      (item) =>
        item.id ===
        String(input.candidateId ?? input.candidateVersion ?? ""),
    );
    if (!candidate) {
      throw new AppError(
        "CALIBRATION_CANDIDATE_NOT_FOUND",
        "找不到指定候选模型",
        { status: 404 },
      );
    }
    if (candidate.setupKey !== setupRevisionKey(setup)) {
      throw new AppError(
        "CALIBRATION_SETUP_REVISION_MISMATCH",
        "候选模型不属于当前setup revision",
        { status: 409 },
      );
    }
    if (candidate.admission?.passed !== true) {
      throw new AppError(
        "CALIBRATION_CANDIDATE_REJECTED",
        "候选模型未通过持续标定硬门槛",
        {
          status: 422,
          details: { reasons: candidate.admission?.reasons ?? [] },
        },
      );
    }
    const active = {
      versionId: this.idFactory("model"),
      candidateId: candidate.id,
      setupKey: candidate.setupKey,
      activatedAt: this.clock().toISOString(),
      model: candidate.model,
      metrics: candidate.metrics,
      baselineMetrics: candidate.baselineMetrics,
      admission: candidate.admission,
      training: candidate.training,
      validation: candidate.validation,
    };
    const history = [
      ...(this.state.active ? [this.state.active] : []),
      ...this.state.history,
    ].slice(0, 2);
    await this.#commit({
      ...this.state,
      active,
      history,
    });
    this.#installRuntimeModel(active);
    return structuredClone(active);
  }

  async rollback(input = {}) {
    return this.#enqueueMutation(() => this.#rollback(input));
  }

  async #rollback(input = {}) {
    const setup = this.#requireSetup();
    if (
      input.setupRevision !== undefined &&
      !matchesSetupRevision(input.setupRevision, setup)
    ) {
      throw new AppError(
        "CALIBRATION_SETUP_REVISION_MISMATCH",
        "回退请求的setup revision与当前固定场地不一致",
        { status: 409 },
      );
    }
    const versionId = String(input.versionId ?? "").trim();
    const target = versionId
      ? this.state.history.find((item) => item.versionId === versionId)
      : this.state.history[0];
    if (!target) {
      throw new AppError(
        "CALIBRATION_HISTORY_NOT_FOUND",
        "没有可回退的持续标定历史版本",
        { status: 404 },
      );
    }
    const history = [
      ...(this.state.active ? [this.state.active] : []),
      ...this.state.history.filter(
        (item) => item.versionId !== target.versionId,
      ),
    ].slice(0, 2);
    await this.#commit({
      ...this.state,
      active: target,
      history,
    });
    this.#installRuntimeModel(target);
    return structuredClone(target);
  }

  restoreRuntimeModel() {
    if (this.state.active) {
      this.#installRuntimeModel(this.state.active);
    }
  }

  #requireSetup() {
    if (!this.state.setup) {
      throw new AppError(
        "CALIBRATION_SETUP_MISSING",
        "尚未配置固定场地setup",
        { status: 409 },
      );
    }
    return this.state.setup;
  }

  #installRuntimeModel(version) {
    if (
      typeof this.runtimeModelTarget?.installRuntimeModel === "function"
    ) {
      this.runtimeModelTarget.installRuntimeModel(version.model, {
        versionId: version.versionId,
        candidateId: version.candidateId,
        setupKey: version.setupKey,
        activatedAt: version.activatedAt,
        source: "continuous-calibration",
        metrics: version.metrics,
      });
    }
  }

  async #commit(nextState) {
    const committed = {
      ...nextState,
      schemaVersion: STATE_SCHEMA_VERSION,
      sequence: this.state.sequence + 1,
    };
    const suffix = randomUUID();
    const sequence = String(committed.sequence).padStart(12, "0");
    const temporaryPath = join(
      this.stateDirectory,
      `.state-${sequence}-${suffix}.json.tmp`,
    );
    const snapshotPath = join(
      this.stateDirectory,
      `state-${sequence}-${suffix}.json`,
    );
    await writeFile(
      temporaryPath,
      `${JSON.stringify(committed, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, snapshotPath);
    this.state = committed;
  }

  #enqueueMutation(operation) {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.catch(() => {});
    return result;
  }
}

async function loadLatestState(stateDirectory) {
  const names = await readdir(stateDirectory);
  const snapshots = names
    .map((name) => ({ name, match: name.match(SNAPSHOT_PATTERN) }))
    .filter((entry) => entry.match)
    .sort(
      (left, right) =>
        Number(right.match[1]) - Number(left.match[1]),
    );
  for (const snapshot of snapshots) {
    try {
      const parsed = JSON.parse(
        await readFile(join(stateDirectory, snapshot.name), "utf8"),
      );
      if (parsed.schemaVersion === STATE_SCHEMA_VERSION) {
        return normalizeState(parsed);
      }
    } catch {
      // A partial or corrupt newest snapshot falls back to the previous one.
    }
  }
  return normalizeState({});
}

function normalizeState(input) {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    sequence: Number.isInteger(input.sequence) ? input.sequence : 0,
    setup: input.setup ?? null,
    settings: {
      autoActivate: input.settings?.autoActivate === true,
    },
    records: Array.isArray(input.records) ? input.records : [],
    candidates: Array.isArray(input.candidates) ? input.candidates : [],
    active: input.active ?? null,
    history: Array.isArray(input.history)
      ? input.history.slice(0, 2)
      : [],
  };
}

function normalizeSetupRequest(input = {}, existing = null) {
  const requestedId =
    String(input.id ?? "").trim() ||
    normalizeSetupId(input.name) ||
    existing?.id ||
    "field-site";
  const requestedRevision = Number(input.revision);
  const hasExplicitRevision =
    input.revision !== undefined && input.revision !== null;
  if (hasExplicitRevision) {
    return normalizeCalibrationSetup({
      ...input,
      id: requestedId,
      revision: requestedRevision,
    });
  }

  const provisionalRevision =
    existing?.id === requestedId ? existing.revision : 1;
  const provisional = normalizeCalibrationSetup({
    ...input,
    id: requestedId,
    revision: provisionalRevision,
  });
  if (
    existing?.id === requestedId &&
    setupGeometryKey(existing) === setupGeometryKey(provisional)
  ) {
    return {
      ...provisional,
      revision: existing.revision,
    };
  }
  return {
    ...provisional,
    revision:
      existing?.id === requestedId ? existing.revision + 1 : 1,
  };
}

function normalizeSetupId(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.slice(0, 64);
}

function setupGeometryKey(setup) {
  const normalized = normalizeCalibrationSetup(setup);
  return JSON.stringify({
    doorLockOrigin: normalized.doorLockOrigin,
    anchors: normalized.anchors,
  });
}

function matchesSetupRevision(value, setup) {
  if (value === undefined || value === null || value === "") {
    return false;
  }
  return (
    String(value) === setupRevisionKey(setup) ||
    Number(value) === setup.revision
  );
}

function normalizePositionSnapshot(position) {
  if (!position?.valid || !Number.isFinite(Number(position.distanceM))) {
    return null;
  }
  const angleDeg = Number(position.angleDeg);
  const angleValid =
    position.angleValid === true && Number.isFinite(angleDeg);
  const radians = ((angleValid ? angleDeg : 0) * Math.PI) / 180;
  const radialM = Number(position.distanceM);
  return {
    xMm: angleValid ? Math.sin(radians) * radialM * 1000 : 0,
    yMm: Math.cos(radians) * radialM * 1000,
    zMm: 0,
    radialM,
    angleDeg: angleValid ? angleDeg : null,
    directionCertain: angleValid,
    version: position.modelVersion ?? position.candidateId ?? null,
    quality: position.quality ?? null,
  };
}

function buildErrorHeatmap(candidate) {
  if (!candidate) {
    return [];
  }
  const samples = candidate.validation?.samples ?? [];
  const rows = candidate.metrics?.rows ?? [];
  const rowByPoint = new Map(
    rows.map((row) => [String(row.pointId ?? ""), row]),
  );
  return samples
    .map((sample) => {
      const row = rowByPoint.get(
        String(sample.pointId ?? sample.physicalPointId ?? ""),
      );
      if (!sample.truth) {
        return null;
      }
      return {
        xMm: Math.round(Number(sample.truth.xM) * 1000),
        yMm: Math.round(Number(sample.truth.yM) * 1000),
        errorM: Number.isFinite(Number(row?.distanceErrorM))
          ? Math.abs(Number(row.distanceErrorM))
          : null,
        samples: Number(sample.recordCount ?? 1),
      };
    })
    .filter(Boolean);
}

function recommendNextPoint(setup, records) {
  if (!setup) {
    return null;
  }
  const setupKey = setupRevisionKey(setup);
  const acceptedPoints = (records ?? [])
    .filter((record) => record.accepted && record.setupKey === setupKey)
    .map((record) => ({
      xMm: Number(record.truth?.xM) * 1000,
      yMm: Number(record.truth?.yM) * 1000,
    }))
    .filter(
      (point) =>
        Number.isFinite(point.xMm) && Number.isFinite(point.yMm),
    );
  const candidates = [];
  for (const radiusM of [0.95, 1, 1.05, 1.95, 2, 2.05]) {
    for (const angleDeg of [-45, -30, -15, 0, 15, 30, 45]) {
      const radians = (angleDeg * Math.PI) / 180;
      candidates.push({
        xMm: Math.round(Math.sin(radians) * radiusM * 1000),
        yMm: Math.round(Math.cos(radians) * radiusM * 1000),
        zMm: Math.round(setup.doorLockOrigin.zM * 1000),
        radiusM,
        angleDeg,
      });
    }
  }
  const ranked = candidates
    .map((candidate) => {
      const nearestMm =
        acceptedPoints.length === 0
          ? Number.POSITIVE_INFINITY
          : Math.min(
              ...acceptedPoints.map((point) =>
                Math.hypot(
                  candidate.xMm - point.xMm,
                  candidate.yMm - point.yMm,
                ),
              ),
            );
      const edgeBonus = Math.abs(candidate.angleDeg) === 45 ? 250 : 0;
      const exactBoundaryBonus =
        candidate.radiusM === 1 || candidate.radiusM === 2 ? 150 : 0;
      return {
        ...candidate,
        score: nearestMm + edgeBonus + exactBoundaryBonus,
      };
    })
    .sort((left, right) => right.score - left.score);
  const next = ranked[0];
  return {
    xMm: next.xMm,
    yMm: next.yMm,
    zMm: next.zMm,
    radialM: next.radiusM,
    angleDeg: next.angleDeg,
    reason:
      acceptedPoints.length === 0
        ? "优先建立1米边界与±45°视场覆盖"
        : "该点兼顾边界、角度边缘与当前覆盖空洞",
  };
}

function validationError(message) {
  return new AppError("VALIDATION_ERROR", message, { status: 400 });
}

function defaultIdFactory(prefix) {
  return `${prefix}-${Date.now()}-${randomUUID()}`;
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new AppError("VALIDATION_ERROR", `${label}必须是有效数字`, {
      status: 400,
    });
  }
  return number;
}

function integerInRange(value, minimum, maximum, label) {
  const number = finiteNumber(value, label);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${label}必须是${minimum}～${maximum}之间的整数`,
      { status: 400 },
    );
  }
  return number;
}
