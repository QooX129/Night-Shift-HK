import { test, expect } from "@playwright/test";

test.use({ trace: "off" });

test("3D district renders locally and toggles without resetting the shift or changing physics", async ({ page }, testInfo) => {
  const errors = [], external = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (!request.url().startsWith("http://127.0.0.1:8765")) external.push(request.url());
  });
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs");
    const render = Map3DView.prototype.render;
    Map3DView.prototype.render = function (...args) {
      window.threeView = this;
      window.threeCar = { ...args[0] };
      return render.apply(this, args);
    };
  });
  await page.locator("#start").click();
  await expect(page.locator("#welcome")).not.toBeVisible();
  await page.locator("#view-mode").click();
  await expect(page.locator("#map-3d")).toBeVisible();
  await expect(page.locator("#view-mode")).toHaveText("2D");
  await expect(page.locator("#view-mode")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#view-error")).not.toBeVisible();
  await expect.poll(() => page.evaluate(() => Boolean(window.threeView))).toBe(true);
  const before = await page.evaluate(() => ({
    x: window.threeCar.x, y: window.threeCar.y, heading: window.threeCar.heading,
  }));
  const result = await page.evaluate(() => {
    const view = window.threeView;
    return {
      buildings: view.buildingCount, blocks: view.buildings.length,
      triangles: view.renderer.info.render.triangles,
      taxi: view.taxi.position.toArray(), rotation: view.taxi.rotation.y,
      faded: view.buildings.filter(mesh => mesh.visible && mesh.material.opacity < 1).length,
      cameraHeight: view.lens.position.y, ground: Boolean(view.scene.getObjectByName("district-roads")),
      geometries: view.renderer.info.memory.geometries,
    };
  });
  expect(result.buildings).toBeGreaterThan(3000);
  expect(result.blocks).toBeLessThan(1500);
  expect(result.triangles).toBeGreaterThan(1000);
  expect(result.taxi).toEqual([before.x, 0, before.y]);
  expect(result.rotation).toBe(-before.heading);
  expect(result.faded).toBeGreaterThan(0);
  expect(result.cameraHeight).toBeGreaterThan(10);
  expect(result.ground).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("3d-chase.png") });

  await page.locator("#language").click();
  await expect(page.locator("#view-status")).toContainText("3D 預覽");
  await expect(page.locator("#view-mode")).toHaveAttribute("aria-label", "切換至 2D 地圖");
  await page.locator("#zoom-in").click();
  await page.locator("#overview").click();
  await expect.poll(() => page.evaluate(() => window.threeView.overview)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.threeView.lens.position.y)).toBeGreaterThan(500);
  await page.locator("#overview").click();
  const originalSize = page.viewportSize();
  await page.setViewportSize({ width: originalSize.width - 30, height: originalSize.height - 30 });
  await expect.poll(() => page.evaluate(() => window.threeView.lens.aspect))
    .toBeCloseTo((originalSize.width - 30) / (originalSize.height - 30), 5);
  await page.setViewportSize(originalSize);
  for (let i = 0; i < 3; i++) {
    await page.locator("#view-mode").click();
    await expect(page.locator("#map")).toBeVisible();
    await expect(page.locator(".world-label")).not.toBeVisible();
    await page.locator("#view-mode").click();
    await expect(page.locator("#map-3d")).toBeVisible();
  }
  const after = await page.evaluate(() => ({
    x: window.threeCar.x, y: window.threeCar.y, heading: window.threeCar.heading,
  }));
  expect(after).toEqual(before);
  await page.keyboard.down("w");
  await expect(page.locator("#speed")).not.toHaveText("0");
  await page.keyboard.up("w");
  await expect(page.locator("#error-dialog")).not.toBeVisible();
  await page.evaluate(() => {
    document.querySelector("#map-3d").dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
  });
  await expect(page.locator("#map")).toBeVisible();
  await expect(page.locator("#view-error")).toBeVisible();
  await expect(page.locator(".road-label")).toHaveCount(0);
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});

test.describe("3D animation", () => {
  test("chase view stays responsive with the real district geometry", async ({ page }, testInfo) => {
    await page.goto("/");
    await expect(page.locator("#start")).toBeEnabled();
    await page.locator("#start").click();
    await page.locator("#view-mode").click();
    await expect(page.locator("#map-3d")).toBeVisible();
    await page.keyboard.down("w");
    const fps = await page.evaluate(() => new Promise(resolve => {
      const intervals = [];
      let previous;
      function sample(now) {
        if (previous) intervals.push(now - previous);
        previous = now;
        if (intervals.length < 60) requestAnimationFrame(sample);
        else resolve(1000 / (intervals.reduce((a, b) => a + b, 0) / intervals.length));
      }
      requestAnimationFrame(sample);
    }));
    await page.keyboard.up("w");
    console.log(`${testInfo.project.name} 3D chase FPS: ${fps.toFixed(1)}`);
    expect(fps).toBeGreaterThanOrEqual(24);
    await expect(page.locator("#error-dialog")).not.toBeVisible();
  });
});

test("unsupported WebGL keeps 2D usable and reports the initialization error", async ({ page }) => {
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (type === "webgl2") return null;
      return getContext.call(this, type, ...args);
    };
  });
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await page.locator("#start").click();
  await page.locator("#view-mode").click();
  await expect(page.locator("#view-error")).toContainText("Could not start 3D");
  await expect(page.locator("#map")).toBeVisible();
  await expect(page.locator("#map-3d")).not.toBeVisible();
  await expect(page.locator("#view-mode")).toBeEnabled();
  await page.keyboard.down("w");
  await expect(page.locator("#speed")).not.toHaveText("0");
  await page.keyboard.up("w");
});
