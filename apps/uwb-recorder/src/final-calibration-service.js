import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  estimateSparseRealtime,
  hampelFilter,
  parseSparseCalibrationLabel,
  trainSparseRealtimeModel,
} from "../../../packages/uwb-localization/src/index.js";

const EMPIRICAL_MODEL_V1_MAGIC = 0x314d5045;
const EMPIRICAL_MODEL_V1_VERSION = 0x0100;
const EMPIRICAL_PROTOTYPE_ANGLE_VALID = 0x01;
const DISTANCE_NEIGHBOR_COUNT = 6;
const ANGLE_NEIGHBOR_COUNT = 4;
const ANGLE_MAX_NEIGHBOR_DISTANCE = 0.75;
const ANGLE_MAX_SPREAD_DEG = 20;

export async function createFinalCalibrationService({
  capturesDirectory,
  measurementSource = null,
  warmupSeconds = 2,
} = {}) {
  if (!capturesDirectory) {
    throw new TypeError("capturesDirectory 不能为空");
  }
  const loaded = await loadFinalCaptures(capturesDirectory, {
    warmupSeconds,
  });
  const model = trainSparseRealtimeModel(loaded.samples);
  const validationMetrics = validateSparseRealtimeModel(
    model,
    loaded.validationSamples,
  );

  return {
    status() {
      return {
        ready: true,
        dataset: loaded.dataset,
        structuredTrainingPointCount: loaded.structuredTrainingPointCount,
        legacyTrainingPointCount: loaded.legacyTrainingPointCount,
        mode: model.mode,
        source: "final-captures",
        captureCount: loaded.samples.length,
        validationPointCount: loaded.validationSamples.length,
        ignoredCaptureCount: loaded.ignored.length,
        ignoredCaptures: loaded.ignored,
        calibratedRangeM: model.calibratedRangeM,
        calibratedAngleDeg: model.calibratedAngleDeg,
        metrics: {
          distanceValidationMode: model.metrics.distanceValidationMode,
          trainingPointCount: model.metrics.trainingPointCount,
          anglePointCount: model.metrics.anglePointCount,
          distanceMaxErrorM: model.metrics.distanceMaxErrorM,
          distanceP95M: model.metrics.distanceP95M,
          angleMaxErrorDeg: model.metrics.angleMaxErrorDeg,
          angleP95Deg: model.metrics.angleP95Deg,
        },
        validationMetrics,
        rangeKnots: model.rangeKnots,
      };
    },

    estimate(measurements) {
      const anchors = summarizeRecentMeasurements(measurements);
      const estimate = estimateSparseRealtime(model, { anchors });
      return {
        ...estimate,
        source: "final-captures",
        sampleCount: anchors.reduce(
          (sum, anchor) => sum + anchor.sampleCount,
          0,
        ),
        anchors,
      };
    },

    async estimateLatest() {
      if (typeof measurementSource !== "function") {
        return {
          valid: false,
          source: "final-captures",
          reason: "串口实时数据源尚未接入",
        };
      }
      const measurements = await measurementSource({
        limit: 80,
      });
      return this.estimate(measurements);
    },

    exportFirmware(input = {}) {
      return exportEmpiricalFirmware(model, loaded, input);
    },

    model,
  };
}

function exportEmpiricalFirmware(model, loaded, input = {}) {
  const name = sanitizeCIdentifier(input.name ?? "empirical_model_data");
  const prototypes = buildEmpiricalPrototypes(model);
  if (prototypes.length > 96) {
    throw new RangeError("地猛星经验模型最多支持 96 个训练原型");
  }

  const firmwareModel = {
    magic: EMPIRICAL_MODEL_V1_MAGIC,
    version: EMPIRICAL_MODEL_V1_VERSION,
    prototypeCount: prototypes.length,
    distanceNeighborCount: Math.min(
      DISTANCE_NEIGHBOR_COUNT,
      prototypes.length,
    ),
    angleNeighborCount: Math.min(
      ANGLE_NEIGHBOR_COUNT,
      prototypes.filter(
        (prototype) =>
          (prototype.flags & EMPIRICAL_PROTOTYPE_ANGLE_VALID) !== 0,
      ).length,
    ),
    distance1ScaleMm: Math.fround(model.featureScales?.[0] ?? 1),
    distance2ScaleMm: Math.fround(model.featureScales?.[1] ?? 1),
    angleMaxNeighborDistance: Math.fround(ANGLE_MAX_NEIGHBOR_DISTANCE),
    angleMaxSpreadDeg: Math.fround(ANGLE_MAX_SPREAD_DEG),
    prototypes,
  };
  if (firmwareModel.angleNeighborCount === 0) {
    throw new RangeError("没有可导出的角度训练点");
  }
  const crc32 = computeEmpiricalModelCrc(firmwareModel);
  const headerFileName = `${name}.h`;
  const sourceFileName = `${name}.c`;
  const headerGuard = `${name.toUpperCase()}_H`;
  const symbolName = "g_empirical_model_v1";
  const prototypeSymbol = `${name}_prototypes`;

  const header = [
    `#ifndef ${headerGuard}`,
    `#define ${headerGuard}`,
    "",
    '#include "empirical_model.h"',
    "",
    `extern const EmpiricalModelV1 ${symbolName};`,
    "",
    `#endif`,
    "",
  ].join("\n");
  const prototypeRows = prototypes.map(
    (prototype) =>
      `    {${prototype.distance1Mm}U, ${prototype.distance2Mm}U, ` +
      `${prototype.radialMm}U, ${prototype.bearingCdeg}, ` +
      `${prototype.flags}U, 0U},`,
  );
  const source = [
    `#include "${headerFileName}"`,
    "",
    "/*",
    " * 由 UWB Lab 最终标定数据自动生成，请勿手工修改。",
    ` * 训练点总数: ${prototypes.length}`,
    ` * 旧数据: ${loaded.legacyTrainingPointCount}`,
    ` * 新结构化数据: ${loaded.structuredTrainingPointCount}`,
    " */",
    `static const EmpiricalPrototypeV1 ${prototypeSymbol}[] = {`,
    ...prototypeRows,
    "};",
    "",
    `const EmpiricalModelV1 ${symbolName} = {`,
    "    .magic = EMPIRICAL_MODEL_V1_MAGIC,",
    "    .version = EMPIRICAL_MODEL_V1_VERSION,",
    `    .prototype_count = ${firmwareModel.prototypeCount}U,`,
    `    .distance_neighbor_count = ${firmwareModel.distanceNeighborCount}U,`,
    `    .angle_neighbor_count = ${firmwareModel.angleNeighborCount}U,`,
    "    .reserved = 0U,",
    `    .distance1_scale_mm = ${cFloat(firmwareModel.distance1ScaleMm)},`,
    `    .distance2_scale_mm = ${cFloat(firmwareModel.distance2ScaleMm)},`,
    `    .angle_max_neighbor_distance = ${cFloat(
      firmwareModel.angleMaxNeighborDistance,
    )},`,
    `    .angle_max_spread_deg = ${cFloat(
      firmwareModel.angleMaxSpreadDeg,
    )},`,
    `    .prototypes = ${prototypeSymbol},`,
    `    .crc32 = 0x${hex32(crc32)}UL,`,
    "};",
    "",
  ].join("\n");

  return {
    name,
    target: "MSPM0G3507",
    modelType: "EmpiricalModelV1",
    prototypeCount: prototypes.length,
    anglePrototypeCount: prototypes.filter(
      (prototype) =>
        (prototype.flags & EMPIRICAL_PROTOTYPE_ANGLE_VALID) !== 0,
    ).length,
    legacyTrainingPointCount: loaded.legacyTrainingPointCount,
    structuredTrainingPointCount: loaded.structuredTrainingPointCount,
    distanceNeighborCount: firmwareModel.distanceNeighborCount,
    angleNeighborCount: firmwareModel.angleNeighborCount,
    firmwareCrc32: hex32(crc32),
    serializedModelBytes: 32 + prototypes.length * 10,
    headerFileName,
    sourceFileName,
    header,
    source,
  };
}

function buildEmpiricalPrototypes(model) {
  const angleBySampleId = new Map(
    (model.anglePrototypes ?? []).map((prototype) => [
      prototype.sampleId,
      prototype,
    ]),
  );
  const scale1 = Number(model.featureScales?.[0] ?? 1);
  const scale2 = Number(model.featureScales?.[1] ?? 1);
  return (model.distancePrototypes ?? []).map((prototype) => {
    const anglePrototype = angleBySampleId.get(prototype.sampleId);
    const angleValid = Number.isFinite(anglePrototype?.angleDeg);
    return {
      distance1Mm: uint16(Math.round(Number(prototype.features?.[0]) * scale1)),
      distance2Mm: uint16(Math.round(Number(prototype.features?.[1]) * scale2)),
      radialMm: uint16(Math.round(Number(prototype.distanceM) * 1000)),
      bearingCdeg: angleValid
        ? int16(Math.round(Number(anglePrototype.angleDeg) * 100))
        : 0,
      flags: angleValid ? EMPIRICAL_PROTOTYPE_ANGLE_VALID : 0,
    };
  });
}

function computeEmpiricalModelCrc(model) {
  let crc = 0xffffffff;
  const byte = (value) => {
    crc ^= value & 0xff;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) !== 0 ? 0xedb88320 : 0);
    }
  };
  const u16 = (value) => {
    byte(value);
    byte(value >>> 8);
  };
  const u32 = (value) => {
    byte(value);
    byte(value >>> 8);
    byte(value >>> 16);
    byte(value >>> 24);
  };
  const float32 = (value) => {
    const buffer = new ArrayBuffer(4);
    const view = new DataView(buffer);
    view.setFloat32(0, Math.fround(value), true);
    u32(view.getUint32(0, true));
  };

  u32(model.magic);
  u16(model.version);
  u16(model.prototypeCount);
  byte(model.distanceNeighborCount);
  byte(model.angleNeighborCount);
  u16(0);
  float32(model.distance1ScaleMm);
  float32(model.distance2ScaleMm);
  float32(model.angleMaxNeighborDistance);
  float32(model.angleMaxSpreadDeg);
  for (const prototype of model.prototypes) {
    u16(prototype.distance1Mm);
    u16(prototype.distance2Mm);
    u16(prototype.radialMm);
    u16(prototype.bearingCdeg & 0xffff);
    byte(prototype.flags);
    byte(0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function sanitizeCIdentifier(value) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/^([^A-Za-z_])/, "_$1");
  return normalized || "empirical_model_data";
}

function cFloat(value) {
  return `${Math.fround(value).toPrecision(9)}f`;
}

function hex32(value) {
  return (value >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

function uint16(value) {
  return Math.max(0, Math.min(0xffff, value));
}

function int16(value) {
  return Math.max(-0x8000, Math.min(0x7fff, value));
}

async function loadFinalCaptures(capturesDirectory, { warmupSeconds }) {
  const entries = await readdir(capturesDirectory, { withFileTypes: true });
  const metaNames = entries
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(".meta.json"),
    )
    .map((entry) => entry.name)
    .sort();
  const metadata = [];
  for (const metaName of metaNames) {
    const meta = JSON.parse(
      await readFile(join(capturesDirectory, metaName), "utf8"),
    );
    metadata.push({
      metaName,
      meta,
      target: parseSparseCalibrationLabel(meta.label),
    });
  }

  const structured = metadata.filter((entry) => entry.target?.dataset);
  const legacy = metadata.filter(
    (entry) => entry.target && !entry.target.dataset,
  );
  const selectedDataset =
    structured.length > 0 && legacy.length > 0
      ? "combined-legacy-and-2026-07-31-grid"
      : structured.length > 0
        ? structured[0].target.dataset
        : "legacy";
  const candidates = metadata.filter((entry) => entry.target);
  const samples = [];
  const validationSamples = [];
  const ignored = [];

  for (const entry of metadata) {
    if (!entry.target) {
      ignored.push({
        captureId: entry.meta.id,
        label: entry.meta.label,
        reason: "标签无法识别",
      });
    }
  }

  const latestByLabel = new Map();
  for (const entry of candidates) {
    const previous = latestByLabel.get(entry.meta.label);
    if (
      !previous ||
      String(entry.meta.startedAt).localeCompare(String(previous.meta.startedAt)) >
        0
    ) {
      if (previous) {
        ignored.push({
          captureId: previous.meta.id,
          label: previous.meta.label,
          reason: "同标签存在更新采集，默认采用时间较晚的数据",
        });
      }
      latestByLabel.set(entry.meta.label, entry);
    } else {
      ignored.push({
        captureId: entry.meta.id,
        label: entry.meta.label,
        reason: "同标签存在更新采集，默认采用时间较晚的数据",
      });
    }
  }

  const selected = [...latestByLabel.values()].sort((left, right) =>
    String(left.meta.startedAt).localeCompare(String(right.meta.startedAt)),
  );
  for (const { meta, target } of selected) {
    const jsonlPath = join(capturesDirectory, `${meta.id}.jsonl`);
    let records;
    try {
      records = (await readFile(jsonlPath, "utf8"))
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((record) => record.type === undefined || record.type === "frame");
    } catch (error) {
      ignored.push({
        captureId: meta.id,
        label: meta.label,
        reason: `原始帧读取失败：${error.message}`,
      });
      continue;
    }
    const warmupEnd = Date.parse(meta.startedAt) + warmupSeconds * 1000;
    const usable = records.filter(
      (record) => Date.parse(record.timestamp) >= warmupEnd,
    );
    const perAnchor = summarizeMeasurements(usable);
    if (perAnchor.length < 2) {
      ignored.push({
        captureId: meta.id,
        label: meta.label,
        reason: "有效基站少于两路",
      });
      continue;
    }
    const sample = {
      captureId: meta.id,
      label: meta.label,
      sourceDataset: target.dataset ?? "legacy",
      ...target,
      perAnchor,
    };
    if (target.split === "validation") {
      validationSamples.push(sample);
    } else {
      samples.push(sample);
    }
  }
  return {
    samples,
    validationSamples,
    ignored,
    dataset: selectedDataset,
    structuredTrainingPointCount: samples.filter(
      (sample) => sample.sourceDataset === "2026-07-31-grid",
    ).length,
    legacyTrainingPointCount: samples.filter(
      (sample) => sample.sourceDataset === "legacy",
    ).length,
  };
}

function validateSparseRealtimeModel(model, samples) {
  const rows = samples.map((sample) => {
    const estimate = estimateSparseRealtime(model, {
      anchors: sample.perAnchor,
    });
    return {
      captureId: sample.captureId,
      label: sample.label,
      trueDistanceM: sample.distanceM,
      estimatedDistanceM: estimate.distanceM,
      distanceErrorM: estimate.valid
        ? estimate.distanceM - sample.distanceM
        : null,
      trueAngleDeg: sample.angleDeg,
      estimatedAngleDeg: estimate.angleDeg,
      angleErrorDeg:
        estimate.angleValid && Number.isFinite(sample.angleDeg)
          ? estimate.angleDeg - sample.angleDeg
          : null,
    };
  });
  const distanceErrors = rows
    .map((row) => row.distanceErrorM)
    .filter(Number.isFinite)
    .map(Math.abs);
  const angleErrors = rows
    .map((row) => row.angleErrorDeg)
    .filter(Number.isFinite)
    .map(Math.abs);
  return {
    pointCount: rows.length,
    distanceMaxErrorM:
      distanceErrors.length > 0 ? Math.max(...distanceErrors) : null,
    distanceP95M:
      distanceErrors.length > 0 ? percentile(distanceErrors, 0.95) : null,
    angleMaxErrorDeg:
      angleErrors.length > 0 ? Math.max(...angleErrors) : null,
    angleP95Deg:
      angleErrors.length > 0 ? percentile(angleErrors, 0.95) : null,
    rows,
  };
}

function percentile(values, ratio) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
}

function summarizeRecentMeasurements(measurements) {
  const frames = (measurements ?? [])
    .filter((frame) => frame?.type === undefined || frame.type === "frame")
    .filter((frame) => Number.isFinite(Date.parse(frame.timestamp)));
  if (frames.length === 0) return [];
  const latestMs = Math.max(...frames.map((frame) => Date.parse(frame.timestamp)));
  const recent = frames.filter(
    (frame) => Date.parse(frame.timestamp) >= latestMs - 1500,
  );
  return summarizeMeasurements(recent, { maximumSamples: 11 });
}

function summarizeMeasurements(measurements, { maximumSamples = null } = {}) {
  const devices = [
    ...new Set(
      (measurements ?? [])
        .map((frame) => Number(frame.device ?? frame.deviceId))
        .filter(Number.isInteger),
    ),
  ].sort((left, right) => left - right);

  return devices.map((device) => {
    let frames = measurements
      .filter((frame) => Number(frame.device ?? frame.deviceId) === device)
      .sort(
        (left, right) =>
          Date.parse(left.timestamp) - Date.parse(right.timestamp),
      );
    if (maximumSamples !== null) {
      frames = frames.slice(-maximumSamples);
    }
    const distances = frames
      .map((frame) =>
        frame.distanceMm === undefined
          ? Number(frame.distanceCm) * 10
          : Number(frame.distanceMm),
      )
      .filter(Number.isFinite);
    const filtered =
      distances.length >= 7
        ? hampelFilter(distances, {
            windowSize: 7,
            threshold: 3,
            minimumScale: 10,
          }).accepted
        : distances;
    const center = median(filtered);
    const mad = median(filtered.map((value) => Math.abs(value - center)));
    const snrValues = frames
      .map((frame) => Number(frame.snrDb))
      .filter(Number.isFinite);
    return {
      anchorId: `A${device}`,
      medianMm: center,
      madMm: mad,
      snrDb: median(snrValues),
      sampleCount: filtered.length,
      rawSampleCount: distances.length,
    };
  });
}

function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}
