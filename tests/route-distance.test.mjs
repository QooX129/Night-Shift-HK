import test from "node:test";
import assert from "node:assert/strict";
import { routeDistance } from "../web/route-distance.mjs";

const roads = {
  nodes: { a: [0, 0], b: [100, 0], c: [100, 50], d: [200, 50] },
  edges: new Map([
    ["ab", { id: "ab", a: "a", b: "b", length: 100 }],
    ["bc", { id: "bc", a: "b", b: "c", length: 50 }],
    ["cd", { id: "cd", a: "c", b: "d", length: 100 }],
  ]),
};

test("route distance uses partial start and end edges and full intermediate roads", () => {
  assert.equal(routeDistance(["ab", "bc", "cd"], roads, { x: 60, y: 3 },
    { edge: "cd", point: [130, 50] }), 120);
  assert.ok(Math.abs(routeDistance(["ab"], roads, { x: 25, y: 0 },
    { edge: "ab", point: [80, 0] }) - 55) < 1e-8);
});

test("route distance is unavailable without a usable route to the stop", () => {
  const stop = { edge: "ab", point: [10, 0] };
  assert.equal(routeDistance(null, roads, { x: 50, y: 0 }, stop), null);
  assert.equal(routeDistance(["missing"], roads, { x: 50, y: 0 }, stop), null);
  assert.equal(routeDistance(["ab"], roads, { x: 50, y: 0 }, stop), null);
  assert.equal(routeDistance(["bc"], roads, { x: 50, y: 0 }, stop), null);
});
