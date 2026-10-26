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
      bounds: [-20, -20, 120, 20], driving: { widths: { residential: 10 } } };
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
      edge: pixel(outlined, 5), oldEdge: pixel(baseline, 5),
      outside: pixel(outlined, 10), oldOutside: pixel(baseline, 10) };
    document.body.replaceChildren(outlined.backdrop);
    return result;
  });
  expect(result.alpha).toEqual([0.8]);
  expect(result.points).toEqual([[40, 0], [100, 0], [0, 0]]);
  expect(result.centre).toEqual(result.oldCentre);
  expect(result.outside).toEqual(result.oldOutside);
  expect(result.edge[0]).toBeGreaterThan(result.oldEdge[0] + 20);
  expect(result.edge[0]).toBeGreaterThan(result.edge[1]);
  await page.screenshot({ path: testInfo.outputPath("road-boundaries.png") });
});
