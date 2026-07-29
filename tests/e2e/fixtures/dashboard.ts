import { test as base, expect } from "@playwright/test";
import { installDashboardApi, type DashboardFixture } from "./api";

type DashboardFixtures = {
  dashboard: DashboardFixture;
  _dashboardApi: void;
};

const installed = new WeakMap<object, DashboardFixture>();

export const test = base.extend<DashboardFixtures>({
  _dashboardApi: [async ({ page }, use) => {
    installed.set(page, await installDashboardApi(page));
    await use();
  }, { auto: true }],
  dashboard: async ({ page, _dashboardApi }, use) => {
    void _dashboardApi;
    const fixture = installed.get(page);
    if (!fixture) throw new Error("Dashboard API fixture was not installed");
    await use(fixture);
  },
});

export { expect };
