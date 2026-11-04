import test from "node:test";
import assert from "node:assert/strict";
import { straightJoin, mergeStraightSegments, colliderSegments } from "../web/straight-lines.mjs";
import { RoadNetwork } from "../web/physics.mjs";
import { CollisionLines } from "../web/collision-lines.mjs";

const data = () => ({
  nodes: { a: [0, 0], b: [10, 0], c: [20, 0], d: [30, 0] },
  edges: [["a", "b"], ["b", "c"], ["c", "d"]].flatMap(([a, b], i) => {
    const edge = { id: String(i), a, b, way: 1, kind: "residential", width: 6,
      layer: "0", bridge: "no", tunnel: "no" };
    return [edge, { ...edge, id: `${i}r`, a: b, b: a }];
  }),
  bounds: [-20, -20, 50, 20],
  driving: { taxi_length: 3.7, taxi_width: 1.7, widths: { residential: 6 } },
});

test("straight segments merge once with a one-degree and one-centimetre limit", () => {
  assert.equal(straightJoin([[0, 0], [1, 0]], [2, .01]), true);
  assert.equal(straightJoin([[0, 0], [1, 0]], [2, .04]), false);
  assert.equal(straightJoin([[0, 0], [100, 0]], [200, 1]), false);
  assert.equal(straightJoin([[0, 0], [1, 0]], [0, 0]), false);
  const chains = mergeStraightSegments([
    { a: [0, 0], b: [10, 0] }, { a: [10, 0], b: [20, 0] },
    { a: [20, 0], b: [30, 0] },
  ]);
  assert.equal(chains.length, 1);
  assert.deepEqual(chains[0].b, [30, 0]);
});

test("opposing edges become a single straight body collider without deleting routing nodes", () => {
  const roads = new RoadNetwork(data());
  const colliders = colliderSegments(roads, [...roads.edges.values()]);
  assert.equal(colliders.length, 1);
  assert.equal(roads.edges.size, 6);
  for (const x of [9, 10, 11, 19, 20, 21]) {
    assert.equal(roads.bodyFits({ x, y: 2 }, 0, roads.edges.get("1")), true);
    assert.equal(roads.bodyFits({ x, y: 2.2 }, 0, roads.edges.get("1")), false);
  }
});

test("width changes, road levels, bends and disconnected segments remain separate", () => {
  for (const change of [
    fixture => fixture.edges.filter(edge => edge.id.startsWith("1")).forEach(edge => edge.width = 5),
    fixture => fixture.edges.filter(edge => edge.id.startsWith("1")).forEach(edge => edge.layer = "1"),
    fixture => fixture.nodes.c[1] = 2,
    fixture => { fixture.nodes.x = [10, 0]; fixture.edges.filter(edge => edge.id === "1").forEach(edge => edge.a = "x"); },
  ]) {
    const fixture = data();
    change(fixture);
    const roads = new RoadNetwork(fixture);
    assert.ok(colliderSegments(roads, [...roads.edges.values()]).length > 1);
  }
});

test("straight outline sides are single lines instead of duplicate segment walls", () => {
  const lines = new CollisionLines(data()).all();
  const sides = lines.filter(line => Math.abs(line.a[1]) === 3 && line.a[1] === line.b[1]);
  assert.equal(sides.length, 2);
  for (const line of sides) assert.equal(Math.abs(line.b[0] - line.a[0]), 30);
});
