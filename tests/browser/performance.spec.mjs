import { test, expect } from "@playwright/test";

// Trace capture changes animation timing; measure the game, not the recorder.
test.use({ trace: "off" });

test("sustained 3D driving has no application-wide freezes", async ({ page }, testInfo) => {
  test.setTimeout(60000);
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await page.locator("#start").click();
  await page.locator("#view-mode").click();
  await expect(page.locator("#map-3d")).toBeVisible();
  await page.evaluate(() => {
    window.freezeSamples = { frames: [], tasks: [], requests: [], detail: [] };
    const observer = new PerformanceObserver(list => {
      window.freezeSamples.tasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration })));
    });
    observer.observe({ type: "longtask", buffered: false });
    window.freezeObserver = observer;
    const fetch = window.fetch;
    window.fetch = async (...args) => {
      const start = performance.now();
      const result = await fetch(...args);
      window.freezeSamples.requests.push({ start, duration: performance.now() - start });
      return result;
    };
    let previous;
    function sample(now) {
      if (previous) window.freezeSamples.frames.push({ start: previous, duration: now - previous });
      previous = now;
      window.freezeFrame = requestAnimationFrame(sample);
    }
    window.freezeFrame = requestAnimationFrame(sample);
  });
  await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=pixel-texture-1");
    const refresh = Map3DView.prototype.refreshGroundDetail;
    Map3DView.prototype.refreshGroundDetail = function (...args) {
      const start = performance.now();
      const result = refresh.apply(this, args);
      window.freezeSamples.detail.push({ start, duration: performance.now() - start, x: args[0], y: args[1] });
      return result;
    };
  });
  try {
    const deadline = Date.now() + 20000;
    await page.keyboard.down("w");
    while (Date.now() < deadline) {
      if (await page.locator("#junction").isVisible()) {
        await page.keyboard.up("w");
        const recommended = page.locator("#exits .recommended");
        await (await recommended.count() ? recommended.first() : page.locator("#exits button").first()).click();
        await expect(page.locator("#junction")).not.toBeVisible();
        await page.keyboard.down("w");
      }
      await page.waitForTimeout(100);
    }
  } finally {
    await page.keyboard.up("w");
  }
  const result = await page.evaluate(() => {
    cancelAnimationFrame(window.freezeFrame);
    window.freezeObserver.disconnect();
    return Object.fromEntries(Object.entries(window.freezeSamples).map(([name, values]) =>
      [name, values.sort((a, b) => b.duration - a.duration).slice(0, 10)]));
  });
  console.log(`${testInfo.project.name} longest driving pauses: ${JSON.stringify(result)}`);
  await testInfo.attach("sustained-driving-performance", { body: JSON.stringify(result), contentType: "application/json" });
  await expect(page.locator("#error-dialog")).not.toBeVisible();
  expect(result.detail.length).toBeGreaterThanOrEqual(3);
  expect(result.frames[0].duration).toBeLessThan(250);
});

for (const mode of ["2D", "3D"]) {
  test(`${mode} free-steering animation meets the reference-browser frame budget`, async ({ page }, testInfo) => {
    await page.goto("/");
    await expect(page.locator("#start")).toBeEnabled();
    await page.locator("#start").click();
    await expect(page.locator("#welcome")).not.toBeVisible();
    if (mode === "3D") {
      await page.locator("#view-mode").click();
      await expect(page.locator("#map-3d")).toBeVisible();
      await expect(page.locator("#view-mode")).toHaveText("2D");
      await expect(page.locator("#view-error")).not.toBeVisible();
    }

    await page.keyboard.down("w");
    await page.keyboard.down("a");
    const performance = await page.evaluate(() => new Promise(resolve => {
      const intervals = [];
      let previous;
      function sample(now) {
        if (previous) intervals.push(now - previous);
        previous = now;
        if (intervals.length < 90) requestAnimationFrame(sample);
        else {
          const sorted = [...intervals].sort((a, b) => a - b);
          resolve({
            fps: 1000 / (intervals.reduce((a, b) => a + b, 0) / intervals.length),
            p95: sorted[Math.floor(sorted.length * 0.95)],
            max: Math.max(...intervals),
            samples: intervals.length,
          });
        }
      }
      requestAnimationFrame(sample);
    }));
    await page.keyboard.up("w");
    await page.keyboard.up("a");
    await expect(page.locator("#speed")).not.toHaveText("0");
    await expect(page.locator("#junction")).not.toBeVisible();
    await expect(page.locator("#error-dialog")).not.toBeVisible();
    console.log(`${testInfo.project.name} ${mode}: ${JSON.stringify(performance)}`);
    await testInfo.attach("animation-performance", { body: JSON.stringify(performance), contentType: "application/json" });
    expect(performance.fps).toBeGreaterThanOrEqual(testInfo.project.name === "phone" ? 30 : 55);
    expect(performance.p95).toBeLessThanOrEqual(testInfo.project.name === "phone" ? 50 : 34);
  });
}

for (const offscreen of [true, false]) {
  test(`3D district cache refresh ${offscreen ? "stays off the main-thread drawing path" : "supports browsers without OffscreenCanvas"}`, async ({ page }, testInfo) => {
    const warnings = [];
    page.on("console", message => {
      if (message.type() === "warning") warnings.push(message.text());
    });
    if (!offscreen) {
      await page.route("**/map3d-worker.mjs?*", async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: `self.OffscreenCanvas = undefined;\n${await response.text()}` });
      });
    }
    await page.goto("/");
    const result = await page.evaluate(async () => {
      const { Map3DView } = await import("/map3d.mjs?v=pixel-texture-1");
      const [data, stops] = await Promise.all(["/api/map", "/api/stops"].map(url =>
        fetch(url).then(response => response.json())));
      const canvas = document.createElement("canvas");
      canvas.hidden = true;
      document.body.append(canvas);
      const view = new Map3DView(canvas, data, stops);
      try {
        view.updateGroundDetail({ x: 0, y: 448 });
        let redraws = 0;
        const buildBackdrop = view.detailMap.buildBackdrop;
        view.detailMap.buildBackdrop = function (...args) {
          redraws++;
          return buildBackdrop.apply(this, args);
        };
        const applyMs = [];
        for (const [x, y] of [[64, 512], [128, 576], [-256, 192]]) {
          const ready = new Promise((resolve, reject) => {
            view.detailWorker.addEventListener("message", resolve, { once: true });
            view.detailWorker.addEventListener("error", event => reject(new Error(event.message)), { once: true });
          });
          view.updateGroundDetail({ x, y });
          await ready;
          const start = performance.now();
          view.updateGroundDetail({ x, y });
          applyMs.push(performance.now() - start);
        }
        return { redraws, applyMs, width: view.detailMap.backdrop.width };
      } finally {
        view.dispose();
        view.renderer.forceContextLoss();
        canvas.remove();
      }
    });
    console.log(`${testInfo.project.name} 3D cache refresh: ${JSON.stringify(result)}`);
    expect(result.redraws).toBe(offscreen ? 0 : 3);
    expect(result.width).toBeGreaterThanOrEqual(2048);
    if (offscreen) expect(Math.max(...result.applyMs)).toBeLessThan(1000 / 60);
    else expect(warnings).toContain("OffscreenCanvas 2D unavailable; 3D road textures will refresh on the main thread.");
  });
}
