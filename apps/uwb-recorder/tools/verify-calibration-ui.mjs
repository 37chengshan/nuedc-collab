import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const baseUrl = process.env.UWB_UI_URL ?? "http://127.0.0.1:4173";
const outputDirectory = resolve(
  process.env.UWB_UI_ARTIFACTS ?? "./artifacts",
);
const playwrightModule = process.env.CODEX_NODE_MODULES
  ? pathToFileURL(
      join(process.env.CODEX_NODE_MODULES, "playwright", "index.mjs"),
    ).href
  : "playwright";
const edgeExecutable =
  process.env.EDGE_EXECUTABLE ??
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const { chromium } = await import(playwrightModule);

await mkdir(outputDirectory, { recursive: true });
const browser = await chromium.launch({
  executablePath: edgeExecutable,
  headless: true,
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
});
const consoleErrors = [];
const pageErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") {
    consoleErrors.push(message.text());
  }
});
page.on("pageerror", (error) => pageErrors.push(error.message));

try {
  await page.route("**/api/calibration/capture", async (route) => {
    const body = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          pointId: body.pointId,
          distanceM: body.distanceM,
          angleDeg: body.angleDeg,
          accepted: false,
          synchronizedGroups: 80,
          perAnchor: [
            {
              anchorId: 1,
              samples: 110,
              synchronizedSamples: 80,
              addresses: ["0A00"],
              medianCm: 101.2,
              spreadCm: 0.8,
              snrDb: 12,
              expectedDistanceCm: 101,
              residualCm: 0.2,
            },
            {
              anchorId: 2,
              samples: 110,
              synchronizedSamples: 80,
              addresses: ["0A00"],
              medianCm: 102.1,
              spreadCm: 0.9,
              snrDb: 11.5,
              expectedDistanceCm: 102,
              residualCm: 0.1,
            },
          ],
          recaptureReasons: [
            {
              code: "INSUFFICIENT_SYNCHRONIZED_SAMPLES",
              message: "同步样本不足",
            },
          ],
        },
        meta: {
          schemaVersion: "1.2.0",
          timestamp: new Date().toISOString(),
        },
      }),
    });
  });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForFunction(
    () =>
      document.querySelectorAll(
        "#calibration-plan [data-calibration-index]",
      ).length === 77,
  );

  assert.match(
    await page.locator("#calibration h2").first().innerText(),
    /距离与角度拟合向导/,
  );
  assert.equal(
    await page
      .locator("#calibration-plan [data-calibration-index]")
      .count(),
    77,
  );
  assert.match(
    await page.locator("#calibration-plan-summary").innerText(),
    /0 \/ 77 点可训练/,
  );

  await page
    .locator('#calibration-plan [data-calibration-index="76"]')
    .click();
  assert.match(
    await page.locator("#calibration-current-point").innerText(),
    /第 77 \/ 77 点/,
  );

  await page.locator("#calibration-anchor-count").selectOption("4");
  assert.equal(
    await page.locator("#calibration-anchor-count").inputValue(),
    "4",
  );

  const canvasMetrics = await page
    .locator("#calibration canvas")
    .evaluateAll((canvases) =>
      canvases.map((canvas) => ({
        id: canvas.id,
        width: canvas.width,
        height: canvas.height,
        visibleWidth: canvas.getBoundingClientRect().width,
        visibleHeight: canvas.getBoundingClientRect().height,
      })),
    );
  assert.equal(canvasMetrics.length, 7);
  assert.ok(
    canvasMetrics.every(
      (canvas) =>
        canvas.width > 0 &&
        canvas.height > 0 &&
        canvas.visibleWidth > 0 &&
        canvas.visibleHeight > 0,
    ),
  );

  await page.locator("#calibration-start-button").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#calibration-status")?.dataset.kind === "error",
  );
  assert.match(
    await page.locator("#calibration-status").innerText(),
    /未通过.*重采/,
  );
  assert.match(
    await page.locator("#calibration-rejection-reasons").innerText(),
    /只有80组同地址同步数据，至少100组/,
  );
  await page
    .locator("#calibration")
    .screenshot({ path: join(outputDirectory, "calibration-desktop.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#calibration").scrollIntoViewIfNeeded();
  const mobileLayout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    reportColumns: getComputedStyle(
      document.querySelector("#calibration-report-grid"),
    ).gridTemplateColumns,
    actionColumns: getComputedStyle(
      document.querySelector(".calibration-actions"),
    ).gridTemplateColumns,
  }));
  assert.ok(mobileLayout.documentWidth <= mobileLayout.viewportWidth + 1);
  assert.equal(mobileLayout.reportColumns.split(" ").length, 1);
  assert.equal(mobileLayout.actionColumns.split(" ").length, 1);
  await page
    .locator("#calibration")
    .screenshot({ path: join(outputDirectory, "calibration-mobile.png") });

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      pointCount: 77,
      canvasCount: canvasMetrics.length,
      mobileLayout,
      screenshots: {
        desktop: join(outputDirectory, "calibration-desktop.png"),
        mobile: join(outputDirectory, "calibration-mobile.png"),
      },
    })}\n`,
  );
} finally {
  await browser.close();
}
