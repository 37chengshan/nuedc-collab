import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Dialog } from "@/components/Dialog";

describe("Dialog", () => {
  it("提供对话框语义并可点击关闭", async () => {
    const onClose = vi.fn();
    render(<Dialog open title="新建任务" onClose={onClose}><p>表单</p></Dialog>);
    expect(screen.getByRole("dialog", { name: "新建任务" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
