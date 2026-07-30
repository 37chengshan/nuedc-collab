import {
  CALIBRATION_ANGLES_DEG,
  CALIBRATION_RADII_MM,
  validateAnchorConfig,
} from "./calibration-plan.js";
import { deepClone, finiteNumber } from "./utils.js";

const MODEL_VERSION = 1;
const MAX_ANCHORS = 4;
const MAX_KNOTS = 12;
const DISTANCE_COUNT = 11;
const ANGLE_COUNT = 7;
const FIRMWARE_MODEL_MAGIC = 0x31574255;
const FIRMWARE_MODEL_VERSION = 0x0100;
const FIRMWARE_MODEL_SIZE_BYTES = 900;
const FIRMWARE_CRC_COVERED_SIZE = 896;
const FIRMWARE_DISTANCE_GRID_FLAG = 0x00000001;
const FIRMWARE_ANGLE_GRID_FLAG = 0x00000002;

export function crc32(input) {
  const bytes =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : input instanceof Uint8Array
        ? input
        : new Uint8Array(input);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return ((crc ^ 0xffffffff) >>> 0)
    .toString(16)
    .toUpperCase()
    .padStart(8, "0");
}

export function createCalibrationModelV1(input = {}) {
  const config = validateAnchorConfig({
    anchors: input.anchors,
    radialZeroOffsetMm: input.radialZeroOffsetMm ?? 300,
  });
  const rangeModels = {};
  for (const anchor of config.anchors) {
    const model = input.rangeModels?.[anchor.id];
    if (!model) {
      throw new TypeError(`缺少锚点 ${anchor.id} 的测距模型`);
    }
    rangeModels[anchor.id] = normalizeRangeModel(model, anchor.id);
  }
  const compensationTable = normalizeCompensationTable(
    input.compensationTable,
  );
  const processNoise = finiteNumber(
    input.kalman?.processNoise ?? 2,
    "kalman.processNoise",
  );
  const measurementNoise = finiteNumber(
    input.kalman?.measurementNoise ?? 25,
    "kalman.measurementNoise",
  );
  const initialCovariance = finiteNumber(
    input.kalman?.initialCovariance ?? 1000,
    "kalman.initialCovariance",
  );
  const positionP95Mm = finiteNumber(
    input.metrics?.positionP95Mm ?? input.metrics?.distanceP95Mm ?? 0,
    "metrics.positionP95Mm",
  );
  const bearingP95Cdeg = Math.round(
    finiteNumber(
      input.metrics?.bearingP95Cdeg ??
        Number(input.metrics?.bearingP95Deg ?? 0) * 100,
      "metrics.bearingP95Cdeg",
    ),
  );
  const model = {
    version: MODEL_VERSION,
    coordinateSystem: {
      origin: "cylinder-center",
      frontAxis: "+y",
      rightAxis: "+x",
      bearingZeroAxis: "+y",
      bearingPositive: "right",
      bearingRangeDeg: [-45, 45],
      radialZeroOffsetMm: config.radialZeroOffsetMm,
      distanceOutput: "boundary",
    },
    anchors: config.anchors,
    rangeModels,
    compensationTable,
    kalman: {
      processNoise,
      measurementNoise,
      initialCovariance,
      processNoisePosition: finiteNumber(
        input.kalman?.processNoisePosition ?? processNoise,
        "kalman.processNoisePosition",
      ),
      processNoiseVelocity: finiteNumber(
        input.kalman?.processNoiseVelocity ?? processNoise * 4,
        "kalman.processNoiseVelocity",
      ),
      measurementNoisePosition: finiteNumber(
        input.kalman?.measurementNoisePosition ?? measurementNoise,
        "kalman.measurementNoisePosition",
      ),
      initialPositionVariance: finiteNumber(
        input.kalman?.initialPositionVariance ?? initialCovariance,
        "kalman.initialPositionVariance",
      ),
      initialVelocityVariance: finiteNumber(
        input.kalman?.initialVelocityVariance ?? initialCovariance * 4,
        "kalman.initialVelocityVariance",
      ),
      maxDtS: finiteNumber(input.kalman?.maxDtS ?? 0.5, "kalman.maxDtS"),
      huberDeltaMm: finiteNumber(
        input.kalman?.huberDeltaMm ?? 150,
        "kalman.huberDeltaMm",
      ),
      nlosThresholdMm: finiteNumber(
        input.kalman?.nlosThresholdMm ?? 180,
        "kalman.nlosThresholdMm",
      ),
    },
    metrics: {
      rangeCvRmseMm: finiteNumber(
        input.metrics?.rangeCvRmseMm ?? 0,
        "metrics.rangeCvRmseMm",
      ),
      positionP95Mm,
      distanceP95Mm: finiteNumber(
        input.metrics?.distanceP95Mm ?? positionP95Mm,
        "metrics.distanceP95Mm",
      ),
      distanceMaxMm: finiteNumber(
        input.metrics?.distanceMaxMm ?? 0,
        "metrics.distanceMaxMm",
      ),
      bearingP95Cdeg,
      bearingP95Deg: finiteNumber(
        input.metrics?.bearingP95Deg ?? bearingP95Cdeg / 100,
        "metrics.bearingP95Deg",
      ),
      bearingMaxDeg: finiteNumber(
        input.metrics?.bearingMaxDeg ?? 0,
        "metrics.bearingMaxDeg",
      ),
      boundaryP95Mm: finiteNumber(
        input.metrics?.boundaryP95Mm ?? positionP95Mm,
        "metrics.boundaryP95Mm",
      ),
      synchronizedGroups: Math.max(
        0,
        Math.round(
          finiteNumber(
            input.metrics?.synchronizedGroups ?? 0,
            "metrics.synchronizedGroups",
          ),
        ),
      ),
    },
    metadata: deepClone(input.metadata ?? {}),
  };
  model.crc32 = crc32(serializePayload(model));
  return model;
}

export function serializeCalibrationModel(model) {
  return stableStringify(model);
}

export function validateModel(model) {
  const errors = [];
  if (!model || typeof model !== "object") {
    return { valid: false, errors: ["模型为空"] };
  }
  if (model.version !== MODEL_VERSION) {
    errors.push(`模型版本必须为 ${MODEL_VERSION}`);
  }
  if (
    !Array.isArray(model.anchors) ||
    model.anchors.length < 2 ||
    model.anchors.length > MAX_ANCHORS
  ) {
    errors.push("锚点数量必须为 2～4");
  }
  for (const anchor of model.anchors ?? []) {
    if (!model.rangeModels?.[anchor.id]) {
      errors.push(`缺少锚点 ${anchor.id} 的测距模型`);
    }
  }
  if (
    model.compensationTable?.boundaryDistancesMm?.length !== DISTANCE_COUNT ||
    model.compensationTable?.anglesCdeg?.length !== ANGLE_COUNT
  ) {
    errors.push("补偿表轴长度必须为 11×7");
  }
  const expectedCrc = crc32(serializePayload(model));
  if (String(model.crc32 ?? "").toUpperCase() !== expectedCrc) {
    errors.push(`CRC 校验失败，期望 ${expectedCrc}`);
  }
  return { valid: errors.length === 0, errors, expectedCrc };
}

export function exportCalibrationModelC(
  model,
  {
    symbol = "g_uwb_calibration_model",
    headerName = "uwb_calibration_model.h",
    includeAuditJson = false,
  } = {},
) {
  const validation = validateModel(model);
  if (!validation.valid) {
    throw new TypeError(`不能导出无效模型：${validation.errors.join("；")}`);
  }
  const safeSymbol = sanitizeIdentifier(symbol);
  const guard = `${sanitizeIdentifier(headerName).toUpperCase()}_INCLUDED`;
  const typedBytes = encodeTypedModel(model);
  const firmwareCrc32 = crc32(typedBytes);
  const auditJson = serializeCalibrationModel(model);
  const header = renderHeader({
    guard,
    symbol: safeSymbol,
    includeAuditJson,
  });
  const source = renderSource({
    model,
    symbol: safeSymbol,
    headerName,
    firmwareCrc32,
    auditJson,
    includeAuditJson,
  });
  return {
    header,
    source,
    auditJson,
    firmwareCrc32,
    modelSizeBytes: FIRMWARE_MODEL_SIZE_BYTES,
  };
}

function normalizeRangeModel(model, anchorId) {
  const domainMm = [
    finiteNumber(model.domainMm?.[0] ?? 300, `${anchorId}.domainMm[0]`),
    finiteNumber(model.domainMm?.[1] ?? 3500, `${anchorId}.domainMm[1]`),
  ];
  if (model.type === "linear" || model.type === "quadratic") {
    const required = model.type === "linear" ? 2 : 3;
    if (!Array.isArray(model.coefficients) || model.coefficients.length < required) {
      throw new TypeError(`${anchorId} 的 ${model.type} 系数不足`);
    }
    return {
      type: model.type,
      coefficients: model.coefficients
        .slice(0, required)
        .map((value, index) =>
          finiteNumber(value, `${anchorId}.coefficients[${index}]`),
        ),
      domainMm,
      ...(model.cv ? { cv: deepClone(model.cv) } : {}),
      ...(model.candidateScores
        ? { candidateScores: deepClone(model.candidateScores) }
        : {}),
    };
  }
  if (model.type === "piecewise-linear") {
    if (
      !Array.isArray(model.rawKnotsMm) ||
      !Array.isArray(model.correctedKnotsMm) ||
      model.rawKnotsMm.length < 2 ||
      model.rawKnotsMm.length !== model.correctedKnotsMm.length ||
      model.rawKnotsMm.length > MAX_KNOTS
    ) {
      throw new TypeError(`${anchorId} 的单调分段模型节点无效`);
    }
    return {
      type: model.type,
      rawKnotsMm: model.rawKnotsMm.map((value, index) =>
        finiteNumber(value, `${anchorId}.rawKnotsMm[${index}]`),
      ),
      correctedKnotsMm: model.correctedKnotsMm.map((value, index) =>
        finiteNumber(value, `${anchorId}.correctedKnotsMm[${index}]`),
      ),
      domainMm,
      ...(model.cv ? { cv: deepClone(model.cv) } : {}),
      ...(model.candidateScores
        ? { candidateScores: deepClone(model.candidateScores) }
        : {}),
    };
  }
  throw new TypeError(`${anchorId} 的测距模型类型无效`);
}

function normalizeCompensationTable(table) {
  if (!table) {
    throw new TypeError("缺少距离/角度补偿表");
  }
  const distances = table.boundaryDistancesMm?.map(Number);
  const angles = table.anglesCdeg?.map(Number);
  if (distances?.length !== DISTANCE_COUNT || angles?.length !== ANGLE_COUNT) {
    throw new RangeError("补偿表必须为 11×7");
  }
  return {
    boundaryDistancesMm: distances.map((value) => Math.round(value)),
    anglesCdeg: angles.map((value) => Math.round(value)),
    boundaryDistanceCorrectionsMm: normalizeGrid(
      table.boundaryDistanceCorrectionsMm,
      "boundaryDistanceCorrectionsMm",
    ),
    angleCorrectionsCdeg: normalizeGrid(
      table.angleCorrectionsCdeg,
      "angleCorrectionsCdeg",
    ),
  };
}

function normalizeGrid(grid, label) {
  if (
    !Array.isArray(grid) ||
    grid.length !== DISTANCE_COUNT ||
    grid.some((row) => !Array.isArray(row) || row.length !== ANGLE_COUNT)
  ) {
    throw new RangeError(`${label} 必须为 11×7`);
  }
  return grid.map((row, rowIndex) =>
    row.map((value, columnIndex) => {
      const number = Math.round(
        finiteNumber(value, `${label}[${rowIndex}][${columnIndex}]`),
      );
      if (number < -32768 || number > 32767) {
        throw new RangeError(`${label} 超出 int16 范围`);
      }
      return number;
    }),
  );
}

function serializePayload(model) {
  const payload = deepClone(model);
  delete payload.crc32;
  return stableStringify(payload);
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function renderHeader({ guard, symbol, includeAuditJson }) {
  return `#ifndef ${guard}
#define ${guard}

#include "calibration_model.h"

_Static_assert(sizeof(CalibrationModelV1) ==
                   CALIBRATION_MODEL_V1_SERIALIZED_SIZE,
               "CalibrationModelV1 ABI mismatch");

extern const CalibrationModelV1 ${symbol};
${includeAuditJson ? `extern const char ${symbol}_audit_json[];\n` : ""}
#endif
`;
}

function renderSource({
  model,
  symbol,
  headerName,
  firmwareCrc32,
  auditJson,
  includeAuditJson,
}) {
  const anchors = Array.from({ length: MAX_ANCHORS }, (_, index) => {
    const anchor = model.anchors[index];
    return anchor
      ? `{ ${floatLiteral(anchor.xMm)}, ${floatLiteral(anchor.yMm)} }`
      : "{ 0.0f, 0.0f }";
  });
  const rangeModels = Array.from({ length: MAX_ANCHORS }, (_, index) =>
    renderRangeModel(
      index < model.anchors.length
        ? model.rangeModels[model.anchors[index].id]
        : null,
    ),
  );
  const radial = model.compensationTable.boundaryDistanceCorrectionsMm.flat();
  const bearing = model.compensationTable.angleCorrectionsCdeg.flat();
  const enabledAnchorMask = (1 << model.anchors.length) - 1;
  const source = `#include "${headerName}"

const CalibrationModelV1 ${symbol} = {
    .magic = CALIBRATION_MODEL_V1_MAGIC,
    .version = CALIBRATION_MODEL_V1_VERSION,
    .model_size_bytes = CALIBRATION_MODEL_V1_SERIALIZED_SIZE,
    .anchor_count = ${model.anchors.length}U,
    .enabled_anchor_mask = 0x${enabledAnchorMask
      .toString(16)
      .toUpperCase()
      .padStart(2, "0")}U,
    .distance_axis_count = CALIBRATION_DISTANCE_AXIS_CAPACITY,
    .angle_axis_count = CALIBRATION_ANGLE_AXIS_CAPACITY,
    .flags = CALIBRATION_MODEL_FLAG_DISTANCE_GRID |
             CALIBRATION_MODEL_FLAG_ANGLE_GRID,
    .anchors = {
${anchors.map((value) => `        ${value}`).join(",\n")}
    },
    .range_models = {
${rangeModels.map((value) => indent(value, 8)).join(",\n")}
    },
    .distance_axis_mm = ${cArray(model.compensationTable.boundaryDistancesMm, 8)},
    .angle_axis_cdeg = ${cArray(model.compensationTable.anglesCdeg, 8)},
    .radial_correction_mm = ${cArray(radial, 10)},
    .bearing_correction_cdeg = ${cArray(bearing, 10)},
    .kalman = {
        .process_noise_position = ${floatLiteral(model.kalman.processNoisePosition)},
        .process_noise_velocity = ${floatLiteral(model.kalman.processNoiseVelocity)},
        .measurement_noise_position = ${floatLiteral(model.kalman.measurementNoisePosition)},
        .initial_position_variance = ${floatLiteral(model.kalman.initialPositionVariance)},
        .initial_velocity_variance = ${floatLiteral(model.kalman.initialVelocityVariance)},
        .max_dt_s = ${floatLiteral(model.kalman.maxDtS)},
        .huber_delta_mm = ${floatLiteral(model.kalman.huberDeltaMm)},
        .nlos_threshold_mm = ${floatLiteral(model.kalman.nlosThresholdMm)}
    },
    .validation = {
        .distance_p95_mm = ${floatLiteral(model.metrics.distanceP95Mm)},
        .distance_max_mm = ${floatLiteral(model.metrics.distanceMaxMm)},
        .bearing_p95_deg = ${floatLiteral(model.metrics.bearingP95Deg)},
        .bearing_max_deg = ${floatLiteral(model.metrics.bearingMaxDeg)},
        .boundary_p95_mm = ${floatLiteral(model.metrics.boundaryP95Mm)},
        .reserved = 0.0f
    },
    .crc32 = 0x${firmwareCrc32}U
};
`;
  if (!includeAuditJson) {
    return source;
  }
  return `${source}
const char ${symbol}_audit_json[] = ${JSON.stringify(auditJson)};
`;
}

function renderRangeModel(model) {
  if (!model) {
    return `{
    .type = CALIBRATION_RANGE_LINEAR,
    .knot_count = 0U,
    .reserved = 0U,
    .coefficients = { 0.0f, 1.0f, 0.0f },
    .raw_knots_mm = { 0.0f },
    .corrected_knots_mm = { 0.0f }
}`;
  }
  const coefficients =
    model.type === "linear"
      ? [model.coefficients[0], model.coefficients[1], 0]
      : model.type === "quadratic"
        ? model.coefficients
        : [0, 0, 0];
  const raw = pad(model.rawKnotsMm ?? [], MAX_KNOTS, 0);
  const corrected = pad(model.correctedKnotsMm ?? [], MAX_KNOTS, 0);
  const type = {
    linear: "CALIBRATION_RANGE_LINEAR",
    quadratic: "CALIBRATION_RANGE_QUADRATIC",
    "piecewise-linear": "CALIBRATION_RANGE_MONOTONIC_PWL",
  }[model.type];
  return `{
    .type = ${type},
    .knot_count = ${(model.rawKnotsMm?.length ?? 0)}U,
    .reserved = 0U,
    .coefficients = ${cArray(coefficients.map(floatLiteral), 6, false)},
    .raw_knots_mm = ${cArray(raw.map(floatLiteral), 6, false)},
    .corrected_knots_mm = ${cArray(corrected.map(floatLiteral), 6, false)}
}`;
}

function encodeTypedModel(model) {
  const bytes = [];
  const pushU8 = (value) => bytes.push(value & 0xff);
  const pushU16 = (value) => {
    pushU8(value);
    pushU8(value >>> 8);
  };
  const pushI16 = (value) => pushU16(value & 0xffff);
  const pushU32 = (value) => {
    pushU8(value);
    pushU8(value >>> 8);
    pushU8(value >>> 16);
    pushU8(value >>> 24);
  };
  const pushF32 = (value) => {
    const buffer = new ArrayBuffer(4);
    new DataView(buffer).setFloat32(0, Number(value), true);
    bytes.push(...new Uint8Array(buffer));
  };

  const enabledAnchorMask = (1 << model.anchors.length) - 1;
  pushU32(FIRMWARE_MODEL_MAGIC);
  pushU16(FIRMWARE_MODEL_VERSION);
  pushU16(FIRMWARE_MODEL_SIZE_BYTES);
  pushU8(model.anchors.length);
  pushU8(enabledAnchorMask);
  pushU8(DISTANCE_COUNT);
  pushU8(ANGLE_COUNT);
  pushU32(FIRMWARE_DISTANCE_GRID_FLAG | FIRMWARE_ANGLE_GRID_FLAG);
  for (let index = 0; index < MAX_ANCHORS; index += 1) {
    const anchor = model.anchors[index];
    pushF32(anchor?.xMm ?? 0);
    pushF32(anchor?.yMm ?? 0);
  }
  for (let index = 0; index < MAX_ANCHORS; index += 1) {
    const range =
      index < model.anchors.length
        ? model.rangeModels[model.anchors[index].id]
        : null;
    const type = range
      ? { linear: 1, quadratic: 2, "piecewise-linear": 3 }[range.type]
      : 1;
    const coefficients =
      range?.type === "linear"
        ? [range.coefficients[0], range.coefficients[1], 0]
        : range?.type === "quadratic"
          ? range.coefficients
          : range
            ? [0, 0, 0]
            : [0, 1, 0];
    pushU8(type);
    pushU8(range?.rawKnotsMm?.length ?? 0);
    pushU16(0);
    coefficients.forEach(pushF32);
    pad(range?.rawKnotsMm ?? [], MAX_KNOTS, 0).forEach(pushF32);
    pad(range?.correctedKnotsMm ?? [], MAX_KNOTS, 0).forEach(pushF32);
  }
  model.compensationTable.boundaryDistancesMm.forEach(pushU16);
  model.compensationTable.anglesCdeg.forEach(pushI16);
  model.compensationTable.boundaryDistanceCorrectionsMm
    .flat()
    .forEach(pushI16);
  model.compensationTable.angleCorrectionsCdeg.flat().forEach(pushI16);
  pushF32(model.kalman.processNoisePosition);
  pushF32(model.kalman.processNoiseVelocity);
  pushF32(model.kalman.measurementNoisePosition);
  pushF32(model.kalman.initialPositionVariance);
  pushF32(model.kalman.initialVelocityVariance);
  pushF32(model.kalman.maxDtS);
  pushF32(model.kalman.huberDeltaMm);
  pushF32(model.kalman.nlosThresholdMm);
  pushF32(model.metrics.distanceP95Mm);
  pushF32(model.metrics.distanceMaxMm);
  pushF32(model.metrics.bearingP95Deg);
  pushF32(model.metrics.bearingMaxDeg);
  pushF32(model.metrics.boundaryP95Mm);
  pushF32(0);

  if (bytes.length !== FIRMWARE_CRC_COVERED_SIZE) {
    throw new Error(
      `CalibrationModelV1 ABI 编码长度错误：${bytes.length}，期望 ${FIRMWARE_CRC_COVERED_SIZE}`,
    );
  }
  return Uint8Array.from(bytes);
}

function sanitizeIdentifier(value) {
  const normalized = String(value).replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(normalized) ? normalized : `_${normalized}`;
}

function floatLiteral(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError("C 导出遇到非有限浮点数");
  }
  if (Number.isInteger(number)) {
    return `${number}.0f`;
  }
  return `${Number(number.toPrecision(9))}f`;
}

function cArray(values, perLine = 8, rawValues = true) {
  const rendered = values.map((value) =>
    rawValues ? String(Math.round(Number(value))) : String(value),
  );
  if (rendered.length <= perLine) {
    return `{ ${rendered.join(", ")} }`;
  }
  const lines = [];
  for (let index = 0; index < rendered.length; index += perLine) {
    lines.push(`        ${rendered.slice(index, index + perLine).join(", ")}`);
  }
  return `{\n${lines.join(",\n")}\n    }`;
}

function pad(values, length, fill) {
  return Array.from({ length }, (_, index) => values[index] ?? fill);
}

function indent(text, spaces) {
  const prefix = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
