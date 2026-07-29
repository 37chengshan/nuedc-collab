import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures/dashboard";

const routes = ["/", "/tasks", "/issues", "/ideas", "/history", "/materials", "/design", "/settings"];
const widths = [320, 375, 768, 1024, 1440, 2560];

test.describe("可访问性和响应式验收", () => {
  for (const route of routes) {
    test(`${route} 无 axe 严重违规`, async ({ page }) => {
      await page.goto(route);
      await expect(page.getByRole("main")).toBeVisible();
      const result = await new AxeBuilder({ page })
        .disableRules(["page-has-heading-one"])
        .analyze();
      expect(result.violations).toEqual([]);
    });
  }

  for (const width of widths) {
    test(`${width}px 无横向溢出且关键控件可达`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/tasks");
      await expect(page.getByRole("main")).toBeVisible();
      const measurements = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(measurements.scrollWidth).toBeLessThanOrEqual(measurements.viewport + 1);

      const menu = page.getByRole("button", { name: /打开侧栏/ });
      const desktopTaskLink = page.getByRole("link", { name: /任务/ }).first();
      if (width < 1024) {
        await expect(menu).toBeVisible();
        await menu.click();
        await expect(page.getByRole("dialog", { name: /导航/ })).toBeVisible();
        await expect(page.getByRole("dialog").getByRole("link", { name: /任务/ })).toBeVisible();
      } else {
        await expect(desktopTaskLink).toBeVisible();
      }

      const primary = page.getByRole("button", { name: /新建任务|创建任务/ });
      await primary.scrollIntoViewIfNeeded();
      const box = await primary.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    });
  }

  test("键盘可打开和关闭抽屉，并将焦点保留在对话范围内", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto("/");
    await page.getByRole("button", { name: /打开侧栏/ }).focus();
    await page.keyboard.press("Enter");
    const drawer = page.getByRole("dialog", { name: /导航/ });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("button", { name: /关闭/ })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(page.getByRole("button", { name: /打开侧栏/ })).toBeFocused();
  });

  test("对话框按 Escape 关闭并将焦点返还触发器", async ({ page }) => {
    await page.goto("/tasks");
    const trigger = page.getByRole("button", { name: /新建任务|创建任务/ });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: /关闭/ })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("reduced-motion 下不保留持续性动画", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    const animated = await page.locator("body").evaluate(() => {
      const durations = [...document.querySelectorAll<HTMLElement>("*")]
        .slice(0, 300)
        .map((element) => getComputedStyle(element).animationDuration)
        .filter((value) => value && value !== "0s");
      return durations;
    });
    expect(animated).toEqual([]);
  });
});
