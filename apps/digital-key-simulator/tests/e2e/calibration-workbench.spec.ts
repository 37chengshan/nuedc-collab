import { expect, test } from "@playwright/test";

async function openCalibration(page) {
  await page.goto("/");
  await page.getByRole("button", { name: "现场标定" }).click();
  await expect(
    page.getByRole("heading", { name: "现场标定", exact: true }),
  ).toBeVisible();
}

async function expectInsideViewport(page, locator) {
  const [viewport, box] = await Promise.all([
    page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    })),
    locator.boundingBox(),
  ]);
  expect(box).not.toBeNull();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
}

test("桌面主工作台为左侧大地图和右侧控制台", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");

  const scene = page.locator(".scene-panel");
  const consolePanel = page.locator(".operator-console");
  await expect(scene).toBeVisible();
  await expect(consolePanel).toBeVisible();
  await expect(page.getByRole("heading", { name: "控制台" })).toBeVisible();

  const [sceneBox, consoleBox] = await Promise.all([
    scene.boundingBox(),
    consolePanel.boundingBox(),
  ]);
  expect(sceneBox).not.toBeNull();
  expect(consoleBox).not.toBeNull();
  expect(sceneBox.width).toBeGreaterThan(consoleBox.width * 1.6);
  expect(Math.abs(sceneBox.y - consoleBox.y)).toBeLessThanOrEqual(2);
  expect(sceneBox.height).toBeGreaterThan(760);
  const desktopOverflow = await page.evaluate(() => ({
    viewportHeight: document.documentElement.clientHeight,
    pageHeight: document.documentElement.scrollHeight,
  }));
  expect(desktopOverflow.pageHeight).toBeLessThanOrEqual(
    desktopOverflow.viewportHeight + 1,
  );
  await page.screenshot({
    path: testInfo.outputPath("live-operator-desktop.png"),
    fullPage: true,
  });

  await page.getByRole("button", { name: "链路", exact: true }).click();
  await expect(page.getByText("拟合输入摘要")).toBeVisible();
  await expect(page.getByRole("heading", { name: "串口链路" })).toBeVisible();
});

test("桌面现场标定地图、采集门槛和Agent状态可用", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await openCalibration(page);

  await expect(
    page.getByRole("application", { name: /现场标定地图/ }),
  ).toBeVisible();
  await expect(page.getByText("稳定倒计时")).toBeVisible();
  await expect(page.getByText("同步组门槛")).toBeVisible();
  await expect(page.getByText("标定距离 / m")).toBeVisible();
  await expect(page.getByText("标定角度 / °")).toBeVisible();
  const serialButton = page.getByRole("button", {
    name: /连接串口|断开串口/,
  });
  await expect(serialButton).toBeVisible();
  await expect(page.getByText("下一点", { exact: true })).toBeVisible();
  const captureButton = page.getByRole("button", {
    name: "开始现场采集",
  });
  await expect(captureButton).toBeVisible();
  if ((await serialButton.textContent())?.includes("连接串口")) {
    await expect(captureButton).toBeDisabled();
  } else {
    await expect(captureButton).toBeEnabled();
  }
  await expect(page.getByRole("heading", { name: "质量" })).toBeVisible();
  await expectInsideViewport(
    page,
    page.getByRole("heading", { name: "质量" }),
  );
  const calibrationOverflow = await page.evaluate(() => ({
    viewportHeight: document.documentElement.clientHeight,
    pageHeight: document.documentElement.scrollHeight,
  }));
  expect(calibrationOverflow.pageHeight).toBeLessThanOrEqual(
    calibrationOverflow.viewportHeight + 1,
  );
  await page.screenshot({
    path: testInfo.outputPath("calibration-desktop.png"),
    fullPage: true,
  });

  await page.getByRole("button", { name: "分析", exact: true }).click();
  await expect(page.getByText("误差热力图")).toBeVisible();
  await expectInsideViewport(page, page.getByText("误差热力图"));

  await page.getByRole("button", { name: "模型", exact: true }).click();
  await expect(page.getByText("模型版本")).toBeVisible();
  await expectInsideViewport(page, page.getByText("模型版本"));

  await page.getByRole("button", { name: "基站", exact: true }).click();
  const saveSetupButton = page.getByRole("button", {
    name: /保存场地配置|已保存/,
  });
  await expect(saveSetupButton).toBeVisible();
  await expectInsideViewport(
    page,
    saveSetupButton,
  );

  await page.getByRole("button", { name: "采集", exact: true }).click();

  const map = page.getByRole("application", { name: /现场标定地图/ });
  const yReadout = page.locator(".truth-derived-strip span").nth(1);
  await expect(yReadout).toContainText("1000 mm");
  await map.focus();
  await page.keyboard.press("ArrowUp");
  await expect(yReadout).toContainText("1050 mm");

  const agentState = await page.evaluate(async () => {
    const result = await window.digitalKeyAgent.v1.query(
      "calibration.candidate.get",
      {},
    );
    return result;
  });
  expect(agentState).toBeTruthy();

  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(
    dimensions.viewport + 1,
  );
});

test("390×844手机视口折叠面板可达且无横向溢出", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCalibration(page);

  await expect(page.locator(".calibration-console")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "采集", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "开始现场采集" }),
  ).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(
    dimensions.viewport + 1,
  );
  await page.screenshot({
    path: testInfo.outputPath("calibration-mobile.png"),
    fullPage: true,
  });
});

test("减少动态效果时现场标定不保留持续动画", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openCalibration(page);
  const animated = await page.locator(".calibration-workbench").evaluate(
    (root) =>
      [...root.querySelectorAll<HTMLElement>("*")]
        .map((element) => {
          const style = getComputedStyle(element);
          return {
            durationSeconds:
              Number.parseFloat(style.animationDuration) || 0,
            iterationCount: style.animationIterationCount,
          };
        })
        .filter(
          (animation) =>
            animation.durationSeconds > 0.001 ||
            animation.iterationCount === "infinite",
        ),
  );
  expect(animated).toEqual([]);
});
