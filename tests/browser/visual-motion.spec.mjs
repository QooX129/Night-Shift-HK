import { test, expect } from "@playwright/test";

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
