import test from "node:test";
import assert from "node:assert/strict";
import { CollisionLines } from "../web/collision-lines.mjs";
import { project } from "../web/physics.mjs";

function fixture(branch = true) {
  const nodes = { a: [-100, 0], b: [0, 0], c: [100, 0], d: [0, 100],
    e: [20, -100], f: [20, 100] };
  const pairs = branch ? [["a", "b"], ["b", "c"], ["b", "d"], ["e", "f"]]
    : [["a", "b"], ["b", "c"], ["e", "f"]];
  return { nodes, bounds: [-200, -200, 200, 200], driving: {
    taxi_length: 5.4, taxi_width: 2.6, taxi_radius: 3, widths: { residential: 10 },
  }, edges: pairs.flatMap(([a, b], i) => [
    { id: `${i}`, way: i, a, b, kind: "residential" },
    { id: `${i}r`, way: i, a: b, b: a, kind: "residential" },
  ]) };
}

const middle = line => ({ x: (line.a[0] + line.b[0]) / 2, y: (line.a[1] + line.b[1]) / 2 });
const near = (lines, x, y, distance = .1) => lines.some(({ a, b }) =>
  project({ x, y }, a, b).distance < distance);

test("connected openings are clear; actual physical edges remain and agree with body collision", () => {
  const renderer = new CollisionLines(fixture()), car = { x: 0, y: 0, edge: "0" };
  const lines = renderer.all();
  assert.ok(lines.length);
  assert.ok(near(lines, -20, -5));
  assert.ok(near(lines, 5, 20));
  assert.ok(!near(lines, 0, 5));
  assert.ok(near(lines, 0, -5));
  assert.equal(renderer.roads.bodyFits({ x: 0, y: 6 }, Math.PI / 2, renderer.roads.edges.get("0")), true);
  assert.equal(renderer.roads.bodyFits({ x: -20, y: -5 }, 0, renderer.roads.edges.get("0")), false);
  for (const line of lines) {
    const p = middle(line), candidates = renderer.roads.candidates(p, line.edge);
    // Arc chords approximate the true rounded edge to less than one centimetre.
    assert.ok(Math.abs(project(p, renderer.roads.nodes[line.edge.a],
      renderer.roads.nodes[line.edge.b]).distance - renderer.roads.radius(line.edge)) < .01);
    assert.ok(!candidates.some(edge => edge.way !== line.edge.way
      && project(p, renderer.roads.nodes[edge.a], renderer.roads.nodes[edge.b]).distance
        < renderer.roads.radius(edge) - .02), JSON.stringify(line));
  }
});

test("disconnected overlapping crossing neither erases the wall nor adds another road's lines", () => {
  const renderer = new CollisionLines(fixture(false));
  const lines = renderer.all();
  assert.ok(near(lines, 20, 5));
  assert.ok(near(lines, 20, -5));
  assert.ok(lines.some(line => line.edge.way === 2));
  assert.equal(renderer.roads.bodyFits({ x: 20, y: 8 }, 0, renderer.roads.edges.get("1")), false);
});

test("a connection far from the crossing does not create a local junction opening", () => {
  const data = fixture(false);
  data.nodes.g = [100, 100];
  for (const [a, b, id] of [["c", "g", "cg"], ["g", "f", "gf"]]) {
    const edge = { id, a, b, way: 99, kind: "residential" };
    data.edges.push(edge, { ...edge, id: `${id}r`, a: b, b: a });
  }
  const renderer = new CollisionLines(data), roads = renderer.roads;
  assert.ok(near(renderer.all(), 20, 5));
  assert.equal(roads.bodyFits({ x: 20, y: 8 }, 0, roads.edges.get("1")), false);
});

test("static geometry is shared across movement and covers the whole map", () => {
  const renderer = new CollisionLines(fixture()), car = { x: -24, y: 0, edge: "0" };
  const lines = renderer.all();
  assert.equal(renderer.all(), lines);
  assert.equal(renderer.all(), lines);
  assert.ok(lines.every(line => [line.a, line.b].every(([x, y]) =>
    x >= -200 && x <= 200 && y >= -200 && y <= 200)));
  assert.ok(near(lines, 95, 5), "distant boundaries must be present without moving the taxi");
  assert.ok(!near(lines, 36, 0), "there must be no local-cache end cap");
});

test("district border is marked only on the road surface", () => {
  const data = fixture(false);
  data.bounds = [-50, -50, 50, 50];
  const renderer = new CollisionLines(data);
  const lines = renderer.all();
  assert.ok(near(lines, 50, 0));
  assert.ok(!near(lines, 50, 20));
  assert.ok(lines.every(line => [line.a, line.b].every(([x, y]) =>
    x >= -50 && x <= 50 && y >= -50 && y <= 50)));
});

test("a disconnected elevated crossing stays separate", () => {
  const data = fixture(false);
  data.elevation = { node_heights: { a: 4, b: 4, c: 6, e: 20, f: 20 } };
  const renderer = new CollisionLines(data);
  const lines = renderer.all();
  assert.ok(near(lines, 20, 5));
  assert.ok(lines.some(line => line.edge.way === 2));
});

test("coincident ways do not erase the shared outer wall", () => {
  const data = fixture(false);
  data.edges.push({ ...data.edges[0], id: "duplicate", way: 99 });
  const renderer = new CollisionLines(data);
  const lines = renderer.all();
  assert.ok(near(lines, -20, -5));
  assert.ok(near(lines, -20, 5));
  assert.ok(!near(lines, 0, 0));
});

test("static boundaries require no current taxi road", () => {
  assert.ok(new CollisionLines(fixture()).all().length);
});

test("continuous sloped segments do not leave rounded caps inside the road", () => {
  const data = fixture(false);
  data.elevation = { node_heights: { a: 12, b: 0, c: 12, e: 20, f: 20 } };
  const renderer = new CollisionLines(data);
  const lines = renderer.all();
  assert.ok(!near(lines, 3, 4, .2));
  assert.ok(near(lines, 0, 5));
});

test("unequal-width fork openings remain connected beyond the shared-node radius", () => {
  const data = fixture(false);
  data.nodes = { a: [0, 0], b: [100, 0], c: [100, 30] };
  data.edges = [
    { id: "narrow", way: 1, a: "a", b: "b", kind: "residential", width: 3 },
    { id: "wide", way: 2, a: "a", b: "c", kind: "residential", width: 12 },
  ].flatMap(edge => [edge, { ...edge, id: `${edge.id}r`, a: edge.b, b: edge.a }]);
  const renderer = new CollisionLines(data), roads = renderer.roads;
  const previous = roads.edges.get("narrow");
  const lines = renderer.all();
  assert.ok(!near(lines, 15, 1.5), "the narrow road wall must stop inside the wider connected opening");
  const point = { x: 15, y: 2 };
  assert.ok(roads.candidates(point, previous).some(edge => edge.id === "wide"));
  assert.ok(roads.bodyFits(point, 0, previous));
  assert.ok(roads.match(point, 0, previous));
  const selected = roads.candidates(point, previous, "narrow", "a");
  assert.ok(selected.every(edge => edge.id !== "wide"));
});

test("short Waterloo slip-road segments cannot leave walls or colliders inside the main road", () => {
  const data = fixture(false);
  data.nodes = {
    j: [443.69, -266.22], s: [447.69, -269.55], t: [451.58, -273.03],
    u: [454, -274.12], m: [446.54, -270.47], n: [461.29, -294.31],
  };
  data.bounds = [400, -320, 500, -240];
  data.driving.taxi_length = 3.7;
  data.driving.taxi_width = 1.7;
  data.edges = [["j", "s", 3], ["s", "t", 3], ["t", "u", 3], ["j", "m", 6], ["m", "n", 6]]
    .flatMap(([a, b, width], i) => {
      const edge = { id: `${i}`, a, b, width, way: i < 3 ? 1 : 2,
        kind: i < 3 ? "primary_link" : "primary", layer: "0" };
      return [edge, { ...edge, id: `${i}r`, a: b, b: a }];
    });
  const renderer = new CollisionLines(data), roads = renderer.roads;
  const side = roads.edges.get("1"), main = roads.edges.get("4");
  const point = { x: 448.7525, y: -274.046 };
  assert.ok(roads.bodyFits(point, roads.angle(main), main));
  assert.ok(roads.bodyFits(point, roads.angle(main), side),
    "switching to a nearby slip road must not remove the main-road corridor");
  assert.ok(roads.match(point, roads.angle(main), side));
  assert.ok(!near(renderer.all(), 449.931558, -273.567937, .2),
    "the slip-road wall lies inside the main-road deck");
  assert.ok(near(renderer.all(), 455, -289.5, 2), "outer road borders must remain");
});
