import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const capturesDir = path.resolve("data", "captures");
const args = new Map();

for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (key.startsWith("--") && value && !value.startsWith("--")) {
    args.set(key, value);
    index += 1;
  }
}

const since = args.get("--since") ?? "";
const sessionId = args.get("--session") ?? "";
const format = args.get("--format") ?? "json";

function quantile(values, ratio) {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function median(values) {
  return quantile(values, 0.5);
}

function summarize(values) {
  if (values.length === 0) {
    return {
      count: 0,
      median: null,
      mean: null,
      p05: null,
      p95: null,
      mad: null,
    };
  }

  const center = median(values);
  const deviations = values.map((value) => Math.abs(value - center));
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;

  return {
    count: values.length,
    median: Number(center.toFixed(2)),
    mean: Number(mean.toFixed(2)),
    p05: Number(quantile(values, 0.05).toFixed(2)),
    p95: Number(quantile(values, 0.95).toFixed(2)),
    mad: Number(median(deviations).toFixed(2)),
  };
}

function rollingMedian(values, windowSize = 20) {
  const result = [];

  for (let index = windowSize - 1; index < values.length; index += 1) {
    result.push(median(values.slice(index - windowSize + 1, index + 1)));
  }

  return result;
}

function summarizeSeries(values) {
  return {
    raw: summarize(values),
    median20: summarize(rollingMedian(values)),
  };
}

function loadJsonLines(filePath) {
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const captures = fs
  .readdirSync(capturesDir)
  .filter((name) => name.endsWith(".meta.json"))
  .map((name) =>
    JSON.parse(fs.readFileSync(path.join(capturesDir, name), "utf8")),
  )
  .filter((capture) => !since || capture.startedAt >= since)
  .filter((capture) => !sessionId || capture.sessionId === sessionId)
  .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
  .map((capture) => {
    const measurements = loadJsonLines(
      path.join(capturesDir, `${capture.id}.jsonl`),
    ).filter((measurement) => Number.isFinite(measurement.distanceCm));

    const byAddress = new Map();
    const byTimestamp = new Map();

    for (const measurement of measurements) {
      if (!byAddress.has(measurement.address)) {
        byAddress.set(measurement.address, []);
      }
      byAddress.get(measurement.address).push(measurement.distanceCm);

      if (!byTimestamp.has(measurement.timestamp)) {
        byTimestamp.set(measurement.timestamp, {});
      }
      byTimestamp.get(measurement.timestamp)[measurement.address] =
        measurement.distanceCm;
    }

    const synchronizedDifferences = [...byTimestamp.values()]
      .filter(
        (group) =>
          Number.isFinite(group["0100"]) && Number.isFinite(group["0200"]),
      )
      .map((group) => group["0100"] - group["0200"]);

    return {
      id: capture.id,
      label: capture.label,
      startedAt: capture.startedAt,
      frameCount: capture.frameCount,
      address0100: summarizeSeries(byAddress.get("0100") ?? []),
      address0200: summarizeSeries(byAddress.get("0200") ?? []),
      synchronizedPairs: synchronizedDifferences.length,
      difference0100Minus0200: summarizeSeries(synchronizedDifferences),
    };
  });

if (format === "table") {
  const columns = [
    "label",
    "0100 med",
    "0100 f05-f95",
    "0200 med",
    "0200 f05-f95",
    "delta med",
    "delta f05-f95",
  ];
  const rows = captures.map((capture) => {
    const address0100 = capture.address0100.median20;
    const address0200 = capture.address0200.median20;
    const difference = capture.difference0100Minus0200.median20;
    return [
      capture.label,
      address0100.median,
      `${address0100.p05}-${address0100.p95}`,
      address0200.median,
      `${address0200.p05}-${address0200.p95}`,
      difference.median,
      `${difference.p05}-${difference.p95}`,
    ];
  });

  process.stdout.write(`${columns.join("\t")}\n`);
  for (const row of rows) {
    process.stdout.write(`${row.join("\t")}\n`);
  }
} else {
  process.stdout.write(`${JSON.stringify({ captures }, null, 2)}\n`);
}
