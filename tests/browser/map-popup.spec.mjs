import { test, expect } from "@playwright/test";
import { toggleDrivingView } from "./driving-view.mjs";

test("taxi markers retain readable map and minimap sizes across zoom levels", async ({ page }) => {
  await page.goto("/");
  const sizes = await page.evaluate(async () => {
    const { MapView, TAXI_ICON_MIN_LENGTH } = await import("/map.mjs?v=streaming-map-1");
    const data = {
      bounds: [-100, -100, 100, 100], nodes: {}, edges: [], backdrop: [],
      driving: { taxi_length: 4.7, taxi_width: 1.7 },
    };
    const sizes = [];
    for (const mode of ["map", "minimap", "2d"]) {
      const canvas = document.createElement("canvas");
      canvas.style.width = "240px"; canvas.style.height = "168px";
      document.body.append(canvas);
      const view = new MapView(canvas, data, [], { compact: mode !== "2d", interactive: mode === "map" });
      const roundRect = view.ctx.roundRect.bind(view.ctx);
      view.ctx.roundRect = (x, y, width, height, radius) => {
        const transform = view.ctx.getTransform();
        sizes.push({ mode, zoom: view.zoom, expected: Math.max(mode === "minimap"
          ? TAXI_ICON_MIN_LENGTH.minimap : TAXI_ICON_MIN_LENGTH.map, 4.7 * 26 / 27 * view.zoom),
        length: width * Math.hypot(transform.a, transform.b) / view.ratio });
        roundRect(x, y, width, height, radius);
      };
      for (const zoom of [.1, .9, 3.5]) {
        view.zoom = zoom;
        view.render({ x: 0, y: 0, heading: .7 }, null, "en");
      }
      canvas.remove();
    }
    return sizes;
  });
  expect(sizes).toHaveLength(9);
  for (const size of sizes) {
    expect(size.length).toBeCloseTo(size.expected, 5);
  }
});

test("map popup keeps 3D driving live and supports keyboard, wheel zoom and dragging", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await expect(page.locator("#map-3d")).toBeVisible();
  await page.keyboard.press("m");
  await expect(page.locator("#map-popup")).toBeHidden();
  await page.locator("#start").click();
  await expect(page.locator("#welcome")).toBeHidden();
  await page.keyboard.press("m");
  await expect(page.locator("#map-popup")).toBeVisible();
  await expect(page.locator("#view-mode")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#map-3d")).toBeVisible();
  const before = await page.evaluate(async () => {
    const { MapView } = await import("/map.mjs?v=streaming-map-1");
    const original = MapView.prototype.render;
    window.mapPopupProbe = { original, frames: 0 };
    MapView.prototype.render = function (car, state, ...args) {
      if (this.interactive) {
        Object.assign(window.mapPopupProbe, {
          zoom: this.zoom, camera: { ...this.camera }, car: { ...car }, elapsed: state.elapsed,
        });
        window.mapPopupProbe.frames++;
      }
      return original.call(this, car, state, ...args);
    };
    return document.querySelector("#clock").textContent;
  });
  try {
    await expect.poll(() => page.evaluate(() => window.mapPopupProbe.frames)).toBeGreaterThan(2);
    const initial = await page.evaluate(() => ({ ...window.mapPopupProbe, original: null }));
    const canvas = page.locator("#popup-map"), box = await canvas.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -180);
    await expect.poll(() => page.evaluate(() => window.mapPopupProbe.zoom)).toBeGreaterThan(initial.zoom);
    const zoomed = await page.evaluate(() => ({ ...window.mapPopupProbe.camera }));
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30);
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => window.mapPopupProbe.camera.x)).toBeLessThan(zoomed.x - 1);
    await page.keyboard.down("w");
    try {
      await expect.poll(() => page.evaluate(start =>
        Math.hypot(window.mapPopupProbe.car.x - start.x, window.mapPopupProbe.car.y - start.y),
      initial.car)).toBeGreaterThan(.2);
    } finally {
      await page.keyboard.up("w");
    }
    await expect.poll(() => page.evaluate(() => window.mapPopupProbe.elapsed)).toBeGreaterThan(initial.elapsed + 1);
    await page.keyboard.press("m");
    await expect(page.locator("#map-popup")).toBeHidden();
    await page.keyboard.press("m");
    await expect(page.locator("#map-popup")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#map-popup")).toBeHidden();
    await expect(page.locator("#pause-dialog")).not.toBeVisible();
    await page.locator("#view-mode").click();
    await expect(page.locator("#map-popup")).toBeVisible();
    await page.locator("#map-close").click();
    await expect(page.locator("#map-popup")).toBeHidden();
    await expect(page.locator("#clock")).not.toHaveText(before);
    await toggleDrivingView(page);
    await expect(page.locator("#map")).toBeVisible();
    await page.keyboard.press("m");
    await expect(page.locator("#map-popup")).toBeVisible();
    await expect(page.locator("#map")).toBeVisible();
    await expect(page.locator("#map-3d")).toBeHidden();
    await page.keyboard.press("m");
    await toggleDrivingView(page);
    await expect(page.locator("#map-3d")).toBeVisible();
  } finally {
    await page.evaluate(async () => {
      const { MapView } = await import("/map.mjs?v=streaming-map-1");
      MapView.prototype.render = window.mapPopupProbe.original;
      delete window.mapPopupProbe;
    });
  }
});
