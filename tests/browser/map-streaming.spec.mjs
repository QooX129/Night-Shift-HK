import { test, expect } from "@playwright/test";

test("map bootstrap streams nearby visuals while driving and 3D construction remain live", async ({ page }) => {
  test.setTimeout(90_000);
  const requests = [], errors = [];
  page.on("request", request => { if (request.url().includes("/api/map")) requests.push(request.url()); });
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await expect(page.locator("#map-3d")).toBeVisible();
  await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=streaming-map-1");
    const render = Map3DView.prototype.render;
    await new Promise(resolve => {
      Map3DView.prototype.render = function (...args) {
        Map3DView.prototype.render = render;
        window.streamingView = this;
        resolve();
        return render.apply(this, args);
      };
    });
  });
  await expect.poll(() => page.evaluate(() => window.streamingView.buildingCount)).toBeGreaterThan(10);
  const initial = await page.evaluate(() => {
    const view = window.streamingView;
    return { loaded: view.stream.cache.size, available: view.stream.keys.size,
      nodes: Object.keys(view.data.nodes).length, roads: view.edges.size,
      collisionLines: view.groundMap.collisionLines.all().length };
  });
  expect(initial.loaded).toBeLessThan(initial.available);
  expect(initial.nodes).toBeGreaterThan(1000);
  expect(initial.roads).toBeGreaterThan(1000);
  expect(initial.collisionLines).toBeGreaterThan(100);
  expect(requests.some(url => url.endsWith("/api/map"))).toBe(false);
  expect(requests.some(url => url.includes("/api/map?stream=true"))).toBe(true);
  expect(requests.some(url => url.includes("/api/map/chunks/"))).toBe(true);
  await page.locator("#start").click();
  await expect(page.locator("#welcome")).toBeHidden();
  await page.keyboard.down("w");
  try {
    await expect(page.locator("#speed")).not.toHaveText("0");
  } finally {
    await page.keyboard.up("w");
  }
  await expect.poll(() => page.evaluate(() => Boolean(window.streamingView.scene
    .getObjectByName("level-separated-solid-road-decks")))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.streamingView.roadBuildTask === null),
    { timeout: 60_000 }).toBe(true);
  await page.keyboard.press("m");
  await expect(page.locator("#map-popup")).toBeVisible();
  const farURL = await page.evaluate(async () => {
    const { MapView } = await import("/map.mjs?v=streaming-map-1");
    const view = window.streamingView;
    const key = [...view.stream.keys].sort((a, b) => {
      const distance = key => {
        const [x, y] = key.split(":").map(Number);
        return Math.hypot((x + .5) * 256 - view.camera.x, (y + .5) * 256 - view.camera.y);
      };
      return distance(b) - distance(a);
    })[0];
    const [x, y] = key.split(":").map(Number);
    const render = MapView.prototype.render;
    await new Promise(resolve => {
      MapView.prototype.render = function (...args) {
        if (this.interactive) {
          MapView.prototype.render = render;
          this.camera = { x: (x + .5) * 256, y: (y + .5) * 256 };
          this.zoom = 1;
          resolve();
        }
        return render.apply(this, args);
      };
    });
    return `/api/map/chunks/${view.stream.manifest.version}/${x}/${y}`;
  });
  await expect.poll(() => requests.some(url => url.endsWith(farURL))).toBe(true);
  expect(await page.evaluate(() => window.streamingView.stream.cache.size)).toBeLessThanOrEqual(64);
  await expect(page.locator("#map-stream-error")).toBeHidden();
  expect(errors).toEqual([]);
  await page.evaluate(() => { delete window.streamingView; });
});

test("failed visual downloads alert and recover without stopping driving", async ({ page }) => {
  let failing = true;
  await page.route("**/api/map/chunks/**", route => failing
    ? route.fulfill({ status: 503, json: { detail: "Temporary visual service failure" } })
    : route.continue());
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await expect(page.locator("#map-stream-error")).toContainText("HTTP 503");
  await page.locator("#start").click();
  await expect(page.locator("#welcome")).toBeHidden();
  await page.keyboard.down("w");
  try {
    await expect(page.locator("#speed")).not.toHaveText("0");
  } finally {
    await page.keyboard.up("w");
  }
  await expect(page.locator("#error-dialog")).toBeHidden();
  failing = false;
  await expect(page.locator("#map-stream-error")).toBeHidden();
});

test("raster tiles reuse zoom levels, bound memory, and rasterize only nearby shapes", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("night-shift-hk.settings.v1", JSON.stringify({ defaultView: "2d" })));
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { MapView, MAP_TILE_CACHE_LIMIT } = await import("/map.mjs?v=streaming-map-1");
    const canvas = document.createElement("canvas");
    canvas.style.width = "240px"; canvas.style.height = "168px";
    document.body.append(canvas);
    const data = { nodes: {}, edges: [], bounds: [-100000, -100000, 100000, 100000],
      driving: {}, backdrop: Array.from({ length: 2000 }, (_, i) => ({
        kind: "building", points: [[i * 100, 0], [i * 100 + 20, 0], [i * 100 + 20, 20]],
      })) };
    const view = new MapView(canvas, data, [], { compact: true, interactive: true });
    let builds = 0;
    const build = view.buildBackdrop;
    view.buildBackdrop = function (...args) { builds++; return build.apply(this, args); };
    const car = { x: 0, y: 0, heading: 0 };
    for (let i = 0; i < 15; i++) view.render(car, null, "en");
    const warmed = builds;
    for (let i = 0; i < 15; i++) view.render(car, null, "en");
    const reused = builds === warmed;
    for (let x = 0; x < 100; x++) {
      view.camera.x = x * 500;
      view.render(car, null, "en");
    }
    const size = view.tileCache.size;
    view.spatialIndexes();
    const nearby = view.shapeIndex.query([-50, -50, 250, 50]).length;
    canvas.remove();
    return { reused, size, limit: MAP_TILE_CACHE_LIMIT, nearby };
  });
  expect(result.reused).toBe(true);
  expect(result.size).toBeLessThanOrEqual(result.limit);
  expect(result.nearby).toBeLessThan(10);
});

test("cached raster tile borders have no blank pixel seams", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("night-shift-hk.settings.v1", JSON.stringify({ defaultView: "2d" })));
  await page.goto("/");
  const green = await page.evaluate(async () => {
    const { MapView } = await import("/map.mjs?v=streaming-map-1");
    const canvas = document.createElement("canvas");
    canvas.style.width = "600px"; canvas.style.height = "240px";
    document.body.append(canvas);
    const view = new MapView(canvas, { nodes: {}, edges: [], bounds: [-1000, -1000, 1000, 1000],
      driving: {}, backdrop: [{ kind: "park", points: [[-500, -500], [500, -500], [500, 500], [-500, 500]] }],
    }, [], { compact: true, interactive: true });
    view.zoom = .9;
    for (let i = 0; i < 30; i++) view.render({ x: 900, y: 900, heading: 0 }, null, "en");
    const pixels = view.ctx.getImageData(0, canvas.height / 2, canvas.width, 1).data;
    const values = [];
    for (let i = 0; i < pixels.length; i += 4) values.push(pixels[i + 1]);
    canvas.remove();
    return Math.min(...values);
  });
  expect(green).toBeGreaterThanOrEqual(70);
});
