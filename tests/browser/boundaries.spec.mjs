import { test, expect } from "@playwright/test";

test("road outlines are light red at 80% opacity without tinting the road interior", async ({ page }, testInfo) => {
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
    MapView.prototype.drawRoadBoundaries = () => {};
    const baseline = new MapView(document.createElement("canvas"), data, []);
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
      edge: pixel(outlined, 5), oldEdge: pixel(baseline, 5),
      outerEdge: pixel(outlined, 5.2), oldOuterEdge: pixel(baseline, 5.2),
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
  expect(result.edge[0]).toBeGreaterThan(result.oldEdge[0] + 20);
  expect(result.edge[0]).toBeGreaterThan(result.edge[1]);
  expect(result.outerEdge[0]).toBeGreaterThan(result.oldOuterEdge[0] + 20);
  await page.screenshot({ path: testInfo.outputPath("road-boundaries.png") });
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
