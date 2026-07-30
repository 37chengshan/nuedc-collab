import test from "node:test";
import assert from "node:assert/strict";

import { schemaAtPath, successEnvelope } from "../src/contracts.js";
import {
  buildWriteCommands,
  validateParameters,
} from "../src/serial-service.js";

const validParameters = {
  interval: 100,
  role: 1,
  channel: 9,
  baudCode: 4,
  power: 3,
  responders: 2,
  source: "0A00",
  destinations: ["0100", "0200", "0000", "0000", "0000"],
};

test("Agent schema exposes read and mutating resources", () => {
  assert.equal(schemaAtPath("status.get").safety, "read");
  assert.equal(schemaAtPath("parameters.writeToModule").safety, "mutating");
  assert.equal(schemaAtPath("sessions.delete").safety, "destructive");
});

test("success envelope carries schema version", () => {
  const envelope = successEnvelope({ value: 1 });
  assert.equal(envelope.ok, true);
  assert.match(envelope.meta.schemaVersion, /^\d+\.\d+\.\d+$/);
});

test("parameter validation normalizes addresses", () => {
  const parameters = validateParameters({
    ...validParameters,
    source: "0a00",
  });
  assert.equal(parameters.source, "0A00");
});

test("write commands use one 20-character destination string", () => {
  const result = buildWriteCommands(validParameters);
  assert.equal(
    result.commands.at(-1),
    "AT+DSTADDR=01000200000000000000",
  );
});

test("invalid interval is rejected before serial access", () => {
  assert.throws(
    () => validateParameters({ ...validParameters, interval: 1 }),
    /20～2000/,
  );
});
