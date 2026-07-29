import { describe, expect, it } from "vitest";
import { NAV_ITEMS, isNavActive, navItemForPath } from "@/app/nav";

describe("navigation", () => {
  it("包含八个稳定页面且含想法页", () => {
    expect(NAV_ITEMS).toHaveLength(8);
    expect(NAV_ITEMS.map((item) => item.path)).toContain("/ideas");
  });

  it("正确识别当前页面", () => {
    expect(isNavActive("/tasks/T-1", "/tasks")).toBe(true);
    expect(isNavActive("/tasks", "/")).toBe(false);
    expect(navItemForPath("/issues/I-1").label).toBe("问题");
  });
});
