import { describe, expect, it } from "vitest";
import { labelTaskStatus, shortHash } from "@/lib/format";

describe("format helpers", () => {
  it("格式化状态和提交号", () => {
    expect(labelTaskStatus("doing")).toBe("进行中");
    expect(shortHash("1234567890")).toBe("1234567");
    expect(shortHash(null)).toBe("—");
  });
});
