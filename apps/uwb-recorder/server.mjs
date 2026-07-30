import { createServer } from "node:http";
import { join } from "node:path";

import { createApiServer } from "./src/api-server.js";
import {
  CalibrationService,
  createSerialCalibrationCaptureSource,
} from "./src/calibration-service.js";
import { createFinalCalibrationService } from "./src/final-calibration-service.js";
import { UwbSerialService } from "./src/serial-service.js";

const host = process.env.UWB_HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 4173);
const root = import.meta.dirname;
const dataDirectory = join(root, "data");

const service = new UwbSerialService({ dataDirectory });
await service.initialize();

let calibrationEngine = {};
try {
  calibrationEngine = await import(
    "../../packages/uwb-localization/src/index.js"
  );
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") {
    throw error;
  }
  console.warn(
    "标定算法包尚未接入：采集质量检查可用，训练/验证/导出会返回明确错误。",
  );
}
const calibration = new CalibrationService({
  captureSource: createSerialCalibrationCaptureSource(service),
  engine: calibrationEngine,
});
const finalCalibration = await createFinalCalibrationService({
  capturesDirectory: service.capturesDirectory,
  measurementSource: (options) => service.getMeasurements(options),
});

const server = createApiServer({
  http: { createServer },
  service,
  calibration,
  finalCalibration,
  root,
});

server.listen(port, host, () => {
  console.log(`UWB Lab 服务已启动：http://${host}:${port}`);
  console.log(`Agent API：${host}:${port}/api/schema`);
  console.log("串口由本服务统一占用，网页和CLI都通过同一服务访问。");
});

const shutdown = async () => {
  await service.disconnect().catch(() => {});
  server.close(() => process.exit(0));
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
