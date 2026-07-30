import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CALIBRATION_ANGLES_DEG,
  CALIBRATION_RADII_MM,
  ConstantVelocityKalman,
  ZoneStateMachine,
  applyCompensation,
  createCalibrationModelV1,
  crc32,
  exportCalibrationModelC,
  exportFirmware,
  interpolateCompensation,
  serializeCalibrationModel,
  trainCompensationTable,
  validateModel,
} from "../src/index.js";

test("77 格补偿表按径向 mm 和角度 0.01 度训练", () => {
  const table = trainCompensationTable(compensationSamples());
  assert.deepEqual(table.boundaryDistancesMm, CALIBRATION_RADII_MM);
  assert.deepEqual(
    table.anglesCdeg,
    CALIBRATION_ANGLES_DEG.map((angle) => angle * 100),
  );
  assert.equal(table.boundaryDistanceCorrectionsMm.length, 11);
  assert.equal(table.boundaryDistanceCorrectionsMm[0].length, 7);
  assert.equal(table.angleCorrectionsCdeg.length, 11);
  assert.equal(table.angleCorrectionsCdeg[0].length, 7);
  assert.equal(table.boundaryDistanceCorrectionsMm[3][3], 20);
  assert.equal(table.angleCorrectionsCdeg[3][3], 100);
});

test("非均匀径向网格上执行双线性插值", () => {
  const table = trainCompensationTable(compensationSamples());
  const correction = interpolateCompensation(table, 900, -7.5);

  assert.equal(correction.boundaryDistanceCorrectionMm, 17.5);
  assert.equal(correction.angleCorrectionCdeg, 75);
});

test("补偿应用同时修正径向距离和方位角", () => {
  const table = trainCompensationTable(compensationSamples());
  const corrected = applyCompensation(table, {
    boundaryDistanceMm: 900,
    bearingDeg: -7.5,
  });

  assert.deepEqual(corrected, {
    boundaryDistanceMm: 917.5,
    bearingDeg: -6.75,
    boundaryDistanceCorrectionMm: 17.5,
    angleCorrectionCdeg: 75,
  });
});

test("轻量四状态恒速 Kalman 平滑测量并能在丢帧时预测", () => {
  const kalman = new ConstantVelocityKalman({
    processNoise: 2,
    measurementNoise: 25,
  });
  kalman.step({ xMm: 0, yMm: 1000, timestampMs: 0 });
  kalman.step({ xMm: 110, yMm: 1002, timestampMs: 100 });
  const beforeDrop = kalman.step({ xMm: 205, yMm: 998, timestampMs: 200 });
  const predicted = kalman.step({ valid: false, timestampMs: 300 });

  assert.equal(beforeDrop.initialized, true);
  assert.ok(beforeDrop.xMm > 100 && beforeDrop.xMm < 205);
  assert.ok(predicted.xMm > beforeDrop.xMm);
  assert.equal(predicted.measurementUsed, false);
  assert.equal(predicted.state.length, 4);
});

test("区域状态器使用 1/1.05 m、2/2.05 m 滞回并要求三帧确认", () => {
  const zones = new ZoneStateMachine();

  assert.equal(zones.update(validPosition(1990)).state, "LOCKED");
  assert.equal(zones.update(validPosition(1990)).state, "LOCKED");
  assert.equal(zones.update(validPosition(1990)).state, "WELCOME");

  assert.equal(zones.update(validPosition(2040)).state, "WELCOME");
  assert.equal(zones.update(validPosition(2020)).state, "WELCOME");

  assert.equal(zones.update(validPosition(2060)).state, "WELCOME");
  assert.equal(zones.update(validPosition(2060)).state, "WELCOME");
  assert.equal(zones.update(validPosition(2060)).state, "LOCKED");

  zones.update(validPosition(990));
  zones.update(validPosition(990));
  assert.equal(zones.update(validPosition(990)).state, "UNLOCKED");
  assert.equal(zones.update(validPosition(1040)).state, "UNLOCKED");

  zones.update(validPosition(1060));
  zones.update(validPosition(1060));
  assert.equal(zones.update(validPosition(1060)).state, "WELCOME");
});

test("位置、ID 或模型任一无效都会立即闭锁并清空确认计数", () => {
  const zones = new ZoneStateMachine();
  zones.update(validPosition(900));
  zones.update(validPosition(900));
  assert.equal(zones.update(validPosition(900)).state, "UNLOCKED");

  const locked = zones.update({
    radialMm: 900,
    positionValid: true,
    idValid: false,
    modelValid: true,
  });
  assert.equal(locked.state, "LOCKED");
  assert.equal(locked.locked, true);
  assert.equal(locked.reason, "invalid-input");

  zones.update(validPosition(900));
  assert.equal(zones.update(validPosition(900)).state, "LOCKED");
});

test("CRC32 使用标准测试向量", () => {
  assert.equal(crc32("123456789"), "CBF43926");
});

test("CalibrationModelV1 序列化确定且可通过结构与 CRC 校验", () => {
  const model = sampleModel();
  const first = serializeCalibrationModel(model);
  const second = serializeCalibrationModel(structuredClone(model));
  const validation = validateModel(model);

  assert.equal(first, second);
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.errors, []);
  assert.match(model.crc32, /^[0-9A-F]{8}$/);
  assert.deepEqual(model.coordinateSystem, {
    origin: "cylinder-center",
    frontAxis: "+y",
    rightAxis: "+x",
    bearingZeroAxis: "+y",
    bearingPositive: "right",
    bearingRangeDeg: [-45, 45],
    radialZeroOffsetMm: 300,
    distanceOutput: "boundary",
  });
});

test("模型内容损坏但 CRC 未更新时会被拒绝", () => {
  const model = sampleModel();
  const damaged = structuredClone(model);
  damaged.rangeModels.A1.coefficients[0] += 1;

  const validation = validateModel(damaged);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => /CRC/i.test(error)));
});

test("C 导出包含可直接链接的 typed CalibrationModelV1，而不是只有 JSON blob", () => {
  const model = sampleModel();
  const output = exportCalibrationModelC(model, {
    symbol: "g_door_uwb_calibration",
    headerName: "door_uwb_calibration.h",
    includeAuditJson: true,
  });

  assert.equal(typeof output.header, "string");
  assert.equal(typeof output.source, "string");
  assert.equal(output.modelSizeBytes, 900);
  assert.match(output.header, /#include "calibration_model\.h"/);
  assert.match(
    output.header,
    /extern const CalibrationModelV1 g_door_uwb_calibration;/,
  );

  assert.match(
    output.source,
    /const CalibrationModelV1 g_door_uwb_calibration = \{/,
  );
  assert.match(output.source, /\.magic = CALIBRATION_MODEL_V1_MAGIC/);
  assert.match(output.source, /\.version = CALIBRATION_MODEL_V1_VERSION/);
  assert.match(
    output.source,
    /\.model_size_bytes = CALIBRATION_MODEL_V1_SERIALIZED_SIZE/,
  );
  assert.match(output.source, /\.anchor_count = 4U/);
  assert.match(output.source, /\.enabled_anchor_mask = 0x0FU/);
  assert.match(
    output.source,
    /\.flags = CALIBRATION_MODEL_FLAG_DISTANCE_GRID \|[\s\S]*CALIBRATION_MODEL_FLAG_ANGLE_GRID/,
  );
  assert.match(output.source, /\.type = CALIBRATION_RANGE_LINEAR/);
  assert.match(output.source, /\.type = CALIBRATION_RANGE_QUADRATIC/);
  assert.match(output.source, /\.type = CALIBRATION_RANGE_MONOTONIC_PWL/);
  assert.match(output.source, /\.distance_axis_mm = \{/);
  assert.match(output.source, /\.radial_correction_mm = \{/);
  assert.match(output.source, /\.bearing_correction_cdeg = \{/);
  assert.match(output.source, /\.process_noise_position = 2\.0f/);
  assert.match(output.source, /\.process_noise_velocity = 8\.0f/);
  assert.match(output.source, /\.measurement_noise_position = 25\.0f/);
  assert.match(output.source, /\.initial_position_variance = 1000\.0f/);
  assert.match(output.source, /\.initial_velocity_variance = 4000\.0f/);
  assert.match(output.source, /\.max_dt_s = 0\.5f/);
  assert.match(output.source, /\.huber_delta_mm = 150\.0f/);
  assert.match(output.source, /\.nlos_threshold_mm = 180\.0f/);
  assert.match(output.source, /\.distance_p95_mm = 120\.0f/);
  assert.match(output.source, /\.bearing_p95_deg = 6\.5f/);
  assert.match(output.source, new RegExp(`\\.crc32 = 0x${output.firmwareCrc32}U`));
  assert.match(output.source, /audit_json/);
  assert.match(output.auditJson, new RegExp(model.crc32));
});

test("typed C 导出可与 golden vector fixture 一起通过 C11 严格语法编译", () => {
  const output = exportCalibrationModelC(sampleModel(), {
    symbol: "g_door_uwb_calibration",
    headerName: "door_uwb_calibration.h",
    includeAuditJson: true,
  });
  const fixture = readFileSync(
    new URL("./fixtures/calibration-model-v1-golden.c", import.meta.url),
    "utf8",
  );
  const translationUnit = [
    output.header,
    output.source.replace(/^#include "door_uwb_calibration\.h"\r?\n/, ""),
    fixture,
  ].join("\n");
  const firmwareIncludeDir = fileURLToPath(
    new URL("../../../code/c_digital_key_lock/", import.meta.url),
  );
  const compiler = spawnSync(
    process.env.CC || "gcc",
    [
      "-x",
      "c",
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-pedantic",
      `-I${firmwareIncludeDir}`,
      "-fsyntax-only",
      "-",
    ],
    {
      input: translationUnit,
      encoding: "utf8",
    },
  );

  assert.equal(
    compiler.status,
    0,
    `C golden fixture 编译失败：\n${compiler.stdout}\n${compiler.stderr}`,
  );
});

test("MSPM0 导出默认生成可直接替换固件数据文件的名称和符号", async () => {
  const output = await exportFirmware({ model: sampleModel() });

  assert.equal(output.headerFileName, "calibration_model_data.h");
  assert.equal(output.sourceFileName, "calibration_model_data.c");
  assert.equal(output.auditFileName, "calibration_model_data.json");
  assert.match(
    output.header,
    /extern const CalibrationModelV1 g_calibration_model_v1;/,
  );
  assert.match(
    output.source,
    /const CalibrationModelV1 g_calibration_model_v1 = \{/,
  );
  assert.doesNotMatch(output.source, /audit_json/);
});

test("JS 导出模型与固件 C 算法使用同一 CRC 和黄金向量", () => {
  const model = sampleModel({ withCorrections: true });
  const output = exportCalibrationModelC(model, {
    symbol: "g_calibration_model_v1",
    headerName: "calibration_model_data.h",
  });
  const firmwareDir = fileURLToPath(
    new URL("../../../code/c_digital_key_lock/", import.meta.url),
  );
  const temporaryDir = mkdtempSync(join(tmpdir(), "uwb-model-golden-"));
  const executable = join(
    temporaryDir,
    process.platform === "win32" ? "golden.exe" : "golden",
  );

  try {
    writeFileSync(
      join(temporaryDir, "calibration_model_data.h"),
      output.header,
      "utf8",
    );
    writeFileSync(
      join(temporaryDir, "calibration_model_data.c"),
      output.source,
      "utf8",
    );
    writeFileSync(
      join(temporaryDir, "golden.c"),
      `#include "calibration_model_data.h"
#include <stdio.h>

int main(void)
{
    float corrected_range_mm = 0.0f;
    float radial_correction_mm = 0.0f;
    float bearing_correction_deg = 0.0f;

    if (calibration_model_validate(&g_calibration_model_v1) !=
        CALIBRATION_MODEL_OK) {
        return 2;
    }
    if (!calibration_model_correct_range(
            &g_calibration_model_v1, 1U, 1000.0f,
            &corrected_range_mm)) {
        return 3;
    }
    if (!calibration_model_lookup_compensation(
            &g_calibration_model_v1, 900.0f, -7.5f,
            &radial_correction_mm, &bearing_correction_deg)) {
        return 4;
    }
    printf("%.9f %.9f %.9f\\n", corrected_range_mm,
           radial_correction_mm, bearing_correction_deg);
    return 0;
}
`,
      "utf8",
    );

    const compiler = spawnSync(
      process.env.CC || "gcc",
      [
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-pedantic",
        `-I${temporaryDir}`,
        `-I${firmwareDir}`,
        join(temporaryDir, "calibration_model_data.c"),
        join(firmwareDir, "calibration_model.c"),
        join(temporaryDir, "golden.c"),
        "-lm",
        "-o",
        executable,
      ],
      { encoding: "utf8" },
    );
    assert.equal(
      compiler.status,
      0,
      `黄金向量 C 编译失败：\n${compiler.stdout}\n${compiler.stderr}`,
    );

    const runtime = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(
      runtime.status,
      0,
      `黄金向量 C 执行失败：\n${runtime.stdout}\n${runtime.stderr}`,
    );
    const [correctedRangeMm, radialCorrectionMm, bearingCorrectionDeg] =
      runtime.stdout.trim().split(/\s+/).map(Number);
    const expectedCompensation = interpolateCompensation(
      model.compensationTable,
      900,
      -7.5,
    );

    assert.ok(Math.abs(correctedRangeMm - 1010) <= 2);
    assert.ok(
      Math.abs(
        radialCorrectionMm -
          expectedCompensation.boundaryDistanceCorrectionMm,
      ) <= 2,
    );
    assert.ok(
      Math.abs(
        bearingCorrectionDeg -
          expectedCompensation.angleCorrectionCdeg / 100,
      ) <= 0.1,
    );
  } finally {
    rmSync(temporaryDir, { recursive: true, force: true });
  }
});

function compensationSamples() {
  return CALIBRATION_RADII_MM.flatMap((radialMm) =>
    CALIBRATION_ANGLES_DEG.map((angleDeg) => ({
      pointId: `R${radialMm}_A${angleDeg}`,
      boundaryDistanceMm: radialMm,
      angleDeg,
      boundaryDistanceCorrectionMm: radialMm / 50 + angleDeg / 15,
      angleCorrectionCdeg: radialMm / 10 + angleDeg * 2,
    })),
  );
}

function validPosition(radialMm) {
  return {
    boundaryDistanceMm: radialMm,
    positionValid: true,
    idValid: true,
    modelValid: true,
  };
}

function sampleModel({ withCorrections = false } = {}) {
  const compensationTable = trainCompensationTable(
    CALIBRATION_RADII_MM.flatMap((radialMm) =>
      CALIBRATION_ANGLES_DEG.map((angleDeg) => ({
        boundaryDistanceMm: radialMm,
        angleDeg,
        boundaryDistanceCorrectionMm: withCorrections
          ? radialMm / 50 + angleDeg / 15
          : 0,
        angleCorrectionCdeg: withCorrections
          ? radialMm / 10 + angleDeg * 2
          : 0,
      })),
    ),
  );

  return createCalibrationModelV1({
    anchors: [
      { id: "A1", xMm: -125, yMm: 40 },
      { id: "A2", xMm: 125, yMm: 40 },
      { id: "A3", xMm: 0, yMm: -100 },
      { id: "A4", xMm: 0, yMm: 180 },
    ],
    radialZeroOffsetMm: 300,
    rangeModels: {
      A1: {
        type: "linear",
        coefficients: [0, 1],
        domainMm: [300, 3500],
      },
      A2: {
        type: "quadratic",
        coefficients: [2, 0.998, 0.00001],
        domainMm: [300, 3500],
      },
      A3: {
        type: "piecewise-linear",
        rawKnotsMm: [300, 1000, 2000, 3500],
        correctedKnotsMm: [310, 1010, 2015, 3520],
        domainMm: [300, 3500],
      },
      A4: {
        type: "linear",
        coefficients: [-3, 1.002],
        domainMm: [300, 3500],
      },
    },
    compensationTable,
    kalman: {
      processNoise: 2,
      measurementNoise: 25,
      initialCovariance: 1000,
    },
    metrics: {
      rangeCvRmseMm: 18.5,
      positionP95Mm: 120,
      bearingP95Cdeg: 650,
      synchronizedGroups: 130,
    },
    metadata: {
      board: "test-fixture",
      revision: 1,
    },
  });
}
