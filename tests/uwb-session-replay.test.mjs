import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseUwbFrames } from "../apps/uwb-recorder/src/parser.js";
import {
  groupFramesByWindow,
  summarizeFrameGroups,
} from "../packages/uwb-localization/src/index.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const goldenSessionPath = join(
  repositoryRoot,
  "apps",
  "uwb-recorder",
  "data",
  "sessions",
  "2026-07-30T18-21-34-289Z.jsonl",
);

test("重放 8486 帧真实会话时保持解析和地址隔离", async () => {
  const records = (await readFile(goldenSessionPath, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const recordedFrames = records.filter((record) => record.type === "frame");

  assert.equal(records.length, 8487);
  assert.equal(recordedFrames.length, 8486);

  const frames = recordedFrames.map((record) => {
    const [parsed] = parseUwbFrames(record.raw);
    assert.ok(parsed, `无法重新解析第 ${record.seq} 帧`);
    assert.equal(parsed.address, record.address);
    assert.equal(parsed.device, record.device);
    assert.equal(parsed.distanceCm, record.distanceCm);
    assert.equal(parsed.snrDb, record.snrDb);

    return {
      timestampMs: Date.parse(record.timestamp),
      address: record.address,
      deviceId: "uwb-recorder",
      anchorId: `A${record.device}`,
      distanceMm: record.distanceCm * 10,
      snrDb: record.snrDb,
    };
  });

  const groups = groupFramesByWindow(frames, { windowMs: 120 });
  assert.ok(groups.length > 0);
  assert.ok(
    groups.every(
      (group) =>
        new Set(group.frames.map((frame) => frame.address)).size === 1,
    ),
  );

  const summaries = summarizeFrameGroups(frames, {
    expectedAnchorIds: ["A1", "A2"],
    warmupSamples: 0,
    minValidSamples: 1,
  });
  assert.ok(summaries.length >= 2);
  assert.ok(
    summaries.every(
      (summary) => summary.validMask.filter(Boolean).length <= 1,
    ),
    "不同钥匙地址不得拼成双基站标定结果",
  );
});
