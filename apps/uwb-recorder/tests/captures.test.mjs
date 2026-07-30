import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { UwbSerialService } from "../src/serial-service.js";

class FakeSerialPort extends EventEmitter {
  static async list() {
    return [{ path: "COM_TEST", manufacturer: "test" }];
  }

  constructor({ path, baudRate }) {
    super();
    this.path = path;
    this.settings = { baudRate };
    this.isOpen = false;
  }

  open(callback) {
    this.isOpen = true;
    callback();
  }

  close(callback) {
    this.isOpen = false;
    this.emit("close");
    callback();
  }

  write(_payload, callback) {
    callback();
  }

  drain(callback) {
    callback();
  }
}

async function createService() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "uwb-capture-"));
  const service = new UwbSerialService({
    dataDirectory,
    serialPortClass: FakeSerialPort,
  });
  await service.initialize();
  return { service, dataDirectory };
}

test("45秒独立采集保存帧、元数据并导出CSV", async (t) => {
  const { service, dataDirectory } = await createService();
  t.after(async () => {
    await service.disconnect().catch(() => {});
    await rm(dataDirectory, { recursive: true, force: true });
  });

  await service.connect({ path: "COM_TEST", baudRate: 115200 });
  const capture = await service.startCapture({
    label: "双路-中轴-1m",
    durationSeconds: 45,
  });
  assert.equal(capture.status, "recording");
  assert.equal(capture.durationSeconds, 45);

  service.port.emit(
    "data",
    Buffer.from(
      "re:P0,0100,101cm,18dB\r\nre:P1,0200,103cm,16dB\r\n",
      "utf8",
    ),
  );
  await service.finishCapture();

  const completed = service.currentCapture();
  assert.equal(completed.status, "completed");
  assert.equal(completed.label, "双路-中轴-1m");
  assert.equal(completed.frameCount, 2);

  const measurements = await service.getCaptureMeasurements(completed.id);
  assert.deepEqual(
    measurements.map((item) => [item.device, item.distanceCm]),
    [
      [1, 101],
      [2, 103],
    ],
  );

  const csv = await service.exportCaptureCsv(completed.id);
  assert.match(csv, /distance_cm/);
  assert.match(csv, /101/);
  assert.match(csv, /103/);

  const listed = await service.listCaptures();
  assert.equal(listed[0].id, completed.id);
  assert.equal(listed[0].frameCount, 2);

  const metadata = JSON.parse(
    await readFile(
      join(dataDirectory, "captures", `${completed.id}.meta.json`),
      "utf8",
    ),
  );
  assert.equal(metadata.status, "completed");
});

test("未连接串口不能开始采集，进行中也不能重复开始", async (t) => {
  const { service, dataDirectory } = await createService();
  t.after(async () => {
    await service.disconnect().catch(() => {});
    await rm(dataDirectory, { recursive: true, force: true });
  });

  await assert.rejects(
    service.startCapture({ label: "单1-0.5m", durationSeconds: 45 }),
    (error) => error.code === "SERIAL_NOT_CONNECTED",
  );

  await service.connect({ path: "COM_TEST", baudRate: 115200 });
  await service.startCapture({ label: "单1-0.5m", durationSeconds: 45 });
  await assert.rejects(
    service.startCapture({ label: "单1-1m", durationSeconds: 45 }),
    (error) => error.code === "CAPTURE_ALREADY_RUNNING",
  );

  await service.disconnect();
  assert.equal(service.currentCapture().status, "interrupted");
});
