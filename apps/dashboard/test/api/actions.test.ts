import { describe, expect, it } from "vitest";
import { isDomainAction } from "@/api/actions";

describe("domain actions", () => {
  it("只接受协议动作，不接受 git 写动作", () => {
    expect(isDomainAction("task.create")).toBe(true);
    expect(isDomainAction("idea.promoteToTask")).toBe(true);
    expect(isDomainAction("git.commit")).toBe(false);
  });
});
