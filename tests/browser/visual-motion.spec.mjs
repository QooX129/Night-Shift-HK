import { test, expect } from "@playwright/test";

test("3D chase camera follows the taxi evenly when render start time jitters", async ({ page }) => {
  test.setTimeout(90000);
  await page.addInitScript(() => localStorage.setItem("night-shift-hk.settings.v1", JSON.stringify({
    defaultView: "3d", junctionSelector: false,
  })));
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled({ timeout: 30000 });
  await page.locator("#start").click();
  await expect(page.locator("#map-3d")).toBeVisible({ timeout: 30000 });
  await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=route-guide-1");
    const render = Map3DView.prototype.render;
    let frame = 0;
    window.cameraSamples = [];
    Map3DView.prototype.render = function (...args) {
      // Simulate uneven physics/UI work before the render call within one animation frame.
      const until = performance.now() + (frame++ % 2 ? 6 : 0);
      while (performance.now() < until);
      const result = render.apply(this, args);
      window.cameraSamples.push({ camera: { x: this.lens.position.x, z: this.lens.position.z },
        taxi: { x: this.taxi.position.x, z: this.taxi.position.z } });
      return result;
    };
  });
  await page.keyboard.down("w");
  await page.waitForTimeout(4000);
  const samples = await page.evaluate(() => window.cameraSamples.splice(0));
  await page.keyboard.up("w");
  const ratios = [];
  for (let i = 1; i < samples.length; i++) {
    const [a, b] = [samples[i - 1], samples[i]];
    const taxi = Math.hypot(b.taxi.x - a.taxi.x, b.taxi.z - a.taxi.z);
    if (taxi > 0.2) ratios.push(Math.hypot(b.camera.x - a.camera.x, b.camera.z - a.camera.z) / taxi);
  }
  expect(ratios.length).toBeGreaterThan(30);
  const worst = Math.max(...ratios.map(ratio => Math.abs(ratio - 1)));
  expect(worst).toBeLessThan(0.15);
});

for (const mode of ["2d", "3d"]) test(`${mode} renders interpolated motion and snaps when paused`, async ({ page }) => {
  test.setTimeout(90000);
  await page.addInitScript(mode => {
    localStorage.setItem("night-shift-hk.settings.v1", JSON.stringify({
      defaultView: mode, junctionSelector: false,
    }));
    window.visualSamples = [];
  }, mode);
  await page.route(/\/app\.mjs\?/, async route => {
    const response = await route.fetch();
    const source = await response.text();
    const render = "view.render(visualCar, visualState, lang, approach, preview);";
    expect(source).toContain(render);
    await route.fulfill({ response, body: source.replace(render, `
      ${render}
      window.visualSamples.push({
        visual: { x: visualCar.x, y: visualCar.y },
        current: { x: car.x, y: car.y },
        previous: previousCar && { x: previousCar.x, y: previousCar.y },
        alpha: Math.max(0, Math.min(1, stepBank * 60)), paused,
        taxi: view === map3d ? { x: map3d.taxi.position.x, y: map3d.taxi.position.z } : null,
      });
    `) });
  });
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled({ timeout: 30000 });
  await page.locator("#start").click();
  await expect(page.locator("#welcome")).not.toBeVisible();
  if (mode === "3d") await expect(page.locator("#map-3d")).toBeVisible({ timeout: 30000 });
  await page.keyboard.down("w");
  await expect.poll(() => page.evaluate(() => window.visualSamples.filter(sample =>
    sample.previous && Math.hypot(sample.visual.x - sample.current.x,
      sample.visual.y - sample.current.y) > 1e-5).length)).toBeGreaterThan(5);
  await page.keyboard.up("w");
  const beforePause = await page.evaluate(() => window.visualSamples.length);
  await page.locator("#pause").click();
  await expect(page.locator("#pause-dialog")).toBeVisible();
  await expect.poll(() => page.evaluate(count =>
    window.visualSamples.slice(count).some(sample => sample.paused), beforePause)).toBe(true);
  const samples = await page.evaluate(() => window.visualSamples);
  const moving = samples.filter(sample => sample.previous &&
    Math.hypot(sample.current.x - sample.previous.x, sample.current.y - sample.previous.y) > 1e-5);
  expect(moving.length).toBeGreaterThan(5);
  for (const sample of moving) {
    expect(sample.visual.x).toBeCloseTo(sample.previous.x + (sample.current.x - sample.previous.x) * sample.alpha, 8);
    expect(sample.visual.y).toBeCloseTo(sample.previous.y + (sample.current.y - sample.previous.y) * sample.alpha, 8);
    if (mode === "3d") expect(sample.taxi).toEqual(sample.visual);
  }
  const paused = samples.slice(beforePause).filter(sample => sample.paused);
  expect(paused.length).toBeGreaterThan(0);
  for (const sample of paused) expect(sample.visual).toEqual(sample.current);
});
