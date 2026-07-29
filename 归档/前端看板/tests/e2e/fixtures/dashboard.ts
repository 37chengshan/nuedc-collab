import { test as base, expect } from "@playwright/test";
import { installDashboardApi, type DashboardFixture } from "./api";

type DashboardFixtures = {
  dashboard: DashboardFixture;
};

export const test = base.extend<DashboardFixtures>({
  dashboard: async ({ page }, use) => {
    await use(await installDashboardApi(page));
  },
});

export { expect };
