import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "@/components/Button";

describe("Button", () => {
  it("渲染名称并暴露禁用状态", () => {
    render(<Button disabled>创建任务</Button>);
    expect(screen.getByRole("button", { name: "创建任务" })).toBeDisabled();
  });

  it("加载时保持 aria-busy", () => {
    render(<Button loading>提交</Button>);
    expect(screen.getByRole("button", { name: "提交" })).toHaveAttribute("aria-busy", "true");
  });
});
