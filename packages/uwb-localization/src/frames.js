import {
  finiteNumber,
  median,
  medianAbsoluteDeviation,
} from "./utils.js";

export function normalizeReplayFrame(record, { deviceToAnchor } = {}) {
  if (!record || (record.type !== undefined && record.type !== "frame")) {
    return null;
  }
  const timestampMs = timestampOf(record);
  const deviceId = record.deviceId ?? record.device;
  if (deviceId === undefined || deviceId === null) {
    throw new TypeError("frame 缺少 device/deviceId");
  }
  const address = String(record.address ?? "").trim().toUpperCase();
  if (!address) {
    throw new TypeError("frame 缺少 address");
  }
  const distanceMm =
    record.distanceMm !== undefined
      ? finiteNumber(record.distanceMm, "distanceMm")
      : finiteNumber(record.distanceCm, "distanceCm") * 10;
  const explicitKeyId = record.keyId;
  const parsedAddress = /^[0-9A-F]+$/.test(address)
    ? Number.parseInt(address, 16)
    : Number.NaN;
  const keyId =
    explicitKeyId === undefined || explicitKeyId === null
      ? Number.isFinite(parsedAddress)
        ? parsedAddress & 0x0f
        : null
      : Number(explicitKeyId);
  const anchorId =
    record.anchorId ??
    (typeof deviceToAnchor === "function"
      ? deviceToAnchor(deviceId, record)
      : deviceToAnchor?.[deviceId] ?? `A${deviceId}`);

  return {
    ...(record.seq === undefined ? {} : { seq: record.seq }),
    timestampMs,
    ...(record.elapsedMs === undefined
      ? {}
      : { elapsedMs: Number(record.elapsedMs) }),
    deviceId,
    anchorId: String(anchorId),
    address,
    keyId,
    distanceMm,
    snrDb:
      record.snrDb === undefined || record.snrDb === null
        ? null
        : finiteNumber(record.snrDb, "snrDb"),
    ...(record.raw === undefined ? {} : { raw: String(record.raw) }),
  };
}

export function groupFramesByWindow(frames, { windowMs = 120 } = {}) {
  const normalized = frames
    .map((frame) => normalizeAnyFrame(frame))
    .filter(Boolean)
    .sort(compareFrames);
  const streams = new Map();

  for (const frame of normalized) {
    const streamKey = `${frame.address}\u0000${String(frame.deviceId)}`;
    const groups = streams.get(streamKey) ?? [];
    let group = groups.at(-1);
    if (!group || frame.timestampMs - group.startMs > windowMs) {
      group = {
        address: frame.address,
        deviceId: frame.deviceId,
        startMs: frame.timestampMs,
        endMs: frame.timestampMs,
        frames: [],
      };
      groups.push(group);
      streams.set(streamKey, groups);
    }
    group.frames.push(frame);
    group.endMs = frame.timestampMs;
  }

  return [...streams.values()]
    .flat()
    .sort(
      (left, right) =>
        left.startMs - right.startMs ||
        String(left.address).localeCompare(String(right.address)) ||
        String(left.deviceId).localeCompare(String(right.deviceId)),
    );
}

export function hampelFilter(
  values,
  { windowSize = 7, threshold = 3, minimumScale = 1 } = {},
) {
  if (!Number.isInteger(windowSize) || windowSize < 3 || windowSize % 2 === 0) {
    throw new RangeError("Hampel windowSize 必须是大于等于 3 的奇数");
  }
  const half = Math.floor(windowSize / 2);
  const rejectedIndices = [];
  const acceptedIndices = [];

  for (let index = 0; index < values.length; index += 1) {
    const start = Math.max(0, index - half);
    const end = Math.min(values.length, index + half + 1);
    const window = values.slice(start, end);
    const center = median(window);
    const mad = medianAbsoluteDeviation(window, center);
    const scale = Math.max(minimumScale, 1.4826 * (mad ?? 0));
    if (Math.abs(values[index] - center) > threshold * scale) {
      rejectedIndices.push(index);
    } else {
      acceptedIndices.push(index);
    }
  }

  return {
    accepted: acceptedIndices.map((index) => values[index]),
    acceptedIndices,
    rejectedIndices,
  };
}

export function summarizeFrameGroups(
  frames,
  {
    expectedAnchorIds,
    windowMs = 120,
    warmupSamples = 2,
    hampelWindow = 7,
    hampelThreshold = 3,
    medianWindow = 5,
    minValidSamples = 5,
    stabilityMadMm = 80,
  } = {},
) {
  return groupFramesByWindow(frames, { windowMs }).map((group) => {
    const anchorIds =
      expectedAnchorIds ??
      [...new Set(group.frames.map((frame) => frame.anchorId))].sort();
    const anchors = {};

    for (const anchorId of anchorIds) {
      const anchorFrames = group.frames
        .filter((frame) => frame.anchorId === anchorId)
        .sort(compareFrames)
        .slice(warmupSamples);
      if (anchorFrames.length === 0) {
        anchors[anchorId] = missingAnchorSummary();
        continue;
      }
      const filtered = hampelFilter(
        anchorFrames.map((frame) => frame.distanceMm),
        {
          windowSize: hampelWindow,
          threshold: hampelThreshold,
        },
      );
      const acceptedFrames = filtered.acceptedIndices.map(
        (index) => anchorFrames[index],
      );
      const statisticFrames = acceptedFrames.slice(-medianWindow);
      const distances = statisticFrames.map((frame) => frame.distanceMm);
      const center = median(distances);
      const mad = medianAbsoluteDeviation(distances, center);
      const snrValues = statisticFrames
        .map((frame) => frame.snrDb)
        .filter(Number.isFinite);
      const validCount = statisticFrames.length;
      const stable =
        validCount >= minValidSamples &&
        center !== null &&
        mad !== null &&
        mad <= stabilityMadMm;
      anchors[anchorId] = {
        medianMm: center,
        madMm: mad,
        snrDb: snrValues.length > 0 ? median(snrValues) : null,
        validCount,
        acceptedCount: acceptedFrames.length,
        rejectedCount: filtered.rejectedIndices.length,
        stable,
        accepted: stable,
        missing: false,
      };
    }

    return {
      address: group.address,
      deviceId: group.deviceId,
      startMs: group.startMs,
      endMs: group.endMs,
      anchors,
      validMask: anchorIds.map((anchorId) => anchors[anchorId].accepted),
    };
  });
}

export function synchronizeFrames(
  frames,
  { requiredDevices, windowMs = 120, deviceToAnchor } = {},
) {
  const normalized = frames
    .map((frame) => normalizeAnyFrame(frame, { deviceToAnchor }))
    .filter(Boolean)
    .sort(compareFrames);
  const devices =
    requiredDevices?.map((device) => device) ??
    [...new Set(normalized.map((frame) => frame.deviceId))].sort(compareValues);
  const identities = new Map();

  for (const frame of normalized) {
    const identity =
      frame.keyId === null || !Number.isFinite(frame.keyId)
        ? `address:${frame.address}`
        : `key:${frame.keyId}`;
    const bucket = identities.get(identity) ?? [];
    bucket.push(frame);
    identities.set(identity, bucket);
  }

  const groups = [];
  const used = new Set();
  for (const identityFrames of identities.values()) {
    const byDevice = new Map(
      devices.map((device) => [
        device,
        identityFrames
          .filter((frame) => frame.deviceId === device)
          .sort(compareFrames),
      ]),
    );
    if (devices.some((device) => byDevice.get(device).length === 0)) {
      continue;
    }
    const referenceDevice = [...devices].sort(
      (left, right) =>
        byDevice.get(left).length - byDevice.get(right).length ||
        compareValues(left, right),
    )[0];

    for (const reference of byDevice.get(referenceDevice)) {
      if (used.has(reference)) {
        continue;
      }
      const selected = [reference];
      let complete = true;
      for (const device of devices) {
        if (device === referenceDevice) {
          continue;
        }
        const candidate = nearestUnused(
          byDevice.get(device),
          reference.timestampMs,
          windowMs,
          used,
        );
        if (!candidate) {
          complete = false;
          break;
        }
        selected.push(candidate);
      }
      const timestamps = selected.map((frame) => frame.timestampMs);
      if (
        !complete ||
        Math.max(...timestamps) - Math.min(...timestamps) > windowMs
      ) {
        continue;
      }
      selected.forEach((frame) => used.add(frame));
      const ordered = devices.map((device) =>
        selected.find((frame) => frame.deviceId === device),
      );
      groups.push({
        address: reference.address,
        addresses: [...new Set(ordered.map((frame) => frame.address))],
        keyId: reference.keyId,
        startMs: Math.min(...timestamps),
        endMs: Math.max(...timestamps),
        frames: ordered,
      });
    }
  }
  groups.sort((left, right) => left.startMs - right.startMs);

  const unpairedFrames = normalized.filter((frame) => !used.has(frame));
  return {
    groups,
    usedFrameCount: used.size,
    unpairedFrames,
  };
}

export function replayFrameSession(input, options = {}) {
  const records = parseReplayInput(input);
  const frameRecords = records.filter(
    (record) => record?.type === undefined || record.type === "frame",
  );
  const parsed = [];
  const parseErrors = [];
  for (const record of frameRecords) {
    try {
      const frame = normalizeReplayFrame(record, options);
      if (frame) {
        parsed.push(frame);
      }
    } catch (error) {
      parseErrors.push({ record, message: error.message });
    }
  }

  const startMs =
    parsed.length > 0
      ? Math.min(...parsed.map((frame) => frame.timestampMs))
      : Number.POSITIVE_INFINITY;
  const addressFilter =
    options.address === undefined
      ? null
      : String(options.address).trim().toUpperCase();
  const keyIdFilter =
    options.keyId === undefined || options.keyId === null
      ? null
      : Number(options.keyId);
  const allowedAddresses =
    options.addresses === undefined
      ? null
      : new Set(options.addresses.map((address) => String(address).toUpperCase()));
  const warmupMs = Number(options.warmupMs ?? 0);
  const filtered = parsed.filter((frame) => {
    if (frame.timestampMs - startMs < warmupMs) {
      return false;
    }
    if (addressFilter !== null && frame.address !== addressFilter) {
      return false;
    }
    if (allowedAddresses !== null && !allowedAddresses.has(frame.address)) {
      return false;
    }
    if (keyIdFilter !== null && frame.keyId !== keyIdFilter) {
      return false;
    }
    if (
      options.addressesByDevice &&
      String(options.addressesByDevice[frame.deviceId] ?? "").toUpperCase() !==
        frame.address
    ) {
      return false;
    }
    return true;
  });
  const synchronized = synchronizeFrames(filtered, options);
  const minimum = Number(options.minSynchronizedGroups ?? 100);

  return {
    inputFrameCount: frameRecords.length,
    parsedFrameCount: parsed.length,
    parseErrors,
    filteredFrameCount: filtered.length,
    groups: synchronized.groups,
    synchronizedGroupCount: synchronized.groups.length,
    usedFrameCount: synchronized.usedFrameCount,
    unpairedFrames: synchronized.unpairedFrames,
    accepted:
      parseErrors.length === 0 && synchronized.groups.length >= minimum,
    recaptureReasons:
      synchronized.groups.length >= minimum
        ? []
        : [`同步有效组不足 ${minimum}`],
  };
}

function normalizeAnyFrame(frame, options) {
  if (!frame) {
    return null;
  }
  if (
    frame.timestampMs !== undefined &&
    frame.deviceId !== undefined &&
    frame.distanceMm !== undefined
  ) {
    const address = String(frame.address ?? "").toUpperCase();
    return {
      ...frame,
      timestampMs: finiteNumber(frame.timestampMs, "timestampMs"),
      address,
      keyId:
        frame.keyId ??
        (/^[0-9A-F]+$/.test(address)
          ? Number.parseInt(address, 16) & 0x0f
          : null),
      anchorId: String(frame.anchorId ?? `A${frame.deviceId}`),
      distanceMm: finiteNumber(frame.distanceMm, "distanceMm"),
      snrDb:
        frame.snrDb === undefined || frame.snrDb === null
          ? null
          : finiteNumber(frame.snrDb, "snrDb"),
    };
  }
  return normalizeReplayFrame(frame, options);
}

function timestampOf(record) {
  if (record.timestampMs !== undefined) {
    return finiteNumber(record.timestampMs, "timestampMs");
  }
  if (record.timestamp !== undefined) {
    const timestamp = Date.parse(record.timestamp);
    if (!Number.isFinite(timestamp)) {
      throw new TypeError("timestamp 不是有效 ISO 时间");
    }
    return timestamp;
  }
  if (record.elapsedMs !== undefined) {
    return finiteNumber(record.elapsedMs, "elapsedMs");
  }
  throw new TypeError("frame 缺少 timestamp/timestampMs");
}

function compareFrames(left, right) {
  return (
    left.timestampMs - right.timestampMs ||
    compareValues(left.deviceId, right.deviceId)
  );
}

function compareValues(left, right) {
  return String(left).localeCompare(String(right), "en", { numeric: true });
}

function nearestUnused(frames, timestampMs, windowMs, used) {
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const frame of frames) {
    if (used.has(frame)) {
      continue;
    }
    const distance = Math.abs(frame.timestampMs - timestampMs);
    if (distance <= windowMs && distance < bestDistance) {
      best = frame;
      bestDistance = distance;
    }
  }
  return best;
}

function parseReplayInput(input) {
  if (Array.isArray(input)) {
    return input;
  }
  if (typeof input !== "string") {
    throw new TypeError("回放输入必须是记录数组或 JSONL 字符串");
  }
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function missingAnchorSummary() {
  return {
    medianMm: null,
    madMm: null,
    snrDb: null,
    validCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    stable: false,
    accepted: false,
    missing: true,
  };
}
