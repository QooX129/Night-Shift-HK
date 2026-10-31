import { test, expect } from "@playwright/test";

test("junction selector can be disabled for manual driving and reset in Interface", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await page.locator("#welcome-settings").click();
  await page.locator('[data-category="interface"]').click();
  const toggle = page.locator('[data-setting="junctionSelector"]');
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await page.locator("#settings-close").click();
  await page.reload();
  await expect(page.locator("#start")).toBeEnabled();
  await page.locator("#start").click();
  await expect(page.locator("#welcome")).toBeHidden();
  await page.keyboard.down("w");
  await page.waitForTimeout(7000);
  await page.keyboard.up("w");
  await expect(page.locator("#junction")).toBeHidden();
  await expect(page.locator("#error-dialog")).toBeHidden();
  await page.locator("#pause").click();
  await expect(page.locator("#pause-dialog")).toBeVisible();
  await page.locator("#pause-settings").click();
  await page.locator('[data-category="interface"]').click();
  await expect(toggle).not.toBeChecked();
  await page.locator("#settings-reset").click();
  await expect(toggle).toBeChecked();
});

test("welcome settings persist preferences and close back to welcome without saving a shift", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await expect(page.locator("#settings-dialog")).toBeHidden();
  await page.locator("#welcome-settings").click();
  await expect(page.locator("#settings-dialog")).toBeVisible();
  await expect(page.locator("#welcome")).toBeHidden();
  await page.locator('[data-category="language"]').click();
  await page.locator('[data-setting="language"]').selectOption("zh");
  await expect(page.locator("#settings-title")).toHaveText("遊戲設定");
  await expect(page.locator('[data-setting="defaultView"]')).toHaveValue("2d");
  await page.keyboard.press("Escape");
  await expect(page.locator("#settings-dialog")).toBeHidden();
  await expect(page.locator("#welcome")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hant");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("night-shift-hk.settings.v1")));
  expect(saved.language).toBe("zh");
  expect(await page.evaluate(() => Object.keys(window.localStorage))).toEqual(["night-shift-hk.settings.v1"]);
  await page.reload();
  await expect(page.locator("#start")).toBeEnabled();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hant");
  await expect(page.locator("#welcome")).toBeVisible();
  await expect(page.locator("#clock")).toHaveText("00:00");
});

test("pause settings reset one category and return to pause without resuming", async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await page.locator("#start").click();
  await expect(page.locator("#welcome")).toBeHidden();
  await page.locator("#pause").click();
  await expect(page.locator("#pause-dialog")).toBeVisible();
  await page.locator("#pause-settings").click();
  await expect(page.locator("#settings-dialog")).toBeVisible();
  await expect(page.locator("#pause-dialog")).toBeHidden();
  await page.locator('[data-setting="graphics"]').selectOption("performance");
  await expect(page.locator('[data-setting="graphics"]')).toHaveValue("performance");
  await page.locator("#settings-reset").click();
  await expect(page.locator('[data-setting="graphics"]')).toHaveValue("auto");
  await expect(page.locator("#settings-message")).toContainText("reset");
  const clock = await page.locator("#clock").textContent();
  await page.keyboard.press("Escape");
  await expect(page.locator("#settings-dialog")).toBeHidden();
  await expect(page.locator("#pause-dialog")).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.locator("#clock")).toHaveText(clock);
});

test("settings tabs are keyboard-accessible and adapt to mobile layout", async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto("/");
  await page.locator("#welcome-settings").click();
  const tabs = page.locator(".settings-tab");
  await expect(tabs).toHaveCount(5);
  await tabs.first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#settings-camera")).toBeVisible();
  if (page.viewportSize().width <= 700) {
    await expect(page.locator(".settings-categories")).toHaveCSS("flex-direction", "row");
    await expect(page.locator("#settings-dialog")).toBeInViewport();
  } else {
    await expect(page.locator(".settings-categories")).toHaveCSS("flex-direction", "column");
  }
});

test("blocked browser storage reports load and save errors in settings", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new DOMException("blocked", "SecurityError"); };
    Storage.prototype.setItem = () => { throw new DOMException("blocked", "SecurityError"); };
  });

  await page.goto("/");
  await expect(page.locator("#welcome-settings-message")).toContainText("could not be read");
  await page.locator("#welcome-settings").click();
  await page.locator('[data-category="language"]').click();
  await expect(page.locator("#settings-message")).toContainText("could not be read");
  await page.locator('[data-setting="language"]').selectOption("zh");
  await expect(page.locator("#settings-message")).toContainText("無法儲存設定");
});

test("interface preferences apply immediately and numeric refresh selection persists", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#start")).toBeEnabled();
    await page.locator("#welcome-settings").click();
    await page.locator('[data-setting="defaultView"]').selectOption("3d");
    await expect(page.locator("#map-3d")).toBeVisible();
    await page.locator('[data-category="interface"]').click();
    await page.locator('[data-setting="minimapRefreshRate"]').selectOption("30");
    await expect(page.locator('[data-setting="minimapRefreshRate"]')).toHaveValue("30");
    await page.locator('[data-setting="minimapVisible"]').uncheck();
    await expect(page.locator("#minimap-panel")).toBeHidden();
    await page.locator('[data-setting="minimapVisible"]').check();
    await expect(page.locator("#minimap-panel")).toBeVisible();
    await page.locator('[data-setting="minimapSize"]').selectOption("small");
    const small = await page.locator("#minimap-panel").boundingBox();
    await page.locator('[data-setting="minimapSize"]').selectOption("large");
    const large = await page.locator("#minimap-panel").boundingBox();
    expect(large.width).toBeGreaterThan(small.width);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("night-shift-hk.settings.v1")));
    expect(saved.minimapRefreshRate).toBe(30);
    expect(saved.defaultView).toBe("3d");
    await page.locator("#settings-reset").click();
    await expect(page.locator('[data-setting="minimapRefreshRate"]')).toHaveValue("60");
    await page.locator('[data-category="display"]').click();
    await page.locator('[data-setting="defaultView"]').selectOption("2d");
    await expect(page.locator("#map-3d")).toBeHidden();
    await expect(page.locator("#minimap-panel")).toBeHidden();
});
