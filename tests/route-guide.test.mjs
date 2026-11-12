import test from "node:test";
import assert from "node:assert/strict";
import { upcomingRoute } from "../web/route-guide.mjs";

const edges = new Map([
  ["one", { id: "one", a: "a", b: "b", way: 1 }],
  ["~one", { id: "~one", a: "b", b: "a", way: 1 }],
  ["two", { id: "two", a: "b", b: "c", way: 1 }],
  ["three", { id: "three", a: "c", b: "d", way: 2 }],
  ["other", { id: "other", a: "b", b: "e", way: 3 }],
]);

test("the guide starts after the current segment and advances before the server update", () => {
  const route = ["one", "two", "three"];
  assert.deepEqual(upcomingRoute(route, edges, "one"), ["two", "three"]);
  assert.deepEqual(upcomingRoute(route, edges, "two"), ["three"]);
  assert.deepEqual(upcomingRoute(route, edges, "three"), []);
  assert.deepEqual(route, ["one", "two", "three"]);
});

test("reverse directions hide the same physical segment, and off-route guides wait for a new plan", () => {
  assert.deepEqual(upcomingRoute(["one", "two"], edges, "~one"), ["two"]);
  assert.deepEqual(upcomingRoute(["one", "two"], edges, "other"), []);
  assert.equal(upcomingRoute(null, edges, "other"), null);
});
