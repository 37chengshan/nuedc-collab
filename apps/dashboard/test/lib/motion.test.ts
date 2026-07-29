import { describe, expect, it } from "vitest";
import { durationMs, resolveMotionLevel } from "@/lib/motion";

describe("motion", () => {
  it("尊重系统减少动效偏好", () => {
    expect(resolveMotionLevel("system", true)).toBe("reduced");
    expect(durationMs("drawer", "reduced")).toBe(100);
    expect(durationMs("page", "none")).toBe(0);
  });
});
