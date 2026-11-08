import { expect, test } from "@playwright/test";

test("login screen is reachable", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("login-submit")).toBeVisible();
});
