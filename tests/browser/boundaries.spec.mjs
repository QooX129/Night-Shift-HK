import { test, expect } from "@playwright/test";

test("only collider outlines are light red at 80% opacity without tinting the road interior", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  const result = await page.evaluate(async () => {
    const { MapView } = await import("/map.mjs");
    const draw = MapView.prototype.drawRoadBoundaries;
    const canvas = document.createElement("canvas");
    const edge = { id: "road", a: "a", b: "b", way: 1, kind: "residential", length: 100,
      name: "Local road", zh: "", layer: "0" };
    const data = { nodes: { a: [0, 0], b: [100, 0] }, edges: [edge], backdrop: [],
      bounds: [-20, -20, 120, 20], driving: { taxi_radius: 2.5, widths: { residential: 10 } } };
    const alpha = [];
    MapView.prototype.drawRoadBoundaries = function (context, scale) {
      const drawImage = context.drawImage;
      context.drawImage = function (...args) {
        alpha.push(this.globalAlpha);
        return drawImage.apply(this, args);
      };
      draw.call(this, context, scale);
      context.drawImage = drawImage;
    };
    const outlined = new MapView(canvas, data, []);
    outlined.buildBackdrop(data.bounds, 1.4);
    MapView.prototype.drawRoadBoundaries = () => {};
    const baseline = new MapView(document.createElement("canvas"), data, []);
    baseline.buildBackdrop(data.bounds, 1.4);
    MapView.prototype.drawRoadBoundaries = draw;
    const points = [];
    const context = { beginPath() {}, moveTo: (...point) => points.push(point),
      lineTo: (...point) => points.push(point), stroke() {} };
    outlined.highlightExit(context, edge, "#92d7b6", 1, {
      start: { x: 40, y: 0 }, edges: [edge, { b: "a" }],
    });
    const pixel = (view, y) => [...view.backdrop.getContext("2d").getImageData(84, Math.round((y + 20) * 1.4), 1, 1).data];
    const result = { alpha, points, centre: pixel(outlined, 0), oldCentre: pixel(baseline, 0),
      collider: pixel(outlined, 2.5), oldCollider: pixel(baseline, 2.5),
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

test("narrow-road collider outlines match physics limits including zero-width centre corridors", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  const results = await page.evaluate(async () => {
    const { MapView } = await import("/map.mjs");
    const { RoadNetwork } = await import("/physics.mjs");
    const results = [];
    for (const width of [8, 10, 16]) {
      for (const taxiRadius of [3, 4]) {
        const edge = { id: "road", a: "a", b: "b", way: 1, kind: "service", length: 100,
          name: "Local road", zh: "", layer: "0" };
        const data = { nodes: { a: [0, 0], b: [100, 0] }, edges: [edge], backdrop: [],
          bounds: [-20, -20, 120, 20], driving: { taxi_radius: taxiRadius, widths: { service: width } } };
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
    const { MapView } = await import("/map.mjs");
    const data = {
      nodes: { a: [-20, 0], b: [0, 0], c: [20, 0], d: [0, 20] },
      edges: [["a", "b"], ["b", "c"], ["b", "d"]].map(([a, b], i) => ({
        id: `${i}`, a, b, way: i, kind: "residential", length: 20,
        name: "Local road", layer: "0",
      })),
      backdrop: [], bounds: [-30, -30, 30, 30],
      driving: { taxi_radius: 3, widths: { residential: 10 } },
    };
    const view = new MapView(document.createElement("canvas"), data, []);
    view.buildBackdrop(data.bounds, 4);
    const c = view.backdrop.getContext("2d");
    const pixel = (x, y) => [...c.getImageData((x + 30) * 4, (y + 30) * 4, 1, 1).data];
    return { centre: pixel(0, 0), opening: pixel(0, 2),
      horizontal: pixel(-7, -2), vertical: pixel(2, 7) };
  });
  for (const point of [pixels.centre, pixels.opening]) expect(point[0]).toBeLessThan(point[1]);
  for (const point of [pixels.horizontal, pixels.vertical]) expect(point[0]).toBeGreaterThan(point[1] + 30);
});

test("road arrows show only legal directions with left-side opposing arrows on two-way roads", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  const arrows = await page.evaluate(async () => {
    const { MapView } = await import("/map.mjs");
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

test("yellow destination route renders above traffic, forward, exit, and selected-road highlights", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  const colors = await page.evaluate(async () => {
    const { MapView } = await import("/map.mjs");
    const edges = [
      { id: "in", a: "a", b: "b", way: 1, kind: "residential", length: 100, name: "Local road", layer: "0" },
      { id: "exit", a: "b", b: "c", way: 2, kind: "residential", length: 100, name: "Local road", layer: "0" },
    ];
    const view = new MapView(document.createElement("canvas"), {
      nodes: { a: [0, 0], b: [100, 0], c: [200, 0] }, edges, backdrop: [],
      bounds: [-20, -30, 220, 30], driving: { widths: { residential: 10 } },
    }, []);
    const colors = [], stroke = view.ctx.stroke.bind(view.ctx);
    view.ctx.stroke = function (...args) { colors.push(this.strokeStyle); return stroke(...args); };
    view.render({ x: 80, y: 0, heading: 0, edge: "in" }, {
      edge: "in", closed: [], traffic: { 1: 0.5 }, route: ["in", "exit"], phase: "onboard",
      selected_exit: "exit", selected_junction: "b",
    }, "en", {
      start: { x: 80, y: 0 }, edges: [edges[0]], incoming: "in",
      exits: [{ edge: edges[1], path: { edges: [edges[1]] } }],
    });
    return colors;
  });
  const yellow = colors.lastIndexOf("#f5c65a");
  for (const color of ["#bd955c", "#92d7b6", "#55e9ff"]) {
    expect(colors.indexOf(color)).toBeGreaterThanOrEqual(0);
    expect(yellow).toBeGreaterThan(colors.lastIndexOf(color));
  }
});
