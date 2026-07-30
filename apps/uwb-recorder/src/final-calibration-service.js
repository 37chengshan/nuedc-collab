import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  estimateSparseRealtime,
  hampelFilter,
  parseSparseCalibrationLabel,
  trainSparseRealtimeModel,
} from "../../../packages/uwb-localization/src/index.js";

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

  return {
    status() {
      return {
        ready: true,
        mode: model.mode,
        source: "final-captures",
        captureCount: loaded.samples.length,
        ignoredCaptureCount: loaded.ignored.length,
        ignoredCaptures: loaded.ignored,
        calibratedRangeM: model.calibratedRangeM,
        calibratedAngleDeg: model.calibratedAngleDeg,
        metrics: {
          trainingPointCount: model.metrics.trainingPointCount,
          anglePointCount: model.metrics.anglePointCount,
          distanceMaxErrorM: model.metrics.distanceMaxErrorM,
          distanceP95M: model.metrics.distanceP95M,
          angleMaxErrorDeg: model.metrics.angleMaxErrorDeg,
          angleP95Deg: model.metrics.angleP95Deg,
        },
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

    model,
  };
}

async function loadFinalCaptures(capturesDirectory, { warmupSeconds }) {
  const entries = await readdir(capturesDirectory, { withFileTypes: true });
  const metaNames = entries
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(".meta.json"),
    )
    .map((entry) => entry.name)
    .sort();
  const samples = [];
  const ignored = [];

  for (const metaName of metaNames) {
    const meta = JSON.parse(
      await readFile(join(capturesDirectory, metaName), "utf8"),
    );
    const target = parseSparseCalibrationLabel(meta.label);
    if (!target) {
      ignored.push({ captureId: meta.id, label: meta.label, reason: "标签无法识别" });
      continue;
    }
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
    samples.push({
      captureId: meta.id,
      label: meta.label,
      ...target,
      perAnchor,
    });
  }
  return { samples, ignored };
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
