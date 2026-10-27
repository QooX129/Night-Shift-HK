import { test, expect } from "@playwright/test";

for (const density of [1, 2, 3]) {
  test.describe(`map at ${density}x pixel density`, () => {
    test.use({ deviceScaleFactor: density });

    test("matches native resolution at every zoom and reuses a bounded scrolling cache", async ({ page }, testInfo) => {
      await page.goto("/");
      await expect(page.locator("#start")).toBeEnabled();
      await page.locator("#start").click();
      await expect(page.locator("#welcome")).not.toBeVisible();
      const results = await page.evaluate(async () => {
        const { MapView } = await import("/map.mjs");
        const data = await (await fetch("/api/map")).json();
        const view = new MapView(document.createElement("canvas"), data, []);
        const [left, top, right, bottom] = data.bounds;
        const car = { x: (left + right) / 2, y: (top + bottom) / 2, heading: 0 };
        let builds = 0, image;
        const build = view.buildBackdrop.bind(view);
        view.buildBackdrop = (...args) => { builds++; build(...args); };
        const drawImage = view.ctx.drawImage.bind(view.ctx);
        view.ctx.drawImage = (...args) => { image = args.slice(1); drawImage(...args); };
        const results = [];
        for (const zoom of [0.35, 1.65, 3.5, "overview"]) {
          view.overview = zoom === "overview";
          if (!view.overview) view.zoom = zoom;
          view.camera = { ...car };
          view.render(car, null, "en", null);
          const before = builds;
          view.render(car, null, "en", null);
          results.push({
            zoom, reused: builds === before, scale: view.backdropScale,
            expectedScale: (view.overview
              ? Math.min((view.width - (view.width > 800 ? 370 : 25)) / (right - left),
                (view.height - 180) / (bottom - top))
              : zoom) * devicePixelRatio,
            sourceWidth: image[2], destinationWidth: image[6],
            width: view.backdrop.width, height: view.backdrop.height,
            canvasWidth: view.canvas.width, canvasHeight: view.canvas.height,
            viewportWidth: innerWidth, viewportHeight: innerHeight,
          });
        }
        view.overview = false; view.zoom = 3.5;
        view.render(car, null, "en", null);
        const beforePan = builds;
        car.x += 300 / view.zoom;
        view.camera = { ...car };
        view.render(car, null, "en", null);
        const panRebuilt = builds > beforePan;
        const beforeResize = builds;
        const densityProperty = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
        Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1.5 });
        view.render(car, null, "en", null);
        const changedDensity = {
          ratio: view.ratio, scale: view.backdropScale,
          width: view.canvas.width, rebuilt: builds > beforeResize,
        };
        Object.defineProperty(window, "devicePixelRatio", densityProperty);
        view.render(car, null, "en", null);
        view.canvas.id = "resolution-preview";
        view.canvas.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;z-index:9999";
        document.body.append(view.canvas);
        return { results, panRebuilt, changedDensity };
      });
      for (const result of results.results) {
        expect(result.reused).toBe(true);
        expect(result.scale).toBeCloseTo(result.expectedScale, 8);
        // One cached pixel per output pixel: never enlarge a low-resolution bitmap.
        expect(result.sourceWidth / result.destinationWidth).toBeCloseTo(result.expectedScale, 8);
        expect(result.width).toBeLessThanOrEqual(Math.ceil((result.viewportWidth + 256) * density));
        expect(result.height).toBeLessThanOrEqual(Math.ceil((result.viewportHeight + 256) * density));
        expect(result.canvasWidth).toBe(Math.ceil(result.viewportWidth * density));
        expect(result.canvasHeight).toBe(Math.ceil(result.viewportHeight * density));
      }
      expect(results.panRebuilt).toBe(true);
      expect(results.changedDensity.rebuilt).toBe(true);
      expect(results.changedDensity.ratio).toBe(1.5);
      expect(results.changedDensity.scale).toBe(3.5 * 1.5);
      expect(results.changedDensity.width).toBe(Math.ceil(page.viewportSize().width * 1.5));
      await page.locator("#resolution-preview").screenshot({ path: testInfo.outputPath("sharp-map.png") });
    });
  });
}
