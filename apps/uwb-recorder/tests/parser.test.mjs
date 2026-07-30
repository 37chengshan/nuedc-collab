import test from "node:test";
import assert from "node:assert/strict";

import { parseUwbFrames, UwbStreamParser } from "../src/parser.js";

test("解析门端通用测距帧", () => {
  assert.deepEqual(parseUwbFrames("re:P,0A00,103cm"), [
    {
      raw: "re:P,0A00,103cm",
      linkIndex: null,
      device: null,
      address: "0A00",
      distanceCm: 103,
      snrDb: null,
    },
  ]);
});

test("解析基站两路距离和负SNR", () => {
  assert.deepEqual(parseUwbFrames("re:P1,0200,131cm,-1.9dB"), [
    {
      raw: "re:P1,0200,131cm,-1.9dB",
      linkIndex: 1,
      device: 2,
      address: "0200",
      distanceCm: 131,
      snrDb: -1.9,
    },
  ]);
});

test("处理串口分片和换行", () => {
  const parser = new UwbStreamParser();
  assert.deepEqual(parser.push("P0,0100,10"), []);
  assert.deepEqual(parser.push("3cm,18dB\r\n").map((item) => item.kind), [
    "frame",
  ]);
});

test("处理无换行连续粘包", () => {
  const parser = new UwbStreamParser();
  const messages = parser.push(
    "P0,0100,93cm,18dBP1,0200,74cm,9dB",
  );
  assert.equal(messages.length, 2);
  assert.deepEqual(
    messages.map((message) => [
      message.device,
      message.distanceCm,
      message.snrDb,
    ]),
    [
      [1, 93, 18],
      [2, 74, 9],
    ],
  );
});

test("保留无法解析的AT回复", () => {
  const parser = new UwbStreamParser();
  assert.deepEqual(parser.push("re:OK\r\n"), [
    { kind: "text", raw: "re:OK" },
  ]);
});
