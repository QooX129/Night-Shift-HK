import { test, expect } from "@playwright/test";

test.use({ trace: "off" });
test("elevation preview retains the same-machine legacy renderer frame budget", async ({ page }) => {
  const rates = {};
  for (const mode of ["legacy", "elevation"]) {
    await page.route("**/api/map", async route => {
      const response = await route.fetch(), data = await response.json();
      if (mode === "legacy") data.elevation = null;
      await route.fulfill({ response, json: data });
    });
    await page.goto("/");
    await expect(page.locator("#start")).toBeEnabled();
    await page.locator("#start").click();
    await page.locator("#view-mode").click();
    await expect(page.locator("#map-3d")).toBeVisible();
    await page.keyboard.down("w");
    rates[mode] = await page.evaluate(() => new Promise(resolve => {
      const durations = [];
      let previous;
      function frame(now) {
        if (previous) durations.push(now - previous);
        previous = now;
        if (durations.length < 45) requestAnimationFrame(frame);
        else resolve(1000 / (durations.reduce((a, b) => a + b, 0) / durations.length));
      }
      requestAnimationFrame(frame);
    }));
    await page.keyboard.up("w");
    await page.unroute("**/api/map");
  }
  console.log(`Same-machine renderer FPS ${JSON.stringify(rates)}`);
  expect(rates.elevation / rates.legacy).toBeGreaterThanOrEqual(.7);
});

test("elevated driving keeps bounded geometry work while preserving the shift", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=guide-left-exit-1");
    const { RoadNetwork } = await import("/physics.mjs?v=guide-left-exit-1");
    window.elevationTiming = {};
    for (const [prototype, name] of [[Map3DView.prototype, "render"], [Map3DView.prototype, "ribbonGeometry"],
      [RoadNetwork.prototype, "constrain"], [RoadNetwork.prototype, "bodyFits"]]) {
      const original = prototype[name];
      prototype[name] = function (...args) {
        const started = performance.now();
        const result = original.apply(this, args);
        const entry = window.elevationTiming[name] ??= { calls: 0, total: 0, max: 0 };
        const duration = performance.now() - started;
        entry.calls++; entry.total += duration; entry.max = Math.max(entry.max, duration);
        return result;
      };
    }
  });
  await page.locator("#start").click();
  await page.locator("#view-mode").click();
  await expect(page.locator("#map-3d")).toBeVisible();
  await page.keyboard.down("w");
  await page.waitForTimeout(2000);
  await page.keyboard.up("w");
  console.log(`Elevated driving timing ${JSON.stringify(await page.evaluate(() => window.elevationTiming))}`);
  await expect(page.locator("#error-dialog")).not.toBeVisible();
  await page.locator("#view-mode").click();
  await expect(page.locator("#map")).toBeVisible();
});

test("offline terrain, source bridge, taxi poses and road-surface guides remain readable", async ({ page }) => {
  const errors = [], external = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (!new URL(request.url()).hostname.match(/^(127\.0\.0\.1|localhost)$/)) external.push(request.url());
  });
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  const result = await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=guide-left-exit-1");
    const { surfacePose } = await import("/elevation.mjs?v=guide-left-exit-1");
    const data = await (await fetch("/api/map")).json();
    const stops = await (await fetch("/api/stops")).json();
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const view = new Map3DView(canvas, data, stops);
    view.renderer.info.autoReset = false;
    const pilot = data.elevation.pilot;
    const car = edge => {
      const a = data.nodes[edge.a], b = data.nodes[edge.b];
      return { x: pilot.point[0], y: pilot.point[1], heading: Math.atan2(b[1] - a[1], b[0] - a[0]),
        edge: edge.id, speed: 0 };
    };
    const upper = car(view.edges.get(pilot.bridge)), lower = car(view.edges.get(pilot.ground));
    view.render(upper, null, "en", null);
    const bridgeHeight = view.taxi.position.y;
    const pitch = view.taxi.rotation.z;
    const boundaryPositions = view.boundaryOutline.geometry.getAttribute("position");
    let boundaryError = 0;
    for (const [index, { edge }] of view.boundaryLines.entries()) {
      for (let i = index * 54; i < index * 54 + 54; i++) {
        const expected = surfacePose(view, edge,
          { x: boundaryPositions.getX(i), y: boundaryPositions.getZ(i) }, 0).height + .14;
        boundaryError = Math.max(boundaryError, Math.abs(boundaryPositions.getY(i) - expected));
      }
    }
    const boundariesVisible = view.boundaryOutline.visible;
    const boundaryTiles = view.boundaryOutline.children;
    view.renderer.info.reset();
    view.renderer.render(view.boundaryScene, view.lens);
    const visibleBoundaryTriangles = view.renderer.info.render.triangles;
    const staticBoundaryTriangles = boundaryPositions.count / 3;
    const upperLines = view.boundaryLines;
    const geometry = view.ribbonGeometry([view.edges.get(pilot.bridge)], 1, .3);
    const positions = geometry.getAttribute("position");
    let guideError = 0;
    for (let i = 0; i < positions.count; i++) {
      const expected = surfacePose(view, view.edges.get(pilot.bridge),
        { x: positions.getX(i), y: positions.getZ(i) }, 0).height + .38;
      guideError = Math.max(guideError, Math.abs(positions.getY(i) - expected));
    }
    geometry.dispose();
    view.cameraReady = false;
    view.render(lower, null, "en", null);
    const groundHeight = view.taxi.position.y;
    const boundaryGeometry = view.boundaryOutline.geometry;
    const boundaryLines = view.boundaryLines;
    const sourceModel = view.scene.getObjectByName("official-LandsD-pilot-bridge-estimated-datum-alignment");
    const started = performance.now(), frames = [];
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const before = performance.now();
      view.renderer.info.reset();
      view.render(lower, null, "en", null);
      frames.push(performance.now() - before);
    }
    const sample = { bridgeHeight, groundHeight, pitch, guideError, boundaryError, boundariesVisible,
      visibleBoundaryTriangles, staticBoundaryTriangles,
      boundaryTileCount: boundaryTiles.length,
      boundaryVertices: boundaryPositions.count,
      allLevelsStatic: upperLines === view.boundaryLines
        && view.boundaryLines.some(line => line.edge.way === view.edges.get(pilot.ground).way)
        && view.boundaryLines.some(line => line.edge.way === view.edges.get(pilot.bridge).way),
      boundaryCacheStable: view.boundaryOutline.geometry === boundaryGeometry
        && view.boundaryLines === boundaryLines,
      groundVertices: view.ground.geometry.getAttribute("position").count,
      sourceModelVertices: sourceModel.geometry.getAttribute("position").count,
      buildings: view.buildingCount, drawCalls: view.renderer.info.render.calls,
      maxRenderMs: Math.max(...frames), elapsedMs: performance.now() - started };
    view.dispose(); canvas.remove();
    return sample;
  });
  expect(result.bridgeHeight - result.groundHeight).toBeGreaterThan(4);
  expect(Math.abs(result.pitch)).toBeGreaterThan(0);
  expect(result.guideError).toBeLessThan(.001);
  expect(result.boundaryError).toBeLessThan(.001);
  expect(result.boundaryVertices).toBeGreaterThan(0);
  expect(result.boundariesVisible).toBe(true);
  expect(result.boundaryTileCount).toBeGreaterThan(10);
  expect(result.visibleBoundaryTriangles).toBeGreaterThan(0);
  expect(result.visibleBoundaryTriangles).toBeLessThan(result.staticBoundaryTriangles * .25);
  expect(result.allLevelsStatic).toBe(true);
  expect(result.boundaryCacheStable).toBe(true);
  expect(result.groundVertices).toBeGreaterThan(30000);
  expect(result.sourceModelVertices).toBeGreaterThan(300);
  expect(result.buildings).toBeGreaterThan(3000);
  expect(result.drawCalls).toBeGreaterThan(0);
  expect(result.drawCalls).toBeLessThan(1200);
  expect(result.maxRenderMs).toBeLessThan(250);
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
  console.log(JSON.stringify(result));
});
