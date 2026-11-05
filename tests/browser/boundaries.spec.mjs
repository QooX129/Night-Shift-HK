import { test, expect } from "@playwright/test";

test("Waterloo main-road driving and outlines stay clear across a segmented slip-road opening", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  const result = await page.evaluate(async () => {
    const [{ RoadNetwork, project, stepCar }, { CollisionLines }, data] = await Promise.all([
      import("/physics.mjs?v=streaming-map-1"),
      import("/collision-lines.mjs?v=streaming-map-1"),
      fetch("/api/map").then(response => response.json()),
    ]);
    const roads = new RoadNetwork(data), outlines = new CollisionLines(data);
    const main = roads.edges.get("1212555896:1:6357916726");
    const car = { x: 449.6212089666092, y: -272.51195831972956,
      edge: "102640421:1:6357916725", heading: roads.angle(main), speed: 0 };
    const start = { ...car };
    const innerWall = outlines.all().some(line =>
      project({ x: 449.931558, y: -273.567937 }, line.a, line.b).distance < .2);
    let blocked = 0;
    const before = performance.now();
    for (let frame = 0; frame < 120; frame++) {
      if (stepCar(car, { gas: true }, 1 / 60, { roads }).blocked) blocked++;
    }
    return { innerWall, blocked, distance: Math.hypot(car.x - start.x, car.y - start.y),
      way: roads.edges.get(car.edge).way, millisecondsPerStep: (performance.now() - before) / 120 };
  });
  expect(result.innerWall).toBe(false);
  expect(result.blocked).toBe(0);
  expect(result.distance).toBeGreaterThan(13);
  expect(result.way).toBe(1212555896);
  expect(result.millisecondsPerStep).toBeLessThan(5);
});

test("only collider outlines are light red at 80% opacity without tinting the road interior", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  const result = await page.evaluate(async () => {
    const { MapView } = await import("/map.mjs");
    const draw = MapView.prototype.drawCollisionLines;
    const canvas = document.createElement("canvas");
    const edge = { id: "road", a: "a", b: "b", way: 1, kind: "residential", length: 100,
      name: "Local road", zh: "", layer: "0" };
    const data = { nodes: { a: [0, 0], b: [100, 0] }, edges: [edge], backdrop: [],
      bounds: [-20, -20, 120, 20], driving: { taxi_radius: 3, taxi_length: 5.4, taxi_width: 2.6,
        widths: { residential: 10 } } };
    const alpha = [];
    MapView.prototype.drawCollisionLines = function (context, car) {
      const stroke = context.stroke;
      context.stroke = function (...args) {
        alpha.push(this.globalAlpha);
        return stroke.apply(this, args);
      };
      draw.call(this, context, car);
      context.stroke = stroke;
    };
    const outlined = new MapView(canvas, data, []);
    outlined.buildBackdrop(data.bounds, 4);
    MapView.prototype.drawCollisionLines = () => {};
    const baseline = new MapView(document.createElement("canvas"), data, []);
    baseline.buildBackdrop(data.bounds, 4);
    MapView.prototype.drawCollisionLines = draw;
    const points = [];
    const context = { beginPath() {}, moveTo: (...point) => points.push(point),
      lineTo: (...point) => points.push(point), stroke() {} };
    outlined.highlightExit(context, edge, "#92d7b6", 1, {
      start: { x: 40, y: 0 }, edges: [edge, { b: "a" }],
    });
    const pixel = (view, y) => [...view.backdrop.getContext("2d").getImageData(240, Math.round((y + 20) * 4), 1, 1).data];
    const result = { alpha, points, centre: pixel(outlined, 0), oldCentre: pixel(baseline, 0),
      collider: pixel(outlined, 5), oldCollider: pixel(baseline, 5),
      edge: pixel(outlined, 7.5), oldEdge: pixel(baseline, 7.5),
      outerEdge: pixel(outlined, 7.7), oldOuterEdge: pixel(baseline, 7.7),
      outside: pixel(outlined, 10), oldOutside: pixel(baseline, 10) };
    document.body.replaceChildren(outlined.backdrop);
    return result;
  });
  expect(result.alpha).toEqual([0.8]);
  expect(result.points).toEqual([[40, 0], [100, 0], [0, 0]]);
  expect(result.centre).toEqual(result.oldCentre);
  expect(result.outside).toEqual(result.oldOutside);
  expect(result.collider[0]).toBeGreaterThan(result.oldCollider[0] + 20);
  expect(result.collider[0]).toBeGreaterThan(result.collider[1]);
  expect(result.edge).toEqual(result.oldEdge);
  expect(result.outerEdge).toEqual(result.oldOuterEdge);
  await page.screenshot({ path: testInfo.outputPath("road-boundaries.png") });
});

test("narrow-road outlines mark physical boundaries independently of the old circular taxi radius", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  const results = await page.evaluate(async () => {
    const { MapView } = await import("/map.mjs?v=streaming-map-1");
    const { RoadNetwork } = await import("/physics.mjs");
    const results = [];
    for (const width of [8, 10, 16]) {
      for (const taxiRadius of [3, 4]) {
        const edge = { id: "road", a: "a", b: "b", way: 1, kind: "service", length: 100,
          name: "Local road", zh: "", layer: "0" };
        const data = { nodes: { a: [0, 0], b: [100, 0] }, edges: [edge], backdrop: [],
          bounds: [-20, -20, 120, 20], driving: { taxi_radius: taxiRadius, taxi_length: 5.4, taxi_width: 2.6,
            widths: { service: width } } };
        const roads = new RoadNetwork(data);
        const view = new MapView(document.createElement("canvas"), data, []);
        view.buildBackdrop(data.bounds, 4);
        const c = view.backdrop.getContext("2d");
        const pixel = y => [...c.getImageData(240, Math.round((20 + y) * 4), 1, 1).data];
        const radius = roads.radius(edge);
        results.push({
          width, taxiRadius, radius,
          left: pixel(-radius), right: pixel(radius),
          outer: pixel(width * 0.75),
          centre: pixel(0),
        });
      }
    }
    return results;
  });
  for (const result of results) {
    for (const point of [result.left, result.right]) {
      expect(point[0], JSON.stringify(result)).toBeGreaterThan(point[1] + 30);
    }
    expect(result.outer[0]).toBeLessThan(result.outer[1]);
    if (result.radius > 0.5) expect(result.centre[0]).toBeLessThan(result.centre[1]);
  }
});

test("collider outline follows the joined junction perimeter without blocking its interior", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  const pixels = await page.evaluate(async () => {
    const { MapView } = await import("/map.mjs?v=streaming-map-1");
    const data = {
      nodes: { a: [-20, 0], b: [0, 0], c: [20, 0], d: [0, 20] },
      edges: [["a", "b"], ["b", "c"], ["b", "d"]].map(([a, b], i) => ({
        id: `${i}`, a, b, way: i, kind: "residential", length: 20,
        name: "Local road", layer: "0",
      })),
      backdrop: [], bounds: [-30, -30, 30, 30],
      driving: { taxi_radius: 3, taxi_length: 5.4, taxi_width: 2.6, widths: { residential: 10 } },
    };
    const view = new MapView(document.createElement("canvas"), data, []);
    view.buildBackdrop(data.bounds, 4);
    const c = view.backdrop.getContext("2d");
    const pixel = (x, y) => [...c.getImageData((x + 30) * 4, (y + 30) * 4, 1, 1).data];
    return { centre: pixel(0, 0), opening: pixel(0, 5),
      horizontal: pixel(-7, -5), vertical: pixel(5, 7) };
  });
  for (const point of [pixels.centre, pixels.opening]) expect(point[0]).toBeLessThan(point[1]);
  for (const point of [pixels.horizontal, pixels.vertical]) expect(point[0]).toBeGreaterThan(point[1] + 30);
});

test("rendered taxi body and stroke use the collider dimensions at every zoom", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  const results = await page.evaluate(async () => {
    const { MapView } = await import("/map.mjs?v=streaming-map-1");
    const { RoadNetwork } = await import("/physics.mjs");
    const data = {
      nodes: { a: [0, 0], b: [100, 0] },
      edges: [{ id: "ab", a: "a", b: "b", way: 1, kind: "residential", length: 100,
        name: "Local road", layer: "0" }],
      backdrop: [], bounds: [-20, -20, 120, 20],
      driving: { taxi_radius: 3, taxi_length: 5.4, taxi_width: 2.6, widths: { residential: 10 } },
    };
    const roads = new RoadNetwork(data), view = new MapView(document.createElement("canvas"), data, []);
    const results = [], roundRect = view.ctx.roundRect.bind(view.ctx);
    let dimensions;
    view.ctx.roundRect = function (x, y, width, height, radius) {
      const m = this.getTransform(), zoom = view.zoom * view.ratio;
      dimensions = {
        length: (width + this.lineWidth) * Math.hypot(m.a, m.b) / zoom,
        width: (height + this.lineWidth) * Math.hypot(m.c, m.d) / zoom,
      };
      return roundRect(x, y, width, height, radius);
    };
    for (const zoom of [0.35, 1.65, 3.5]) {
      for (const heading of [0, Math.PI / 4, Math.PI / 2]) {
        view.zoom = zoom;
        const support = Math.abs(Math.sin(heading)) * 2.7 + Math.abs(Math.cos(heading)) * 1.3;
        const car = { x: 50, y: 5 - support, heading, edge: "ab" };
        view.camera = { ...car };
        view.render(car, null, "en", null);
        results.push({ ...dimensions, fits: roads.bodyFits(car, heading, roads.edges.get("ab")) });
      }
    }
    return results;
  });
  for (const result of results) {
    expect(result.length).toBeCloseTo(5.4, 6);
    expect(result.width).toBeCloseTo(2.6, 6);
    expect(result.fits).toBe(true);
  }
});

test("road arrows show only legal directions with left-side opposing arrows on two-way roads", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  const arrows = await page.evaluate(async () => {
    const { MapView } = await import("/map.mjs?v=streaming-map-1");
    const edges = [
      { a: "a", b: "b", way: 1, kind: "residential", length: 100 },
      { a: "b", b: "a", way: 1, kind: "residential", length: 100, wrongway: true },
      { a: "c", b: "d", way: 2, kind: "residential", length: 100 },
      { a: "d", b: "c", way: 2, kind: "residential", length: 100 },
      { a: "e", b: "f", way: 3, kind: "residential", length: 10 },
    ];
    const arrows = [];
    const context = { save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
      translate(x, y) { arrows.push({ x, y }); },
      rotate(angle) { arrows.at(-1).angle = angle; } };
    MapView.prototype.drawRoadDirections.call({
      directionArrows: MapView.prototype.directionArrows,
      data: { edges, nodes: { a: [0, 0], b: [100, 0], c: [0, 30], d: [100, 30], e: [0, 60], f: [10, 60] },
        driving: { widths: { residential: 10 } } },
    }, context);
    return arrows;
  });
  expect(arrows).toHaveLength(3);
  expect(arrows[0]).toEqual({ x: 50, y: 0, angle: 0 });
  expect(arrows[1]).toEqual({ x: 50, y: 27.5, angle: 0 });
  expect(arrows[2].x).toBeCloseTo(50);
  expect(arrows[2].y).toBe(32.5);
  expect(arrows[2].angle).toBeCloseTo(Math.PI);
});

test("2D guides keep routes and selected exits without normal road guidance", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  const colors = await page.evaluate(async () => {
    const { MapView } = await import("/map.mjs?v=streaming-map-1");
    const edges = [
      { id: "in", a: "a", b: "b", way: 1, kind: "residential", length: 100, name: "Local road", layer: "0" },
      { id: "exit", a: "b", b: "c", way: 2, kind: "residential", length: 100, name: "Local road", layer: "0" },
    ];
    const view = new MapView(document.createElement("canvas"), {
      nodes: { a: [0, 0], b: [100, 0], c: [200, 0] }, edges, backdrop: [],
      bounds: [-20, -30, 220, 30], driving: { widths: { residential: 10 } },
    }, []);
    const highlights = [];
    const highlight = view.highlightExit;
    view.highlightExit = function (context, edge, ...rest) {
      highlights.push(edge.id);
      return highlight.call(this, context, edge, ...rest);
    };
    const colors = [], stroke = view.ctx.stroke.bind(view.ctx);
    view.ctx.stroke = function (...args) { colors.push(this.strokeStyle); return stroke(...args); };
    const results = [];
    for (const phase of ["pickup", "onboard"]) {
      colors.length = 0;
      view.render({ x: 80, y: 0, heading: 0, edge: "in" }, {
      edge: "in", closed: [], traffic: { 1: 0.5 }, route: ["in", "exit"],
      selected_exit: "exit", selected_junction: "b",
      phase,
    }, "en", {
      start: { x: 80, y: 0 }, edges: [edges[0]], incoming: "in",
      exits: [{ edge: edges[1], path: { edges: [edges[1]] } }],
    });
      results.push({ phase, colors: [...colors] });
    }
    highlights.length = 0;
    view.render({ x: 80, y: 0, heading: 0, edge: "in" }, {
      edge: "in", closed: [], traffic: {}, route: null,
      selected_exit: null, phase: "available",
    }, "en", {
      start: { x: 80, y: 0 }, edges: [edges[0]], incoming: "in",
      exits: [{ edge: edges[1], path: { edges: [edges[1]] } }],
    });
    if (highlights.length) throw new Error("Unselected road guides must not be drawn.");
    return results;
  });
  for (const { phase, colors: strokes } of colors) {
    const selected = strokes.lastIndexOf("#55e9ff");
    const route = strokes.lastIndexOf(phase === "pickup" ? "#92d7b6" : "#f5c65a");
    expect(route).toBeGreaterThanOrEqual(0);
    expect(selected).toBeGreaterThan(route);
    expect(strokes).not.toContain("#b5e3d780");
    if (phase === "pickup") expect(strokes).not.toContain("#f5c65a");
  }
});
