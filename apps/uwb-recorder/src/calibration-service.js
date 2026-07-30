import { AppError } from "./contracts.js";

export const DEFAULT_CALIBRATION_DISTANCES_M = Object.freeze([
  0.5, 0.8, 0.95, 1, 1.05, 1.5, 1.95, 2, 2.05, 2.5, 3,
]);
export const DEFAULT_CALIBRATION_ANGLES_DEG = Object.freeze([
  -45, -30, -15, 0, 15, 30, 45,
]);
export const DEFAULT_CALIBRATION_GEOMETRY = Object.freeze({
  boundaryOffsetMm: 300,
  angleRangeDeg: [-45, 45],
  anglePositiveDirection: "right",
  forwardAxis: "+y",
  anchors: [
    { id: 1, xMm: -125, yMm: 40, enabled: true },
    { id: 2, xMm: 125, yMm: 40, enabled: true },
  ],
});
const DEFAULT_ANCHOR_COORDINATES = Object.freeze([
  { id: 1, xMm: -125, yMm: 40, enabled: true },
  { id: 2, xMm: 125, yMm: 40, enabled: true },
  { id: 3, xMm: -125, yMm: -40, enabled: false },
  { id: 4, xMm: 125, yMm: -40, enabled: false },
]);

const DEFAULT_CAPTURE_OPTIONS = Object.freeze({
  durationSeconds: 15,
  warmupSeconds: 2,
  minimumSynchronizedGroups: 100,
  synchronizationWindowMs: 120,
});

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new AppError("VALIDATION_ERROR", `${label}必须是有效数字`, {
      details: { field: label, value },
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
      { details: { field: label, value } },
    );
  }
  return number;
}

function sortedUniqueNumbers(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new AppError("VALIDATION_ERROR", `${label}不能为空`, {
      details: { field: label, value: values },
    });
  }
  return [...new Set(values.map((value) => finiteNumber(value, label)))].sort(
    (left, right) => left - right,
  );
}

export function calibrationPointId(distanceM, angleDeg) {
  const distance = Math.round(finiteNumber(distanceM, "distanceM") * 1000)
    .toString()
    .padStart(4, "0");
  const angle = Math.round(finiteNumber(angleDeg, "angleDeg"));
  const angleText = `${angle >= 0 ? "+" : "-"}${Math.abs(angle)
    .toString()
    .padStart(2, "0")}`;
  return `R${distance}_A${angleText}`;
}

export function createCalibrationPlan(input = {}) {
  const distancesM = sortedUniqueNumbers(
    input.distancesM ?? DEFAULT_CALIBRATION_DISTANCES_M,
    "distancesM",
  );
  const anglesDeg = sortedUniqueNumbers(
    input.anglesDeg ?? DEFAULT_CALIBRATION_ANGLES_DEG,
    "anglesDeg",
  );
  const boundaryOffsetMm = finiteNumber(
    input.boundaryOffsetMm ?? DEFAULT_CALIBRATION_GEOMETRY.boundaryOffsetMm,
    "boundaryOffsetMm",
  );
  const points = [];
  for (const distanceM of distancesM) {
    for (const angleDeg of anglesDeg) {
      points.push({
        id: calibrationPointId(distanceM, angleDeg),
        index: points.length + 1,
        distanceM,
        angleDeg,
        label: `${distanceM.toFixed(2)} m / ${angleDeg >= 0 ? "+" : ""}${angleDeg}°`,
        status: "pending",
      });
    }
  }
  return {
    version: 1,
    distancesM,
    anglesDeg,
    pointCount: points.length,
    geometry: {
      ...DEFAULT_CALIBRATION_GEOMETRY,
      boundaryOffsetMm,
      positionRadiusDefinition: "radialDistanceM + boundaryOffsetMm / 1000",
      anchors: structuredClone(
        input.anchors ?? DEFAULT_CALIBRATION_GEOMETRY.anchors,
      ),
    },
    capture: { ...DEFAULT_CAPTURE_OPTIONS },
    points,
  };
}

function median(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function robustSpread(values) {
  const center = median(values);
  if (center === null) {
    return null;
  }
  return 1.4826 * median(values.map((value) => Math.abs(value - center)));
}

function synchronizedGroups(measurements, anchorCount, windowMs) {
  const byAddress = new Map();
  for (const measurement of measurements) {
    const device = Number(measurement.device);
    const timestampMs = Date.parse(measurement.timestamp);
    if (
      !Number.isInteger(device) ||
      device < 1 ||
      device > anchorCount ||
      !Number.isFinite(timestampMs)
    ) {
      continue;
    }
    const address = String(measurement.address ?? "unknown");
    if (!byAddress.has(address)) {
      byAddress.set(address, []);
    }
    byAddress.get(address).push({ ...measurement, device, timestampMs });
  }

  const groups = [];
  for (const frames of byAddress.values()) {
    frames.sort((left, right) => left.timestampMs - right.timestampMs);
    let current = [];
    const flush = () => {
      const devices = new Set(current.map((frame) => frame.device));
      if (devices.size === anchorCount) {
        groups.push(current);
      }
      current = [];
    };
    for (const frame of frames) {
      if (
        current.length > 0 &&
        (frame.timestampMs - current[0].timestampMs > windowMs ||
          current.some((item) => item.device === frame.device))
      ) {
        flush();
      }
      current.push(frame);
      if (new Set(current.map((item) => item.device)).size === anchorCount) {
        flush();
      }
    }
    flush();
  }
  return groups;
}

export function assessCalibrationCapture(input) {
  const anchorCount = integerInRange(input.anchorCount, 2, 4, "anchorCount");
  const minimumGroups = integerInRange(
    input.minimumSynchronizedGroups ??
      DEFAULT_CAPTURE_OPTIONS.minimumSynchronizedGroups,
    1,
    100000,
    "minimumSynchronizedGroups",
  );
  const windowMs = integerInRange(
    input.synchronizationWindowMs ??
      DEFAULT_CAPTURE_OPTIONS.synchronizationWindowMs,
    1,
    5000,
    "synchronizationWindowMs",
  );
  const measurements = Array.isArray(input.measurements)
    ? input.measurements
    : [];
  const boundaryOffsetMm = finiteNumber(
    input.boundaryOffsetMm ??
      DEFAULT_CALIBRATION_GEOMETRY.boundaryOffsetMm,
    "boundaryOffsetMm",
  );
  const radialDistanceM = finiteNumber(input.distanceM, "distanceM");
  const angleDeg = finiteNumber(input.angleDeg, "angleDeg");
  const angleRadians = (angleDeg * Math.PI) / 180;
  const positionRadiusM = radialDistanceM + boundaryOffsetMm / 1000;
  const keyPosition = {
    xM: positionRadiusM * Math.sin(angleRadians),
    yM: positionRadiusM * Math.cos(angleRadians),
  };
  const anchors = (input.anchors ?? DEFAULT_ANCHOR_COORDINATES)
    .slice(0, anchorCount)
    .map((anchor, index) => ({
      id: anchor.id ?? index + 1,
      xMm: finiteNumber(anchor.xMm, `anchors[${index}].xMm`),
      yMm: finiteNumber(anchor.yMm, `anchors[${index}].yMm`),
    }));
  const groups = synchronizedGroups(measurements, anchorCount, windowMs);
  const synchronized = groups.flat();
  const perAnchor = Array.from({ length: anchorCount }, (_, index) => {
    const anchorId = index + 1;
    const frames = measurements.filter(
      (frame) => Number(frame.device) === anchorId,
    );
    const synchronizedFrames = synchronized.filter(
      (frame) => frame.device === anchorId,
    );
    const distances = frames
      .map((frame) => Number(frame.distanceCm))
      .filter(Number.isFinite);
    const snrValues = frames
      .map((frame) => Number(frame.snrDb))
      .filter(Number.isFinite);
    const anchor = anchors[index];
    const expectedDistanceCm = anchor
      ? Math.hypot(
          keyPosition.xM - anchor.xMm / 1000,
          keyPosition.yM - anchor.yMm / 1000,
        ) * 100
      : null;
    const medianCm = median(distances);
    return {
      anchorId,
      samples: frames.length,
      synchronizedSamples: synchronizedFrames.length,
      addresses: [...new Set(frames.map((frame) => String(frame.address)))].sort(),
      medianCm,
      spreadCm: robustSpread(distances),
      snrDb: median(snrValues),
      expectedDistanceCm,
      residualCm:
        medianCm === null || expectedDistanceCm === null
          ? null
          : medianCm - expectedDistanceCm,
    };
  });
  const recaptureReasons = [];
  const populatedAddressSets = perAnchor
    .filter((anchor) => anchor.samples > 0)
    .map((anchor) => new Set(anchor.addresses));
  const commonAddresses =
    populatedAddressSets.length === anchorCount
      ? [...populatedAddressSets[0]].filter((address) =>
          populatedAddressSets.every((set) => set.has(address)),
        )
      : [];
  if (
    populatedAddressSets.length === anchorCount &&
    commonAddresses.length === 0
  ) {
    recaptureReasons.push({
      code: "ADDRESS_MISMATCH",
      message:
        "各基站收到的钥匙地址不一致，禁止把不同地址拼成同步标定组",
      details: Object.fromEntries(
        perAnchor.map((anchor) => [
          `anchor${anchor.anchorId}`,
          anchor.addresses,
        ]),
      ),
    });
  }
  if (groups.length < minimumGroups) {
    recaptureReasons.push({
      code: "INSUFFICIENT_SYNCHRONIZED_SAMPLES",
      message: `仅得到${groups.length}组同步数据，需要至少${minimumGroups}组`,
    });
  }
  for (const anchor of perAnchor) {
    if (anchor.synchronizedSamples < minimumGroups) {
      recaptureReasons.push({
        code: "ANCHOR_SAMPLE_SHORTAGE",
        anchorId: anchor.anchorId,
        message:
          `基站${anchor.anchorId}有${anchor.samples}帧原始数据，` +
          `但仅进入${anchor.synchronizedSamples}组同地址同步样本`,
      });
    }
    if (anchor.spreadCm !== null && anchor.spreadCm > 10) {
      recaptureReasons.push({
        code: "ANCHOR_UNSTABLE",
        anchorId: anchor.anchorId,
        message: `基站${anchor.anchorId}波动${anchor.spreadCm.toFixed(1)}cm，建议补采`,
      });
    }
    if (anchor.snrDb !== null && anchor.snrDb < 3) {
      recaptureReasons.push({
        code: "ANCHOR_LOW_SNR",
        anchorId: anchor.anchorId,
        message: `基站${anchor.anchorId}信噪比过低`,
      });
    }
    if (anchor.residualCm !== null && Math.abs(anchor.residualCm) > 30) {
      recaptureReasons.push({
        code: "ANCHOR_GEOMETRY_RESIDUAL",
        anchorId: anchor.anchorId,
        message:
          `基站${anchor.anchorId}中位数相对几何真值偏差` +
          `${anchor.residualCm >= 0 ? "+" : ""}${anchor.residualCm.toFixed(1)}cm，超过±30cm限值`,
      });
    }
  }
  return {
    accepted: recaptureReasons.length === 0,
    synchronizedGroups: groups.length,
    inputFrames: measurements.length,
    perAnchor,
    recaptureReasons,
    geometry: {
      radialDistanceM,
      boundaryOffsetMm,
      positionRadiusM,
      angleDeg,
      keyPosition,
      anchors,
    },
  };
}

export function createCalibrationEngineAdapter(engine = {}) {
  const candidate =
    typeof engine.createCalibrationEngine === "function"
      ? engine.createCalibrationEngine()
      : engine.calibrationEngine ?? engine.default ?? engine;
  return {
    assessCapture:
      candidate.assessCapture ??
      candidate.analyzeCapture ??
      ((input) => assessCalibrationCapture(input)),
    train:
      candidate.train ??
      candidate.trainCalibration ??
      candidate.trainCalibrationModel,
    validate:
      candidate.validate ??
      candidate.validateCalibration ??
      candidate.validateCalibrationModel,
    exportFirmware:
      candidate.exportFirmware ??
      candidate.exportCalibrationModel ??
      candidate.exportMspm0C,
  };
}

export function createSerialCalibrationCaptureSource(
  serialService,
  { sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) } = {},
) {
  return {
    async capturePoint(options) {
      if (serialService.status().connected !== true) {
        throw new AppError("SERIAL_NOT_CONNECTED", "串口尚未连接", {
          status: 409,
          retryable: true,
        });
      }
      if (options.captureId) {
        const captures = await serialService.listCaptures();
        const capture = captures.find((item) => item.id === options.captureId);
        if (!capture) {
          throw new AppError("CAPTURE_NOT_FOUND", "找不到指定的历史采集", {
            status: 404,
            details: { captureId: options.captureId },
          });
        }
        return {
          captureId: capture.id,
          startedAt: capture.startedAt,
          measurements: await serialService.getCaptureMeasurements(capture.id),
        };
      }
      const capture = await serialService.startCapture({
        label: options.label,
        durationSeconds: options.durationSeconds,
      });
      await sleep(options.durationSeconds * 1000);
      await serialService.finishCapture("completed");
      return {
        captureId: capture.id,
        startedAt: capture.startedAt,
        measurements: await serialService.getCaptureMeasurements(capture.id),
      };
    },
  };
}

function inputFingerprint(input) {
  const normalize = (value) => {
    if (Array.isArray(value)) {
      return value.map(normalize);
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value)
          .filter((key) => key !== "onProgress")
          .sort()
          .map((key) => [key, normalize(value[key])]),
      );
    }
    return value;
  };
  return JSON.stringify(normalize(input));
}

export class CalibrationService {
  constructor({ captureSource, engine, clock = () => new Date() } = {}) {
    this.captureSource = captureSource;
    this.engine = createCalibrationEngineAdapter(engine);
    this.clock = clock;
    this.idempotency = new Map();
    this.captures = new Map();
    this.latestModel = null;
    this.latestValidation = null;
  }

  plan(input = {}) {
    const plan = createCalibrationPlan(input);
    plan.points = plan.points.map((point) => {
      const capture = this.captures.get(point.id);
      return capture
        ? {
            ...point,
            status: capture.accepted ? "captured" : "recapture",
            captureId: capture.captureId,
          }
        : point;
    });
    return plan;
  }

  async capture(input = {}) {
    const options = this.#captureOptions(input);
    if (input.dryRun) {
      return {
        dryRun: true,
        action: "calibration.capture",
        pointId: options.pointId,
        distanceM: options.distanceM,
        angleDeg: options.angleDeg,
        positionRadiusM:
          options.distanceM + options.boundaryOffsetMm / 1000,
        anchorCount: options.anchorCount,
        durationSeconds: options.durationSeconds,
        warmupSeconds: options.warmupSeconds,
        minimumSynchronizedGroups: options.minimumSynchronizedGroups,
        synchronizationWindowMs: options.synchronizationWindowMs,
        changesSerialState: true,
        changesFileSystem: true,
      };
    }
    return this.#once("capture", input, async () => {
      if (!this.captureSource?.capturePoint) {
        throw new AppError(
          "CALIBRATION_CAPTURE_UNAVAILABLE",
          "标定采集数据源未接线",
          { status: 503, retryable: false },
        );
      }
      const captured = await this.captureSource.capturePoint({
        ...options,
        label:
          input.label ??
          `标定-${options.distanceM.toFixed(2)}m-${options.angleDeg >= 0 ? "+" : ""}${options.angleDeg}deg`,
      });
      const warmupEnd =
        Date.parse(captured.startedAt) + options.warmupSeconds * 1000;
      const usableMeasurements = (captured.measurements ?? []).filter(
        (measurement) => Date.parse(measurement.timestamp) >= warmupEnd,
      );
      const assessment = await this.engine.assessCapture({
        ...options,
        measurements: usableMeasurements,
      });
      const result = {
        pointId: options.pointId,
        distanceM: options.distanceM,
        angleDeg: options.angleDeg,
        positionRadiusM:
          options.distanceM + options.boundaryOffsetMm / 1000,
        anchorCount: options.anchorCount,
        captureId: captured.captureId,
        capturedAt: this.clock().toISOString(),
        rawFrames: captured.measurements?.length ?? 0,
        usableFrames: usableMeasurements.length,
        ...assessment,
      };
      this.captures.set(options.pointId, result);
      return result;
    });
  }

  async train(input = {}) {
    if (input.dryRun) {
      return {
        dryRun: true,
        action: "calibration.train",
        captureCount: input.captures?.length ?? this.captures.size,
        changesModelState: true,
      };
    }
    return this.#once("train", input, async () => {
      this.#requireEngineMethod("train");
      const plan = input.plan ?? this.plan();
      const result = await this.engine.train(
        {
          plan,
          captures: input.captures ?? [...this.captures.values()],
          anchors: input.anchors ?? plan.geometry?.anchors,
          boundaryOffsetMm:
            input.boundaryOffsetMm ??
            plan.geometry?.boundaryOffsetMm ??
            DEFAULT_CALIBRATION_GEOMETRY.boundaryOffsetMm,
          options: input.options ?? {},
        },
        { onProgress: input.onProgress },
      );
      this.latestModel = result.model ?? result;
      return result;
    });
  }

  async validate(input = {}) {
    if (input.dryRun) {
      return {
        dryRun: true,
        action: "calibration.validate",
        hasModel: Boolean(input.model ?? this.latestModel),
        changesModelState: false,
      };
    }
    return this.#once("validate", input, async () => {
      this.#requireEngineMethod("validate");
      const result = await this.engine.validate(
        {
          model: input.model ?? this.latestModel,
          captures: input.captures ?? [...this.captures.values()],
          validationPoints: input.validationPoints ?? [],
          limits: {
            distanceMaxErrorM: 0.3,
            angleMaxErrorDeg: 10,
            boundaryMaxErrorM: 0.2,
            ...(input.limits ?? {}),
          },
        },
        { onProgress: input.onProgress },
      );
      this.latestValidation = result;
      return result;
    });
  }

  async export(input = {}) {
    if (input.dryRun) {
      return {
        dryRun: true,
        action: "calibration.export",
        format: input.format ?? "mspm0-c",
        hasModel: Boolean(input.model ?? this.latestModel),
        changesFileSystem: false,
      };
    }
    return this.#once("export", input, async () => {
      this.#requireEngineMethod("exportFirmware");
      return this.engine.exportFirmware(
        {
          model: input.model ?? this.latestModel,
          name: input.name ?? "calibration_model_data",
          target: input.target ?? "MSPM0G3507",
        },
        { onProgress: input.onProgress },
      );
    });
  }

  #captureOptions(input) {
    const distanceM = finiteNumber(input.distanceM, "distanceM");
    const angleDeg = finiteNumber(input.angleDeg, "angleDeg");
    if (distanceM < 0.3 || distanceM > 3.5) {
      throw new AppError("VALIDATION_ERROR", "distanceM必须在0.3～3.5m内");
    }
    if (angleDeg < -45 || angleDeg > 45) {
      throw new AppError("VALIDATION_ERROR", "angleDeg必须在-45°～45°内");
    }
    return {
      pointId: input.pointId ?? calibrationPointId(distanceM, angleDeg),
      distanceM,
      angleDeg,
      boundaryOffsetMm: finiteNumber(
        input.boundaryOffsetMm ??
          DEFAULT_CALIBRATION_GEOMETRY.boundaryOffsetMm,
        "boundaryOffsetMm",
      ),
      anchorCount: integerInRange(input.anchorCount ?? 2, 2, 4, "anchorCount"),
      anchors: Array.isArray(input.anchors)
        ? structuredClone(input.anchors)
        : DEFAULT_ANCHOR_COORDINATES.slice(
            0,
            integerInRange(input.anchorCount ?? 2, 2, 4, "anchorCount"),
          ),
      captureId:
        input.captureId === undefined ? null : String(input.captureId).trim(),
      durationSeconds: integerInRange(
        input.durationSeconds ?? DEFAULT_CAPTURE_OPTIONS.durationSeconds,
        1,
        3600,
        "durationSeconds",
      ),
      warmupSeconds: integerInRange(
        input.warmupSeconds ?? DEFAULT_CAPTURE_OPTIONS.warmupSeconds,
        0,
        3600,
        "warmupSeconds",
      ),
      minimumSynchronizedGroups: integerInRange(
        input.minimumSynchronizedGroups ??
          DEFAULT_CAPTURE_OPTIONS.minimumSynchronizedGroups,
        1,
        100000,
        "minimumSynchronizedGroups",
      ),
      synchronizationWindowMs: integerInRange(
        input.synchronizationWindowMs ??
          DEFAULT_CAPTURE_OPTIONS.synchronizationWindowMs,
        1,
        5000,
        "synchronizationWindowMs",
      ),
    };
  }

  #requireEngineMethod(name) {
    if (typeof this.engine[name] !== "function") {
      throw new AppError(
        "CALIBRATION_ENGINE_UNAVAILABLE",
        `标定算法引擎尚未提供 ${name} 接口`,
        {
          status: 503,
          retryable: false,
          details: {
            requiredInterface: [
              "assessCapture(input)",
              "train(input, context)",
              "validate(input, context)",
              "exportFirmware(input, context)",
            ],
          },
        },
      );
    }
  }

  async #once(action, input, operation) {
    const idempotencyKey = String(input.idempotencyKey ?? "").trim();
    if (!idempotencyKey) {
      return operation();
    }
    const key = `${action}:${idempotencyKey}`;
    const fingerprint = inputFingerprint(input);
    const existing = this.idempotency.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new AppError(
          "IDEMPOTENCY_CONFLICT",
          "同一幂等键不能用于不同的标定请求",
          {
            status: 409,
            details: { action, idempotencyKey },
          },
        );
      }
      return existing.promise;
    }
    const promise = Promise.resolve().then(operation);
    this.idempotency.set(key, { fingerprint, promise });
    try {
      return await promise;
    } catch (error) {
      this.idempotency.delete(key);
      throw error;
    }
  }
}
