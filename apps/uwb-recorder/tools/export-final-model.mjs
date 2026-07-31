#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createFinalCalibrationService } from "../src/final-calibration-service.js";

function flagValue(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`缺少 --${name} 的值`);
  }
  return value;
}

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const appDirectory = resolve(toolDirectory, "..");
const outputDirectory = resolve(
  flagValue("output", join(appDirectory, "..", "..", "code", "c_digital_key_lock")),
);
const name = flagValue("name", "empirical_model_data");
const service = await createFinalCalibrationService({
  capturesDirectory: join(appDirectory, "data", "captures"),
});
const exported = service.exportFirmware({ name });

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(
    join(outputDirectory, exported.headerFileName),
    exported.header,
    "utf8",
  ),
  writeFile(
    join(outputDirectory, exported.sourceFileName),
    exported.source,
    "utf8",
  ),
]);

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    outputDirectory,
    headerFileName: exported.headerFileName,
    sourceFileName: exported.sourceFileName,
    prototypeCount: exported.prototypeCount,
    legacyTrainingPointCount: exported.legacyTrainingPointCount,
    structuredTrainingPointCount: exported.structuredTrainingPointCount,
    anglePrototypeCount: exported.anglePrototypeCount,
    firmwareCrc32: exported.firmwareCrc32,
  })}\n`,
);
