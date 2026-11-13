import { test, expect } from "@playwright/test";
import { toggleDrivingView, useLegacyInitialView } from "./driving-view.mjs";
test.beforeEach(async ({ page }) => useLegacyInitialView(page));

test.use({ trace: "off" });
test("layer-only OSM roads build an elevated deck instead of a ground road", async ({ page }) => {
  await page.goto("/");
  const tile = await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=tunnel-clearance-1");
    const edge = { id: "layer-one", a: "a", b: "b", way: 1, kind: "primary", width: 10,
      layer: "1", bridge: "no", tunnel: "no", oneway: true };
    const tiles = [];
    const view = Object.assign(Object.create(Map3DView.prototype), {
      nodes: { a: [0, 0], b: [100, 0] },
      data: { driving: { widths: { primary: 16 } } },
      elevation: { node_heights: { a: 6, b: 6 }, road_profiles: {}, road_junctions: {},
        pilot: { triangles: [] } },
      groundMap: { unique: [edge] }, camera: { x: 0, y: 0 }, stream: null, resources: [], structures: [],
      addRoadTile(road) { tiles.push(road); }, scene: { add() {} },
    });
    const task = view.roadSurfaceGeometry();
    while (!task.next().done) {}
    return { deck: tiles[0].deck.length, elevatedDeck: tiles[0].elevatedDeck.length };
  });
  expect(tile.deck).toBe(0);
  expect(tile.elevatedDeck).toBeGreaterThan(0);
});

test("Nathan Road stays drivable beneath the Gascoigne flyover", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const data = await (await fetch("/api/map")).json();
    const { RoadNetwork } = await import("/physics.mjs?v=tunnel-clearance-1");
    const { surfacePose } = await import("/elevation.mjs?v=tunnel-clearance-1");
    const { Map3DView } = await import("/map3d.mjs?v=tunnel-clearance-1");
    const roads = new RoadNetwork(data);
    const previous = roads.edges.get("436371172:1:9891388476");
    const following = roads.edges.get("987256904:0:5057028185");
    const stopped = { x: 193.14069793709123, y: 478.4369422355976 };
    const fits = roads.bodyFits(stopped, 1.0668896195141204, previous);
    const a = roads.nodes[following.a], b = roads.nodes[following.b];
    let current = previous, matched = true;
    for (const distance of [.2, .5, 1, 2, 4]) {
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const point = { x: a[0] + (b[0] - a[0]) * distance / length,
        y: a[1] + (b[1] - a[1]) * distance / length };
      const match = roads.match(point, roads.angle(following), current);
      if (!match) { matched = false; break; }
      current = match.edge;
    }
    const upper = roads.edges.get("452590572:1:1172166368");
    const lower = roads.edges.get("102506132:4:4353485231");
    const crossing = { x: 174.75, y: 539.13 };
    const side = roads.edges.get("485635353:3:9803283485");
    const owner = roads.edges.get("1079255096:0:9803283485");
    const junction = { x: -164.1981486034351, y: 438.7093830072998 };
    const tiles = [];
    const view = Object.assign(Object.create(Map3DView.prototype), {
      nodes: roads.nodes, data, elevation: data.elevation,
      groundMap: { unique: [upper, lower] }, camera: { x: 0, y: 0 }, stream: null,
      resources: [], structures: [], addRoadTile(tile) { tiles.push(tile); }, scene: { add() {} },
    });
    const task = view.roadSurfaceGeometry();
    while (!task.next().done) {}
    return { fits, matched, final: current.id,
      clearance: surfacePose(roads, upper, crossing, 0).height - surfacePose(roads, lower, crossing, 0).height,
      separated: !roads.candidates(crossing, lower).some(edge => edge.id === upper.id),
      junctionDifference: Math.abs(surfacePose(roads, side, junction, 0).height
        - surfacePose(roads, owner, junction, 0).height),
      upperDeck: tiles.reduce((sum, tile) => sum + tile.elevatedDeck.length, 0),
      lowerDeck: tiles.reduce((sum, tile) => sum + tile.deck.length, 0) };
  });
  expect(result.fits).toBe(true);
  expect(result.matched).toBe(true);
  expect(result.final).toBe("987256904:0:5057028185");
  expect(result.clearance).toBeGreaterThan(5.65);
  expect(result.separated).toBe(true);
  expect(result.junctionDifference).toBeLessThan(.005);
  expect(result.upperDeck).toBeGreaterThan(0);
  expect(result.lowerDeck).toBeGreaterThan(0);
});

test("Central Kowloon Bypass roof remains below the overlapping ground road", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const data = await (await fetch("/api/map")).json();
    const { RoadNetwork, project } = await import("/physics.mjs?v=tunnel-clearance-1");
    const { surfacePose } = await import("/elevation.mjs?v=tunnel-clearance-1");
    const { Map3DView } = await import("/map3d.mjs?v=tunnel-clearance-1");
    const roads = new RoadNetwork(data);
    const tunnel = roads.edges.get("504423499:2:13108582004");
    const ground = roads.edges.get("1389172580:0:12859244962");
    const tiles = [];
    const view = Object.assign(Object.create(Map3DView.prototype), {
      nodes: roads.nodes, data, elevation: data.elevation,
      groundMap: { unique: [tunnel] }, camera: { x: 0, y: 0 }, stream: null,
      resources: [], structures: [], addRoadTile(tile) { tiles.push(tile); }, scene: { add() {} },
    });
    const task = view.roadSurfaceGeometry();
    while (!task.next().done) {}
    let minCover = Infinity, count = 0;
    const a = roads.nodes[tunnel.a], b = roads.nodes[tunnel.b];
    const poses = [.1, .4, .7, .875, .95].map(t => surfacePose(roads, tunnel,
      { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t }, 0));
    for (const tile of tiles) for (let i = 0; i < tile.shell.length; i += 3) {
      const x = tile.shell[i], height = tile.shell[i + 1], y = tile.shell[i + 2];
      const point = { x, y };
      if (project(point, roads.nodes[ground.a], roads.nodes[ground.b]).distance > roads.radius(ground)) continue;
      if (Math.abs(height - surfacePose(roads, tunnel, point, 0).height - 5.08) > 1e-6) continue;
      minCover = Math.min(minCover, surfacePose(roads, ground, point, 0).height + .08 - height);
      count++;
    }
    return { minCover, count, poses };
  });
  expect(result.count).toBeGreaterThan(0);
  expect(result.minCover).toBeGreaterThanOrEqual(1);
  const serverPoses = [
    [7.145850506647573, .014875738329752624],
    [11.04483790248613, .013752217819753951],
    [12.426778154142125, -.003978422500163229],
    [12.197212, 0],
    [13.949974521326423, .10386694043327568],
  ];
  result.poses.forEach((pose, i) => {
    expect(pose.height).toBeCloseTo(serverPoses[i][0], 8);
    expect(pose.grade).toBeCloseTo(serverPoses[i][1], 8);
  });
});

test("elevation preview retains the same-machine legacy renderer frame budget", async ({ page }) => {
  const rates = {};
  for (const mode of ["legacy", "elevation"]) {
    if (mode === "elevation") await page.evaluate(() => localStorage.removeItem("night-shift-hk.settings.v1"));
    await page.route("**/api/map*", async route => {
      const response = await route.fetch(), data = await response.json();
      if (mode === "legacy") data.elevation = null;
      await route.fulfill({ response, json: data });
    });
    await page.goto("/");
    await expect(page.locator("#start")).toBeEnabled();
    await page.locator("#start").click();
    await toggleDrivingView(page);
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
    await page.unroute("**/api/map*");
  }
  console.log(`Same-machine renderer FPS ${JSON.stringify(rates)}`);
  expect(rates.elevation / rates.legacy).toBeGreaterThanOrEqual(.7);
});

test("elevated driving keeps bounded geometry work while preserving the shift", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=route-guide-1");
    const { RoadNetwork } = await import("/physics.mjs?v=tunnel-clearance-1");
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
  await toggleDrivingView(page);
  await expect(page.locator("#map-3d")).toBeVisible();
  await page.keyboard.down("w");
  await page.waitForTimeout(2000);
  await page.keyboard.up("w");
  console.log(`Elevated driving timing ${JSON.stringify(await page.evaluate(() => window.elevationTiming))}`);
  await expect(page.locator("#error-dialog")).not.toBeVisible();
  await toggleDrivingView(page);
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
    const { Map3DView } = await import("/map3d.mjs?v=tunnel-clearance-1");
    const { surfacePose } = await import("/elevation.mjs?v=tunnel-clearance-1");
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
