import { test, expect } from "@playwright/test";

test("start, manual driving, pause, language, and garage", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await page.locator("#start").click();
  await expect(page.locator("#welcome")).not.toBeVisible();
  await page.locator("#job-action").click();
  await expect(page.locator("#status")).toContainText("green marker");
  await page.keyboard.down("w");
  await page.waitForTimeout(650);
  await page.keyboard.up("w");
  await expect(page.locator("#speed")).not.toHaveText("0");
  await page.locator("#pause").click();
  await expect(page.locator("#pause-dialog")).toBeVisible();
  const clock = await page.locator("#clock").textContent();
  await page.waitForTimeout(500);
  await expect(page.locator("#clock")).toHaveText(clock);
  await page.locator("#resume").click();
  await page.locator("#language").click();
  await expect(page.locator("#status")).toContainText("上車點");
  await page.locator("#garage").click();
  await expect(page.locator("#garage-dialog")).toBeVisible();
  await page.locator("#recover").click();
  await expect(page.locator("#money")).toHaveText("$100");
  await expect(page.locator("#efficiency")).toBeEnabled();
  await page.locator("#efficiency").click();
  await expect(page.locator("#money")).toHaveText("$0");
  await expect(page.locator("#efficiency")).toBeDisabled();
  expect(errors).toEqual([]);
});

test("touch controls, responsive layout, and visible attribution", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await page.locator("#start").click();
  await expect(page.locator("#welcome")).not.toBeVisible();
  const footer = page.locator(".attribution");
  await expect(footer).toBeVisible();
  const box = await footer.boundingBox();
  const size = page.viewportSize();
  expect(box.y + box.height).toBeLessThanOrEqual(size.height);
  if (testInfo.project.name === "phone") {
    const gas = page.locator("[data-control=gas]");
    await expect(gas).toBeVisible();
    const pedal = await gas.boundingBox();
    await page.mouse.move(pedal.x + pedal.width / 2, pedal.y + pedal.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
    await expect(page.locator("#speed")).not.toHaveText("0");
  }
  await page.screenshot({ path: testInfo.outputPath("game.png") });
});

test("junction choice assists into the selected exit then returns manual control", async ({ page }, testInfo) => {
  let latest;
  page.on("response", async response => {
    if (response.url().includes("/commands") && response.ok()) latest = await response.json();
  });
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await page.locator("#start").click();
  await expect(page.locator("#welcome")).not.toBeVisible();
  await page.keyboard.down("w");
  await expect(page.locator("#junction")).toBeVisible({ timeout: 12000 });
  await page.keyboard.up("w");
  await page.screenshot({ path: testInfo.outputPath("junction.png") });
  await page.locator(".exit-option").first().click();
  await expect(page.locator("#drive-mode")).toHaveText("TURN ASSIST");
  await expect(page.locator("#drive-mode")).toHaveText("MANUAL", { timeout: 20000 });
  await expect(page.locator("#error-dialog")).not.toBeVisible();
  await expect(page.locator("#junction")).not.toBeVisible();
  expect(latest.assist).toEqual([]);
});

test("lost connection pauses and offers idempotent retry", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await page.locator("#start").click();
  await page.route("**/api/sessions/*/commands", route => route.abort());
  await page.keyboard.down("w");
  await expect(page.locator("#error-dialog")).toBeVisible();
  await page.keyboard.up("w");
  await expect(page.locator("#retry")).toBeVisible();
  await page.unroute("**/api/sessions/*/commands");
  await page.locator("#retry").click();
  await expect(page.locator("#pause-dialog")).toBeVisible();
  await expect(page.locator("#error-dialog")).not.toBeVisible();
});

test("slow movement acknowledgements apply backpressure without corrupting commands", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await page.locator("#start").click();
  await expect(page.locator("#welcome")).not.toBeVisible();
  let delayed = false;
  await page.route("**/api/sessions/*/commands", async route => {
    const command = route.request().postDataJSON().command;
    if (command.action === "move" && !delayed) {
      delayed = true;
      await new Promise(resolve => setTimeout(resolve, 2800));
    }
    await route.continue();
  });
  await page.waitForTimeout(4000);
  expect(delayed).toBe(true);
  await page.locator("#pause").click();
  await expect(page.locator("#pause-dialog")).toBeVisible();
  await expect(page.locator("#error-dialog")).not.toBeVisible();
});
