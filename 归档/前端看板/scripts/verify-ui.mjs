#!/usr/bin/env node
import { chromium } from "playwright";
import process from "node:process";

const baseURL = process.env.E2E_BASE_URL || "http://127.0.0.1:5173";
const routes = ["/", "/tasks", "/issues", "/ideas", "/history", "/materials", "/design", "/settings"];
const widths = [320, 375, 768, 1024, 1440, 2560];
const browser = await chromium.launch({ headless: true });
const failures = [];

try {
  for (const width of widths) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, locale: "zh-CN" });
    for (const route of routes) {
      try {
        await page.goto(new URL(route, baseURL).toString(), { waitUntil: "networkidle" });
        const metrics = await page.evaluate(() => ({
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          hasMain: Boolean(document.querySelector("main")),
          heading: document.querySelector("h1")?.textContent?.trim() || "",
        }));
        if (!metrics.hasMain) throw new Error("缺少 main 主内容地标");
        if (!metrics.heading) throw new Error("缺少页面 h1");
        if (metrics.scrollWidth > metrics.clientWidth + 1) {
          throw new Error(`横向溢出 ${metrics.scrollWidth - metrics.clientWidth}px`);
        }
        console.log(`PASS ${width}px ${route} — ${metrics.heading}`);
      } catch (error) {
        failures.push({ width, route, error: error instanceof Error ? error.message : String(error) });
        console.error(`FAIL ${width}px ${route} — ${failures.at(-1).error}`);
      }
    }
    await page.close();
  }
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`UI 验证失败：${failures.length} 项。`);
  process.exitCode = 1;
}
