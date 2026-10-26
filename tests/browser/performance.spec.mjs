import { test, expect } from "@playwright/test";

// Trace capture changes animation timing; measure the game, not the recorder.
test.use({ trace: "off" });
test("free-steering animation meets the reference-browser frame budget", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await page.locator("#start").click();
  await expect(page.locator("#welcome")).not.toBeVisible();
  await page.keyboard.down("w");
  await page.keyboard.down("a");
  const performance = await page.evaluate(() => new Promise(resolve => {
    const intervals = [];
    let previous;
    function sample(now) {
      if (previous) intervals.push(now - previous);
      previous = now;
      if (intervals.length < 90) requestAnimationFrame(sample);
      else resolve({
        fps: 1000 / (intervals.reduce((a, b) => a + b, 0) / intervals.length),
        samples: intervals.length,
      });
    }
    requestAnimationFrame(sample);
  }));
  await page.keyboard.up("w");
  await page.keyboard.up("a");
  await expect(page.locator("#speed")).not.toHaveText("0");
  await expect(page.locator("#junction")).not.toBeVisible();
  await expect(page.locator("#error-dialog")).not.toBeVisible();
  console.log(`${testInfo.project.name} free-steering FPS: ${performance.fps.toFixed(1)}`);
  await testInfo.attach("animation-performance", { body: JSON.stringify(performance), contentType: "application/json" });
  expect(performance.fps).toBeGreaterThanOrEqual(testInfo.project.name === "phone" ? 30 : 55);
});
