import { test, expect } from "@playwright/test";

test.use({ trace: "off" });

test("3D road guides have camera-independent selected, pickup, yellow, normal priority", async ({ page }) => {
  await page.goto("/");
  const results = await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=async-detail-1");
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
    for (const mesh of view.overlays.children) { mesh.geometry.dispose(); mesh.material.dispose(); }
    return snapshots;
  });
  const order = (snapshot, color) => Math.max(...snapshot.filter(item => item.color === color).map(item => item.order));
  expect(order(results[0], "#24ca72")).toBeGreaterThan(order(results[0], "#f5c65a"));
  expect(order(results[0], "#f5c65a")).toBeGreaterThan(order(results[0], "#92d7b6"));
  expect(order(results[1], "#55e9ff")).toBeGreaterThan(order(results[1], "#f3c047"));
  expect(order(results[2], "#55e9ff")).toBeGreaterThan(order(results[2], "#24ca72"));
  for (const snapshot of results) {
    for (const item of snapshot.filter(item => item.height)) {
      expect(item.height).toBeCloseTo(item.order / 100);
      expect(item.smoothed).toBe(true);
    }
  }
});

test("3D district renders locally and toggles without resetting the shift or changing physics", async ({ page }, testInfo) => {
  const errors = [], external = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (!request.url().startsWith("http://127.0.0.1:8765")) external.push(request.url());
  });
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=async-detail-1");
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
  const arrows = await page.evaluate(() => {
    const view = window.threeView;
    return { nativePass: view.directionLines.parent === view.boundaryScene,
      smoothed: Boolean(view.directionLines.geometry.getAttribute("boundaryCoord")),
      vertices: view.directionLines.geometry.getAttribute("position").count,
      priority: view.directionLines.renderOrder < view.forwardRibbon.renderOrder };
  });
  expect(arrows.nativePass && arrows.smoothed && arrows.priority).toBe(true);
  expect(arrows.vertices).toBeGreaterThan(0);
  const boundaryAreas = await page.evaluate(async () => {
    const clipping = (await import("/vendor/polygon-clipping/polygon-clipping.mjs")).default;
    const view = window.threeView, difference = clipping.difference;
    let outlines;
    clipping.difference = (...args) => { outlines = difference(...args); return outlines; };
    const results = [];
    try {
      for (const [x, y] of [[64, 512], [0, 448], [128, 576]]) {
        view.updateBoundaries(x, y);
        const ringArea = ring => Math.abs(ring.slice(1).reduce((sum, point, i) =>
          sum + ring[i][0] * point[1] - point[0] * ring[i][1], 0) / 2);
        const expected = outlines.reduce((sum, [outer, ...holes]) =>
          sum + ringArea(outer) - holes.reduce((total, hole) => total + ringArea(hole), 0), 0);
        const vertices = view.boundaryOutline.geometry.getAttribute("position");
        let actual = 0;
        for (let i = 0; i < vertices.count; i += 3) {
          actual += Math.abs((vertices.getX(i + 1) - vertices.getX(i)) * (vertices.getZ(i + 2) - vertices.getZ(i))
            - (vertices.getZ(i + 1) - vertices.getZ(i)) * (vertices.getX(i + 2) - vertices.getX(i))) / 2;
        }
        results.push({ expected, actual });
      }
    } finally {
      clipping.difference = difference;
      view.updateBoundaries(view.groundDetail.position.x, view.groundDetail.position.z);
    }
    return results;
  });
  for (const { expected, actual } of boundaryAreas) {
    expect(expected).toBeGreaterThan(0);
    expect(Math.abs(actual - expected)).toBeLessThan(expected * 0.0001);
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
  await expect(page.locator("#view-status")).toContainText("3D 預覽");
  await expect(page.locator("#view-mode")).toHaveAttribute("aria-label", "切換至 2D 地圖");
  await page.locator("#zoom-in").click();
  await page.locator("#overview").click();
  await expect.poll(() => page.evaluate(() => window.threeView.overview)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.threeView.groundDetail.visible)).toBe(false);
  await expect.poll(() => page.evaluate(() => window.threeView.directionLines.visible)).toBe(false);
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

test("3D boundary detail preserves physical edges and refreshes without accumulating textures", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  const result = await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=async-detail-1");
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
      view.taxi.visible = false;
      const { backdrop } = view.detailMap;
      view.lens.position.set(0, 140, 0);
      view.lens.lookAt(0, 0, 0);
      view.drawScene();
      const capture = document.createElement("canvas");
      capture.width = canvas.width; capture.height = canvas.height;
      const c = capture.getContext("2d");
      c.drawImage(canvas, 0, 0);
      const pixel = (x, y) => {
        const point = view.groundDetail.position.clone().set(x, 0.04, y).project(view.lens);
        return [...c.getImageData(Math.round((point.x + 1) * capture.width / 2),
          Math.round((1 - point.y) * capture.height / 2), 1, 1).data];
      };
      const edges = [pixel(-12, -5), pixel(5, 12)];
      const openings = [pixel(1, 1), pixel(0, 3), pixel(-12, 0), pixel(-12, -7)];
      view.quality = 0.55;
      view.resize();
      view.lens.position.set(15, 70, 50);
      view.lens.lookAt(0, 0, 0);
      view.drawScene();
      c.drawImage(canvas, 0, 0);
      const continuous = Array.from({ length: 30 }, (_, i) => pixel(-25 + i * 0.5, -5));
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
      const cachedBounds = view.detailMap.backdropBounds;
      const texture = view.groundDetail.material.map, mesh = view.groundDetail;
      const resources = view.resources.length;
      view.updateGroundDetail({ x: 10, y: 10 });
      const cached = view.detailMap.backdropBounds === cachedBounds;
      view.updateGroundDetail({ x: 80, y: 0 });
      const oldDetailVisible = view.groundDetail.position.x === 0 && view.detailPending;
      await new Promise(resolve => view.detailWorker.addEventListener("message", resolve, { once: true }));
      view.updateGroundDetail({ x: 80, y: 0 });
      const shifted = view.groundDetail.position.x === 64 && view.detailMap.backdropBounds !== cachedBounds;
      view.overview = true;
      view.updateGroundDetail({ x: 200, y: 0 });
      const hidden = !view.groundDetail.visible;
      view.overview = false;
      view.updateGroundDetail({ x: -80, y: -80 });
      await new Promise(resolve => view.detailWorker.addEventListener("message", resolve, { once: true }));
      view.updateGroundDetail({ x: -80, y: -80 });
      return {
        edges, openings, continuous, guidePixels, joinsMatch, roundedCaps, guideInNativePass, nativeResolution, occluded, cached, shifted, hidden, oldDetailVisible,
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
