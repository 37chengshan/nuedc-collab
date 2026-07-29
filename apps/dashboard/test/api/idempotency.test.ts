import { describe, expect, it } from "vitest";
import { assertIdempotencyKey, createIdempotencyKey } from "@/api/idempotency";

describe("idempotency key", () => {
  it("生成可通过校验的键", () => {
    const key = createIdempotencyKey("web-task");
    expect(key.length).toBeGreaterThanOrEqual(16);
    expect(() => assertIdempotencyKey(key)).not.toThrow();
  });

  it("拒绝过短或含空格的键", () => {
    expect(() => assertIdempotencyKey("short")).toThrow();
    expect(() => assertIdempotencyKey("invalid key with spaces")).toThrow();
  });
});
