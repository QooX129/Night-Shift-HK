import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RoadNetwork, stepCar } from "../web/physics.mjs";
import { surfacePose, surfaceSegments, slopeSpeedLimit, terrainHeight } from "../web/elevation.mjs";

test("smooth vertical ramp matches server equations and has continuous endpoint pitch", () => {
  const roads = {
    nodes: { a: [0, 0], b: [100, 0], c: [200, 0], d: [300, 0] },
    elevation: { node_heights: { a: 0, b: 0, c: 10, d: 10 },
      road_profiles: { ab: [0, 0], bc: [0, 0], cd: [0, 0], reverse: [0, 0] } },
  };
  const edges = [{ id: "ab", a: "a", b: "b" }, { id: "bc", a: "b", b: "c" },
    { id: "cd", a: "c", b: "d" }, { id: "reverse", a: "c", b: "b" }];
  const at = (edge, x) => surfacePose(roads, edge, { x, y: 0 }, 0);
  assert.equal(at(edges[1], 125).height, 1.5625);
  assert.equal(at(edges[1], 125).grade, .1125);
  for (const [before, after] of [[edges[0], edges[1]], [edges[1], edges[2]]]) {
    const x = roads.nodes[before.b][0];
    assert.equal(at(before, x).height, at(after, x).height);
    assert.equal(at(before, x).grade, at(after, x).grade);
    assert.ok(Math.abs(at(before, x - .001).pitch - at(after, x + .001).pitch) < .0001);
  }
  for (let x = 100; x <= 200; x++) {
    assert.ok(at(edges[1], x).height >= 0 && at(edges[1], x).height <= 10);
    assert.ok(Math.abs(at(edges[1], x).height - at(edges[3], x).height) < 1e-10);
  }
  const segments = surfaceSegments(roads, edges[1]);
  assert.equal(segments.length, 50);
  for (const [a, b] of segments) {
    const actual = at(edges[1], (a[0] + b[0]) / 2).height;
    const linear = (at(edges[1], a[0]).height + at(edges[1], b[0]).height) / 2;
    assert.ok(Math.abs(actual - linear) < .003);
  }
  assert.equal(surfaceSegments(roads, edges[0]).length, 1);
});

test("short steep transitions refine the mesh to a five-millimetre vertical error budget", () => {
  const roads = { nodes: { a: [0, 0], b: [2, 0] },
    elevation: { node_heights: { a: 0, b: .24 }, road_profiles: { ramp: [0, 0] } } };
  const edge = { id: "ramp", a: "a", b: "b" };
  const at = x => surfacePose(roads, edge, { x, y: 0 }, 0).height;
  const segments = surfaceSegments(roads, edge);
  assert.ok(segments.length > 1);
  for (const [a, b] of segments) {
    for (const t of [.25, .5, .75]) {
      assert.ok(Math.abs(at(a[0] + (b[0] - a[0]) * t) - (at(a[0]) * (1 - t) + at(b[0]) * t)) <= .005);
    }
  }
});

function slope(grade) {
  return new RoadNetwork({ nodes: { a: [0, 0], b: [100, 0] },
    edges: [{ id: "ab", a: "a", b: "b", way: 1, kind: "primary", length: 100 }],
    bounds: [-100, -100, 200, 100], driving: { taxi_radius: 2, widths: { primary: 16 },
      max_speed: 40, acceleration: 7 },
    elevation: { node_heights: { a: 5, b: 5 + grade * 100 } } });
}
test("surface height, heading-projected grade and speed limit match Python equations", () => {
  const roads = slope(.1), edge = roads.edges.get("ab");
  assert.deepEqual(surfacePose(roads, edge, { x: 50, y: 2 }, 0),
    { height: 10, grade: .1, pitch: Math.atan(.1) });
  assert.equal(surfacePose(roads, edge, { x: 50, y: 0 }, Math.PI).grade, -.1);
  assert.equal(slopeSpeedLimit(40, .1), 32);
  assert.ok(Math.abs(surfacePose(roads, edge, { x: 50, y: 0 }, Math.PI / 2).grade) < 1e-10);
});
test("uphill acceleration and downhill braking include gravity, without jumps or rollover", () => {
  const simulate = (grade, input) => {
    const roads = slope(grade), car = { x: 30, y: 0, speed: 10, heading: 0, edge: "ab" };
    stepCar(car, input, 1 / 60, { roads });
    return car.speed;
  };
  assert.ok(simulate(.1, { gas: true }) < simulate(0, { gas: true }));
  assert.ok(simulate(-.1, { gas: true }) > simulate(0, { gas: true }));
  assert.ok(simulate(-.1, { brake: true }) > simulate(.1, { brake: true }));
  const roads = slope(-.12), car = { x: 30, y: 0, speed: .01, heading: 0, edge: "ab" };
  stepCar(car, { handbrake: true }, 1 / 60, { roads });
  assert.equal(car.speed, 0);
  assert.equal("roll" in car, false);
});
test("curved local grade drives acceleration in both travel directions", () => {
  const roads = slope(.1);
  roads.elevation.road_profiles = { ab: [0, 0] };
  const gravity = 9.81 * .1125 / Math.sqrt(1 + .1125 ** 2);
  for (const [heading, expected] of [[0, 10 + (7 - gravity) / 60], [Math.PI, 10 + (7 + gravity) / 60]]) {
    const car = { x: 25, y: 0, speed: 10, heading, edge: "ab" };
    stepCar(car, { gas: true }, 1 / 60, { roads });
    assert.ok(Math.abs(car.speed - expected) < 1e-10);
  }
});
test("overlapping connected forks cannot change to an incompatible road height", () => {
  const roads = slope(0);
  roads.nodes.c = [200, 0]; roads.nodes.d = [200, 0];
  roads.elevation.node_heights.c = 5; roads.elevation.node_heights.d = 17;
  const ground = { id: "ground", a: "b", b: "c", way: 2, kind: "primary", length: 100 };
  const deck = { id: "deck", a: "b", b: "d", way: 3, kind: "primary", length: 100 };
  for (const edge of [ground, deck]) {
    roads.edges.set(edge.id, edge);
    if (!roads.outgoing.has(edge.a)) roads.outgoing.set(edge.a, []);
    roads.outgoing.get(edge.a).push(edge);
  }
  assert.equal(roads.match({ x: 108, y: 0 }, 0, ground).edge.id, "ground");
  assert.equal(surfacePose(roads, ground, { x: 100, y: 0 }, 0).height,
    surfacePose(roads, deck, { x: 100, y: 0 }, 0).height);
});
test("packaged pilot is official model derived, estimates remain explicitly labelled", () => {
  const data = JSON.parse(readFileSync(new URL("../data/district.json", import.meta.url)));
  data.driving = { taxi_radius: 3, taxi_length: 8, taxi_width: 4,
    widths: { primary: 16, secondary: 14, tertiary: 12, unclassified: 10, residential: 10,
      service: 8, primary_link: 10, secondary_link: 10, tertiary_link: 10 },
    max_speed: 150 / 3.6, acceleration: 7 };
  data.elevation = JSON.parse(readFileSync(new URL("../data/elevation.json", import.meta.url)));
  const roads = new RoadNetwork(data), pilot = data.elevation.pilot;
  assert.ok(pilot.source.includes("data.map.gov.hk"));
  assert.ok(pilot.source_lod.includes("R0"));
  assert.ok(pilot.triangles.length > 100);
  assert.ok(pilot.height_status.includes("NOT survey verified"));
  const point = { x: pilot.point[0], y: pilot.point[1] };
  const bridge = roads.edges.get(pilot.bridge), ground = roads.edges.get(pilot.ground);
  const upper = surfacePose(roads, bridge, point, roads.angle(bridge));
  const lower = surfacePose(roads, ground, point, roads.angle(ground));
  assert.ok(upper.height - lower.height > 4, "physical separation at the source-confirmed pilot");
  assert.equal(roads.candidates(point, bridge).some(e => e.id === ground.id), false);
  for (const edge of roads.edges.values()) {
    const pose = surfacePose(roads, edge, { x: roads.nodes[edge.a][0], y: roads.nodes[edge.a][1] }, roads.angle(edge));
    assert.ok(Math.abs(pose.grade) <= .12002, edge.id);
    assert.ok(Number.isFinite(pose.height));
  }
  assert.ok(data.elevation.buildings.some(b => b.quality === "osm-tagged-height-not-survey-verified"));
  assert.ok(data.elevation.buildings.some(b => b.quality.startsWith("estimated-")));
  assert.ok(Number.isFinite(terrainHeight(data.elevation, 0, 0)));
});
