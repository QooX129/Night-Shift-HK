import { expect } from "@playwright/test";

export async function toggleDrivingView(page) {
  await expect(page.locator("#welcome")).toBeHidden();
  const next = await page.locator("#map-3d").isVisible() ? "2d" : "3d";
  const alreadyPaused = await page.locator("#pause-dialog").isVisible();
  if (!alreadyPaused) await page.locator("#pause").click();
  await page.locator("#pause-settings").click();
  await page.locator('[data-category="display"]').click();
  await page.locator('[data-setting="defaultView"]').selectOption(next);
  if (next === "3d") await expect.poll(async () =>
    await page.locator("#map-3d").isVisible() || await page.locator("#view-error").isVisible()).toBe(true);
  else await expect(page.locator("#map")).toBeVisible();
  await page.locator("#settings-close").click();
  if (!alreadyPaused) {
    await page.locator("#resume").click();
    await expect(page.locator("#pause-dialog")).toBeHidden();
  }
}

export async function useLegacyInitialView(page) {
  await page.addInitScript(() => {
    if (!localStorage.getItem("night-shift-hk.settings.v1")) {
      localStorage.setItem("night-shift-hk.settings.v1", JSON.stringify({ defaultView: "2d" }));
    }
  });
}
