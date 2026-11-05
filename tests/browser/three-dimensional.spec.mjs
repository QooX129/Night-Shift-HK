import { test, expect } from "@playwright/test";
import { toggleDrivingView, useLegacyInitialView } from "./driving-view.mjs";
test.beforeEach(async ({ page }) => useLegacyInitialView(page));

test.use({ trace: "off" });

test("3D street name is horizontally centered on the screen", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await page.locator("#start").click();
  await toggleDrivingView(page);
  await expect(page.locator(".road-label")).toBeVisible();
  const streetLabel = await page.locator(".road-label").boundingBox();
  expect(Math.abs(streetLabel.x + streetLabel.width / 2 - page.viewportSize().width / 2)).toBeLessThan(1);
});

test("3D minimap follows the taxi, fits around the HUD, and hides in 2D", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await page.evaluate(async () => {
    const { MapView } = await import("/map.mjs?v=streaming-map-1");
    const render = MapView.prototype.render;
    MapView.prototype.render = function (...args) {
      const result = render.apply(this, args);
      if (this.compact) {
        window.minimapSample = {
          car: { ...args[0] }, camera: { ...this.camera }, width: this.width,
          height: this.height, ratio: this.ratio, overview: this.overview, backdropScale: this.backdropScale, zoom: this.zoom,
        };
        window.minimapFrames = (window.minimapFrames || 0) + 1;
      }
      return result;
    };
  });
  await expect(page.locator("#minimap-panel")).toBeHidden();
  await page.locator("#start").click();
  await toggleDrivingView(page);
  await expect(page.locator("#minimap-panel")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.minimapFrames || 0)).toBeGreaterThan(1);
  const checkMap = async () => {
    const result = await page.evaluate(() => {
      const canvas = document.getElementById("minimap");
      const { width, height, ratio, car, camera, overview, backdropScale, zoom } = window.minimapSample;
      const center = canvas.getContext("2d").getImageData(
        Math.floor(width * ratio / 2), Math.floor(height * ratio / 2), 1, 1).data;
      const rect = canvas.getBoundingClientRect();
      const overlaps = selector => {
        const other = document.querySelector(selector);
        if (getComputedStyle(other).display === "none") return false;
        const b = other.getBoundingClientRect();
        return rect.left < b.right && rect.right > b.left && rect.top < b.bottom && rect.bottom > b.top;
      };
      return { width, height, ratio, car, camera, overview, backdropScale, zoom, dpr: devicePixelRatio, center: [...center],
        buffer: [canvas.width, canvas.height], viewport: [innerWidth, innerHeight],
        rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
        overlaps: [".phone-screen", ".dashboard", ".touch-controls"].map(overlaps) };
    });
    expect(result.camera).toEqual({ x: result.car.x, y: result.car.y });
    expect(result.width).toBe((result.viewport[0] > 800 ? 240 : 168) - 4);
    expect(result.height).toBe((result.viewport[0] > 800 ? 168 : 120) - 4);
    expect(result.ratio).toBe(Math.max(2, result.dpr));
    expect(result.backdropScale).toBe(result.zoom * result.ratio);
    expect(result.overview).toBe(false);
    expect(result.buffer).toEqual([Math.ceil(result.width * result.ratio), Math.ceil(result.height * result.ratio)]);
    expect(result.center[0]).toBeGreaterThan(100);
    expect(result.overlaps).toEqual([false, false, false]);
    expect(result.rect.left).toBeGreaterThanOrEqual(0);
    expect(result.rect.bottom).toBeLessThanOrEqual(result.viewport[1]);
    return result;
  };
  const before = await checkMap();
  await page.keyboard.down("w");
  await expect.poll(() => page.evaluate(start => {
    const { car } = window.minimapSample;
    return Math.hypot(car.x - start.x, car.y - start.y);
  }, before.car)).toBeGreaterThan(0.5);
  await page.keyboard.up("w");
  await checkMap();
  await page.locator("#overview").click();
  await checkMap();
  await page.setViewportSize({ width: before.viewport[0] + 20, height: before.viewport[1] + 20 });
  await expect.poll(() => page.evaluate(() => window.minimapFrames)).toBeGreaterThan(3);
  await checkMap();
  await page.screenshot({ path: testInfo.outputPath("3d-minimap.png") });
  await toggleDrivingView(page);
  await expect(page.locator("#minimap-panel")).toBeHidden();
  const frames = await page.evaluate(() => window.minimapFrames);
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => window.minimapFrames)).toBe(frames);
});

test("chase heading eases turns, takes the shortest angle, and resets on activation", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=streaming-map-1");
    const simulate = hz => {
      const view = Object.create(Map3DView.prototype);
      view.updateCameraHeading(0, 0);
      view.cameraReady = true;
      let maxStep = 0;
      for (let i = 0; i < hz * 4; i++) {
        const before = view.cameraHeading;
        view.updateCameraHeading(Math.PI / 2, 1 / hz);
        maxStep = Math.max(maxStep, Math.abs(view.cameraHeading - before));
      }
      return { heading: view.cameraHeading, speed: maxStep * hz };
    };
    const view = Object.create(Map3DView.prototype);
    view.updateCameraHeading(Math.PI - 0.02, 0);
    view.cameraReady = true;
    view.updateCameraHeading(-Math.PI + 0.02, 1 / 60);
    const wrapped = view.cameraHeading;
    view.cameraReady = false;
    view.updateCameraHeading(-1, 1 / 60);
    return { slow: simulate(30), fast: simulate(120), wrapped, reset: view.cameraHeading };
  });
  for (const sample of [result.slow, result.fast]) {
    expect(sample.speed).toBeLessThanOrEqual(0.900001);
    expect(sample.heading).toBeCloseTo(Math.PI / 2, 2);
  }
  expect(result.slow.heading).toBeCloseTo(result.fast.heading, 3);
  expect(result.wrapped).toBeGreaterThan(Math.PI - 0.02);
  expect(result.wrapped).toBeLessThan(Math.PI + 0.02);
  expect(result.reset).toBe(-1);
});

test("GPS route progress reuses traffic geometry and completed route segments", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=streaming-map-1");
    const THREE = await import("/vendor/three/three.module.min.js");
    const view = Object.create(Map3DView.prototype);
    view.nodes = { a: [0, 0], b: [20, 0], c: [40, 0], d: [60, 0] };
    view.data = { nodes: view.nodes };
    view.elevation = { node_heights: { a: 10, b: 12, c: 14, d: 16 } };
    const edges = [
      { id: "one", a: "a", b: "b", way: 1 },
      { id: "two", a: "b", b: "c", way: 2 },
      { id: "three", a: "c", b: "d", way: 3 },
    ];
    view.edges = new Map(edges.map(edge => [edge.id, edge]));
    view.overlays = new THREE.Group();
    const state = { closed: [], traffic: { 1: .5 }, phase: "onboard", route: edges.map(edge => edge.id) };
    let builds = 0;
    const geometry = view.ribbonGeometry;
    view.ribbonGeometry = function (...args) { builds++; return geometry.apply(this, args); };
    view.updateOverlays(state, null, null);
    const initialBuilds = builds;
    const traffic = view.overlays.children.find(mesh => mesh.material.color.getHexString() === "bd955c");
    const route = view.overlays.children.find(mesh => mesh.material.color.getHexString() === "f3c047");
    const count = route.geometry.getAttribute("position").count;
    view.updateOverlays({ ...state, route: ["two", "three"] }, null, null);
    const progressBuilds = builds - initialBuilds;
    const trafficReused = traffic.parent === view.overlays;
    const routeReused = route.parent === view.overlays;
    const range = { ...route.geometry.drawRange };
    view.updateOverlays(state, null, null);
    const restored = route.geometry.drawRange.start === 0;
    view.updateOverlays({ ...state, route: ["three", "two"] }, null, null);
    const rerouteBuilds = builds - initialBuilds - progressBuilds;
    view.updateOverlays({ ...state, route: null }, null, null);
    const cleared = !view.overlays.children.some(mesh => mesh.material.color.getHexString() === "f3c047");
    for (const mesh of view.overlays.children) { mesh.geometry.dispose(); mesh.material.dispose(); }
    return { progressBuilds, rerouteBuilds, trafficReused, routeReused, range, count, cleared, restored };
  });
  expect(result.progressBuilds).toBe(0);
  expect(result.trafficReused && result.routeReused && result.cleared && result.restored).toBe(true);
  expect(result.range.start).toBeGreaterThan(0);
  expect(result.range.start + result.range.count).toBe(result.count);
  expect(result.rerouteBuilds).toBe(1);
});

test("real passenger GPS progress does not rebuild geometry at road transitions", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=streaming-map-1");
    const THREE = await import("/vendor/three/three.module.min.js");
    const data = await (await fetch("/api/map")).json();
    const session = await (await fetch("/api/sessions", { method: "POST" })).json();
    const response = await fetch(`/api/sessions/${session.id}/commands`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seq: 1, command: { action: "accept", order: session.offers[0].id } }),
    });
    if (!response.ok) throw new Error(await response.text());
    const state = await response.json();
    const view = Object.assign(Object.create(Map3DView.prototype), {
      data, nodes: data.nodes, elevation: data.elevation,
      edges: new Map(data.edges.map(edge => [edge.id, edge])), overlays: new THREE.Group(),
    });
    const samples = [];
    let builds = 0;
    const geometry = view.ribbonGeometry;
    view.ribbonGeometry = function (...args) { builds++; return geometry.apply(this, args); };
    const started = performance.now();
    view.updateOverlays({ ...state, phase: "onboard" }, null, null);
    const initialMs = performance.now() - started;
    const initialBuilds = builds;
    let segmentBuilds = 0;
    const round = view.roundLineGeometry;
    view.roundLineGeometry = function (...args) { segmentBuilds++; return round.apply(this, args); };
    for (let i = 1; i < Math.min(20, state.route.length); i++) {
      const start = performance.now();
      view.updateOverlays({ ...state, phase: "onboard", route: state.route.slice(i) }, null, null);
      samples.push(performance.now() - start);
    }
    const progressBuilds = builds - initialBuilds;
    const rerouteSamples = [];
    for (let i = 1; i < Math.min(10, state.route.length); i++) {
      const start = performance.now();
      const route = [...state.route.slice(i), ...state.route.slice(0, i)];
      view.updateOverlays({ ...state, phase: "onboard", route }, null, null);
      rerouteSamples.push(performance.now() - start);
    }
    for (const mesh of view.overlays.children) { mesh.geometry.dispose(); mesh.material.dispose(); }
    return { initialMs, maxProgressMs: Math.max(...samples), transitions: samples.length,
      progressBuilds, segmentBuilds, reroutes: rerouteSamples.length, maxRerouteMs: Math.max(...rerouteSamples) };
  });
  console.log(`Passenger GPS update timing ${JSON.stringify(result)}`);
  expect(result.transitions).toBeGreaterThan(0);
  expect(result.progressBuilds).toBe(0);
  expect(result.maxProgressMs).toBeLessThan(16.7);
  expect(result.reroutes).toBeGreaterThan(0);
  expect(result.segmentBuilds).toBe(0);
  expect(result.maxRerouteMs).toBeLessThan(16.7);
});

test("3D guides retain routes and selected previews without current-road or available-exit ribbons", async ({ page }) => {
  await page.goto("/");
  const results = await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=streaming-map-1");
    const THREE = await import("/vendor/three/three.module.min.js");
    const edge = { id: "in", a: "a", b: "b", way: 1 };
    const exit = { id: "exit", a: "b", b: "c", way: 2 };
    const normal = { id: "normal", a: "b", b: "d", way: 3 };
    const view = Object.create(Map3DView.prototype);
    view.data = { nodes: { a: [0, 0], b: [20, 0], c: [40, 0], d: [20, 20] } };
    view.edges = new Map([edge, exit, normal].map(e => [e.id, e]));
    view.overlays = new THREE.Group();
    const approach = { edges: [edge], incoming: "in",
      exits: [exit, normal].map(e => ({ edge: e, path: { edges: [e] } })) };
    const state = { closed: [], traffic: {}, route: ["in", "exit"], phase: "pickup", selected_exit: null };
    const snapshots = [];
    for (const [phase, selected, preview] of [["pickup", null, null], ["onboard", "exit", null], ["pickup", null, "exit"]]) {
      view.updateOverlays({ ...state, phase, selected_exit: selected }, approach, preview);
      snapshots.push(view.overlays.children.map(mesh => ({
        color: `#${mesh.material.color.getHexString()}`, order: mesh.renderOrder,
        height: mesh.geometry.getAttribute("position").count ? mesh.geometry.getAttribute("position").getY(0) : 0,
        smoothed: Boolean(mesh.geometry.getAttribute("boundaryCoord")),
      })));
    }
    view.updateOverlays({ ...state, route: null, phase: "available" }, approach, null);
    if (view.overlays.children.some(mesh => mesh.geometry.getAttribute("position").count)) {
      throw new Error("Unselected road guides must not be drawn.");
    }
    for (const mesh of view.overlays.children) { mesh.geometry.dispose(); mesh.material.dispose(); }
    return snapshots;
  });
  const order = (snapshot, color) => Math.max(...snapshot.filter(item => item.color === color).map(item => item.order));
  expect(results[0].filter(item => item.height).map(item => item.color)).toEqual(["#24ca72"]);
  expect(order(results[1], "#55e9ff")).toBeGreaterThan(order(results[1], "#f3c047"));
  expect(order(results[2], "#55e9ff")).toBeGreaterThan(order(results[2], "#24ca72"));
  for (const snapshot of results) {
    expect(snapshot.some(item => item.color === "#92d7b6" || item.color === "#f5c65a")).toBe(false);
    for (const item of snapshot.filter(item => item.height)) {
      expect(item.height).toBeCloseTo(item.order / 100);
      expect(item.smoothed).toBe(true);
    }
  }
});

test("legacy flat 3D fallback renders locally and toggles without resetting the shift", async ({ page }, testInfo) => {
  const errors = [], external = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (!request.url().startsWith("http://127.0.0.1:8765")) external.push(request.url());
  });
  await page.route("**/api/map*", async route => {
    const response = await route.fetch(), data = await response.json();
    data.elevation = null;
    await route.fulfill({ response, json: data });
  });
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=streaming-map-1");
    const render = Map3DView.prototype.render;
    Map3DView.prototype.render = function (...args) {
      window.threeView = this;
      window.threeCar = { ...args[0] };
      if (window.threeHeadingOffset) args[0] = { ...args[0], heading: args[0].heading + window.threeHeadingOffset };
      return render.apply(this, args);
    };
  });
  await page.locator("#start").click();
  await expect(page.locator("#welcome")).not.toBeVisible();
  await toggleDrivingView(page);
  await expect(page.locator("#map-3d")).toBeVisible();
  await expect(page.locator("#view-mode")).toHaveText("M");
  await expect(page.locator("#view-mode")).toHaveAttribute("aria-expanded", "false");
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
  const arrows = await page.evaluate(() => {
    const view = window.threeView;
    return { nativePass: view.directionLines.parent === view.boundaryScene,
      smoothed: Boolean(view.directionLines.geometry.getAttribute("boundaryCoord")),
      vertices: view.directionLines.geometry.getAttribute("position").count,
      noForwardRibbon: !view.forwardRibbon };
  });
  expect(arrows.nativePass && arrows.smoothed && arrows.noForwardRibbon).toBe(true);
  expect(arrows.vertices).toBeGreaterThan(0);
  const boundaryAreas = await page.evaluate(async () => {
    const view = window.threeView;
    const results = [];
    try {
      const roads = view.groundMap.collisionLines.roads;
      for (const edge of [...roads.edges.values()].slice(0, 4)) {
        const a = roads.nodes[edge.a], b = roads.nodes[edge.b];
        const car = { edge: edge.id, x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 };
        view.updateBoundaries(car);
        const { COLLISION_LINE_WIDTH } = await import("/collision-lines.mjs?v=streaming-map-1");
        const expected = view.boundaryLines.reduce((sum, { a, b }) =>
          sum + Math.hypot(b[0] - a[0], b[1] - a[1]) * COLLISION_LINE_WIDTH
            + 8 * Math.sin(Math.PI / 8) * (COLLISION_LINE_WIDTH / 2) ** 2, 0);
        const vertices = view.boundaryOutline.geometry.getAttribute("position");
        let actual = 0;
        for (let i = 0; i < vertices.count; i += 3) {
          actual += Math.abs((vertices.getX(i + 1) - vertices.getX(i)) * (vertices.getZ(i + 2) - vertices.getZ(i))
            - (vertices.getZ(i + 1) - vertices.getZ(i)) * (vertices.getX(i + 2) - vertices.getX(i))) / 2;
        }
        const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
        for (let i = 0; i < vertices.count; i++) {
          bounds.minX = Math.min(bounds.minX, vertices.getX(i));
          bounds.maxX = Math.max(bounds.maxX, vertices.getX(i));
          bounds.minY = Math.min(bounds.minY, vertices.getZ(i));
          bounds.maxY = Math.max(bounds.maxY, vertices.getZ(i));
        }
        const [left, top, right, bottom] = view.data.bounds;
        results.push({ expected, actual, contained: bounds.minX >= left - .126
          && bounds.maxX <= right + .126 && bounds.minY >= top - .126 && bounds.maxY <= bottom + .126 });
      }
    } finally {
      view.updateBoundaries(window.threeCar);
    }
    return results;
  });
  for (const { expected, actual, contained } of boundaryAreas) {
    expect(expected).toBeGreaterThan(0);
    expect(Math.abs(actual - expected)).toBeLessThan(expected * 0.0001);
    expect(contained).toBe(true);
  }
  const markerDepth = await page.evaluate(() => {
    const view = window.threeView;
    const visibleMarkers = view.markers.filter(item => item.marker.visible);
    const capture = document.createElement("canvas");
    capture.width = view.canvas.width; capture.height = view.canvas.height;
    const context = capture.getContext("2d");
    const sample = () => {
      view.drawScene();
      context.drawImage(view.canvas, 0, 0);
      return context.getImageData(0, 0, capture.width, capture.height).data;
    };
    const withMarkers = sample();
    visibleMarkers.forEach(item => { item.marker.visible = false; });
    const withoutMarkers = sample();
    visibleMarkers.forEach(item => { item.marker.visible = true; });
    view.drawScene();
    let roofDifferences = 0, markerPixels = 0;
    for (let x = -4; x <= 4; x++) {
      for (let z = -4; z <= 4; z++) {
        const point = view.taxi.position.clone().set(
          x / 4 * view.data.driving.taxi_length * 0.2, 2.07,
          z / 4 * view.data.driving.taxi_width * 0.3);
        view.taxi.localToWorld(point);
        point.project(view.lens);
        const px = Math.floor((point.x + 1) * capture.width / 2);
        const py = Math.floor((1 - point.y) * capture.height / 2);
        const index = (py * capture.width + px) * 4;
        if ([0, 1, 2].some(channel => withMarkers[index + channel] !== withoutMarkers[index + channel])) roofDifferences++;
      }
    }
    for (let i = 0; i < withMarkers.length; i += 4) {
      if (withMarkers[i] !== withoutMarkers[i]) markerPixels++;
    }
    return { roofDifferences, markerPixels, depthTest: view.markers.every(item =>
      item.ring.material.depthTest && item.beacon.material.depthTest) };
  });
  expect(markerDepth.depthTest).toBe(true);
  expect(markerDepth.markerPixels).toBeGreaterThan(0);
  expect(markerDepth.roofDifferences).toBe(0);
  const detail = await page.evaluate(() => ({
    scale: window.threeView.detailMap.backdropScale,
    overviewScale: window.threeView.groundMap.backdropScale,
    visible: window.threeView.groundDetail.visible,
  }));
  expect(detail.scale).toBeGreaterThanOrEqual(5);
  expect(detail.scale / detail.overviewScale).toBeGreaterThan(3);
  expect(detail.visible).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("3d-chase.png") });
  await page.evaluate(() => { window.threeHeadingOffset = 0.4; });
  await expect.poll(() => page.evaluate(() =>
    window.threeView.lens.position.x - window.threeCar.x)).toBeLessThan(-8);
  await page.screenshot({ path: testInfo.outputPath("3d-diagonal-boundaries.png") });
  await page.evaluate(() => { window.threeHeadingOffset = 0; });

  await page.locator("#language").click();
  await expect(page.locator("#view-status")).toContainText("3D 實驗");
  await expect(page.locator("#view-mode")).toHaveAttribute("aria-label", "地區地圖");
  await page.locator("#zoom-in").click();
  await page.locator("#overview").click();
  await expect.poll(() => page.evaluate(() => window.threeView.overview)).toBe(true);
  await expect.poll(() => page.evaluate(() =>
    window.threeView.ground.material.map === window.threeView.overviewTexture)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.threeView.groundDetail.visible)).toBe(false);
  await expect.poll(() => page.evaluate(() => window.threeView.directionLines.visible)).toBe(false);
  await expect.poll(() => page.evaluate(() => window.threeView.lens.position.y)).toBeGreaterThan(500);
  await page.locator("#overview").click();
  await expect.poll(() => page.evaluate(() => window.threeView.ground.material.map === window.threeView.chaseTexture)).toBe(true);
  const originalSize = page.viewportSize();
  await page.setViewportSize({ width: originalSize.width - 30, height: originalSize.height - 30 });
  await expect.poll(() => page.evaluate(() => window.threeView.lens.aspect))
    .toBeCloseTo((originalSize.width - 30) / (originalSize.height - 30), 5);
  await page.setViewportSize(originalSize);
  for (let i = 0; i < 3; i++) {
    await toggleDrivingView(page);
    await expect(page.locator("#map")).toBeVisible();
    await expect(page.locator(".world-label")).not.toBeVisible();
    await toggleDrivingView(page);
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

test("3D boundary detail preserves physical edges and refreshes without accumulating textures", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  const result = await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=streaming-map-1");
    const THREE = await import("/vendor/three/three.module.min.js");
    const data = {
      nodes: { a: [-100, 0], b: [0, 0], c: [100, 0], d: [0, 100] },
      edges: [["a", "b"], ["b", "c"], ["b", "d"]].map(([a, b], i) => ({
        id: `${i}`, a, b, way: i, kind: "residential", length: 100,
        name: "Local road", layer: "0",
      })),
      backdrop: [], bounds: [-500, -500, 500, 500],
      driving: { taxi_radius: 3, taxi_length: 5.4, taxi_width: 2.6, widths: { residential: 10 } },
    };
    const canvas = document.createElement("canvas");
    canvas.hidden = true;
    document.body.append(canvas);
    const view = new Map3DView(canvas, data, []);
    try {
      view.updateGroundDetail({ x: 0, y: 0 });
      view.updateBoundaries({ x: 0, y: 0, edge: "0" });
      view.taxi.visible = false;
      const { backdrop } = view.detailMap;
      const cutOutline = view.lineGeometry([[
        [[-20, -20], [20, -20], [20, 20], [-20, 20], [-20, -20]],
        [[-19, -19], [-19, 19], [19, 19], [19, -19], [-19, -19]],
      ]]);
      const cutPositions = cutOutline.getAttribute("position"), cutCoverage = cutOutline.getAttribute("boundaryCoord");
      let internalFades = 0;
      for (let i = 0; i < cutPositions.count; i += 3) {
        for (let component = 0; component < 3; component++) {
          const a = i + (component + 1) % 3, b = i + (component + 2) % 3;
          if (cutCoverage.array[a * 3 + component] !== 0 || cutCoverage.array[b * 3 + component] !== 0) continue;
          const x = (cutPositions.getX(a) + cutPositions.getX(b)) / 2;
          const y = (cutPositions.getZ(a) + cutPositions.getZ(b)) / 2;
          if (![19, 20].some(edge => Math.abs(Math.abs(x) - edge) < 0.001
              || Math.abs(Math.abs(y) - edge) < 0.001)) internalFades++;
        }
      }
      cutOutline.dispose();
      view.lens.position.set(0, 140, 0);
      view.lens.lookAt(0, 0, 0);
      view.drawScene();
      const capture = document.createElement("canvas");
      capture.width = canvas.width; capture.height = canvas.height;
      const c = capture.getContext("2d");
      c.drawImage(canvas, 0, 0);
      const pixel = (x, y, strongestRed = false) => {
        const point = view.groundDetail.position.clone().set(x, 0.14, y).project(view.lens);
        const px = Math.round((point.x + 1) * capture.width / 2),
          py = Math.round((1 - point.y) * capture.height / 2);
        if (!strongestRed) return [...c.getImageData(px, py, 1, 1).data];
        const samples = c.getImageData(px - 1, py - 1, 3, 3).data;
        const pixels = Array.from({ length: 9 }, (_, i) => [...samples.slice(i * 4, i * 4 + 4)]);
        return pixels.sort((a, b) => (b[0] - b[1]) - (a[0] - a[1]))[0];
      };
      const edges = [pixel(-12, -5, true), pixel(5, 12, true)];
      const openings = [pixel(1, 1), pixel(0, 3), pixel(-12, 0), pixel(-12, -7)];
      view.quality = 0.55;
      view.resize();
      view.lens.position.set(15, 70, 50);
      view.lens.lookAt(0, 0, 0);
      view.drawScene();
      c.drawImage(canvas, 0, 0);
      const continuous = Array.from({ length: 30 }, (_, i) => pixel(-25 + i * 0.5, -5, true));
      const guide = view.ribbon([data.edges[0], data.edges[2]], "#24ca72", 1.4, 0.25);
      view.drawScene();
      c.drawImage(canvas, 0, 0);
      const guidePixels = [
        ...Array.from({ length: 21 }, (_, i) => pixel(-10 + i * 0.5, 0)),
        ...Array.from({ length: 20 }, (_, i) => pixel(0, 0.5 + i * 0.5)),
      ];
      const vertices = guide.geometry.getAttribute("position");
      let joinsMatch = true;
      for (let i = 0; i < vertices.count; i++) {
        const x = vertices.getX(i), z = vertices.getZ(i);
        const distance = Math.min(Math.hypot(x - Math.max(-100, Math.min(0, x)), z),
          Math.hypot(x, z - Math.max(0, Math.min(100, z))));
        if (distance > 0.701) joinsMatch = false;
      }
      const bounds = new THREE.Box3().setFromObject(guide);
      const roundedCaps = bounds.min.x < -100.69 && bounds.max.z > 100.69;
      const guideInNativePass = guide.parent.parent === view.boundaryScene;
      guide.visible = false;
      const nativeResolution = canvas.width > view.sceneTarget.width;
      const blocker = new THREE.Mesh(new THREE.BoxGeometry(6, 8, 6),
        new THREE.MeshBasicMaterial({ color: "#003399" }));
      blocker.position.set(-12, 4, -5);
      view.scene.add(blocker);
      view.drawScene();
      c.drawImage(canvas, 0, 0);
      const occluded = pixel(-12, -5);
      const roadSamples = () => [[-30, 0], [40, 0], [0, 40], [20, 40]].map(([x, y]) => pixel(x, y));
      const beforeRefresh = roadSamples();
      const pixelTexture = view.groundDetail.material.map;
      const canvasTexture = new THREE.CanvasTexture(backdrop);
      canvasTexture.colorSpace = pixelTexture.colorSpace;
      canvasTexture.anisotropy = pixelTexture.anisotropy;
      view.groundDetail.material.map = canvasTexture;
      view.drawScene();
      c.drawImage(canvas, 0, 0);
      const legacyPixels = roadSamples();
      view.groundDetail.material.map = pixelTexture;
      canvasTexture.dispose();
      const textureCount = view.renderer.info.memory.textures;
      const cachedBounds = view.detailMap.backdropBounds;
      const texture = view.groundDetail.material.map, mesh = view.groundDetail;
      const resources = view.resources.length;
      let mainThreadRedraws = 0;
      const buildBackdrop = view.detailMap.buildBackdrop;
      view.detailMap.buildBackdrop = function (...args) {
        mainThreadRedraws++;
        return buildBackdrop.apply(this, args);
      };
      view.updateGroundDetail({ x: 10, y: 10 });
      const cached = view.detailMap.backdropBounds === cachedBounds;
      view.updateGroundDetail({ x: 80, y: 0 });
      const oldDetailVisible = view.groundDetail.position.x === 0 && view.detailPending;
      await new Promise(resolve => view.detailWorker.addEventListener("message", resolve, { once: true }));
      const image = view.readyDetail.image;
      view.updateGroundDetail({ x: 80, y: 0 });
      const transferredPixels = texture.isDataTexture && texture.image === image
        && image.data.byteLength === image.width * image.height * 4;
      view.drawScene();
      c.drawImage(canvas, 0, 0);
      const afterRefresh = roadSamples();
      const textureCountStable = view.renderer.info.memory.textures === textureCount;
      const shifted = view.groundDetail.position.x === 64 && view.detailMap.backdropBounds !== cachedBounds;
      view.overview = true;
      view.updateGroundDetail({ x: 200, y: 0 });
      const hidden = !view.groundDetail.visible;
      view.overview = false;
      view.updateGroundDetail({ x: -80, y: -80 });
      await new Promise(resolve => view.detailWorker.addEventListener("message", resolve, { once: true }));
      view.updateGroundDetail({ x: -80, y: -80 });
      return {
        edges, openings, continuous, guidePixels, joinsMatch, roundedCaps, guideInNativePass, nativeResolution, occluded, cached, shifted, hidden, oldDetailVisible, internalFades, mainThreadRedraws, transferredPixels, beforeRefresh, afterRefresh, legacyPixels, textureCountStable,
        antialias: Boolean(view.boundaryOutline.geometry.getAttribute("boundaryCoord")),
        pixelRatio: view.renderer.getPixelRatio(),
        vectorVertices: view.boundaryOutline.geometry.getAttribute("position").count,
        restored: view.groundDetail.visible && view.groundDetail.position.x === -64,
        reused: view.groundDetail === mesh && view.groundDetail.material.map === texture
          && view.resources.length === resources,
        textureWidth: backdrop.width, limit: view.renderer.capabilities.maxTextureSize,
      };
    } finally {
      view.dispose();
      view.renderer.forceContextLoss();
      canvas.remove();
    }
  });
  for (const point of result.edges) expect(point[0], JSON.stringify(result)).toBeGreaterThan(point[1] + 30);
  for (const point of result.openings) expect(point[0], JSON.stringify(result)).toBeLessThan(point[1]);
  for (const point of result.continuous) expect(point[0], JSON.stringify(result)).toBeGreaterThan(point[1] + 30);
  for (const point of result.guidePixels) expect(point[1]).toBeGreaterThan(point[0] + 30);
  expect(result.joinsMatch && result.guideInNativePass).toBe(true);
  expect(result.roundedCaps).toBe(true);
  expect(result.oldDetailVisible).toBe(true);
  expect(result.mainThreadRedraws).toBe(0);
  expect(result.transferredPixels).toBe(true);
  expect(result.afterRefresh).toEqual(result.beforeRefresh);
  expect(result.beforeRefresh).toEqual(result.legacyPixels);
  expect(result.textureCountStable).toBe(true);
  expect(result.internalFades).toBe(0);
  expect(result.occluded[2]).toBeGreaterThan(result.occluded[0] + 30);
  expect(result.nativeResolution).toBe(true);
  expect(result.antialias).toBe(true);
  expect(result.pixelRatio).toBeGreaterThanOrEqual(1);
  expect(result.vectorVertices).toBeGreaterThan(100);
  expect(result.textureWidth).toBeLessThanOrEqual(result.limit);
  expect(result.cached && result.shifted && result.hidden && result.restored && result.reused).toBe(true);
});

test.describe("3D animation", () => {
  test("chase view stays responsive with the real district geometry", async ({ page }, testInfo) => {
    await page.goto("/");
    await expect(page.locator("#start")).toBeEnabled();
    await page.locator("#start").click();
    await toggleDrivingView(page);
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
  await toggleDrivingView(page);
  await expect(page.locator("#view-error")).toContainText("Could not start 3D");
  await expect(page.locator("#map")).toBeVisible();
  await expect(page.locator("#map-3d")).not.toBeVisible();
  await expect(page.locator("#view-mode")).toBeEnabled();
  await page.keyboard.down("w");
  await expect(page.locator("#speed")).not.toHaveText("0");
  await page.keyboard.up("w");
});
