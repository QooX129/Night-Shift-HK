import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { VisualStream, VISUAL_CHUNK_CACHE_LIMIT } from "../web/map-stream.mjs";
import { SpatialGrid, pointBounds } from "../web/spatial-grid.mjs";
import { Map3DView } from "../web/map3d.mjs";
import { surfacePose } from "../web/elevation.mjs";
import * as THREE from "../web/vendor/three/three.module.min.js";

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(keys) {
  return { backdrop: [], visualChunks: { version: "v1", size: 256, keys } };
}
function response(key) {
  const [x, y] = key.split(":").map(Number);
  return { ok: true, json: async () => ({ version: "v1", key,
    backdrop: [{ id: x * 10000 + y, kind: "building", points: [[0, 0], [1, 0], [0, 1]] }] }) };
}

test("brake marks remain for one minute before fading, even beyond initial capacity", () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(256 * 12 * 3), 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(256 * 12 * 4), 4));
  const view = Object.assign(Object.create(Map3DView.prototype), {
    data: { driving: { taxi_length: 2.61, taxi_width: 1.35 } },
    edges: new Map([["road", { id: "road" }]]), skids: [], skidMesh: { geometry },
  });
  const started = performance.now() / 1000;
  for (let i = 0; i < 300; i++) {
    view.recordSkid({ x: i * .4, y: 0, heading: 0, edge: "road" },
      { x: (i + 1) * .4, y: 0, heading: 0, edge: "road" }, true);
  }
  const firstExpiry = view.skids[0].expires;
  assert(firstExpiry >= started + 61.5 && firstExpiry < started + 61.6);
  view.updateSkids(firstExpiry - 1.5);
  assert.equal(view.skids.length, 300);
  assert.equal(geometry.drawRange.count, 300 * 12);
  assert(Math.abs(geometry.attributes.color.getW(0) - .62) < 1e-6);
  view.updateSkids(firstExpiry - .75);
  assert(Math.abs(geometry.attributes.color.getW(0) - .31) < 1e-6);
  view.updateSkids(view.skids.at(-1).expires + .01);
  assert.equal(view.skids.length, 0);
  assert.equal(geometry.drawRange.count, 0);
  geometry.dispose();
});

test("spatial queries deduplicate crossing objects and omit distant objects", () => {
  const near = { points: [[-5, -5], [270, 10]] }, far = { points: [[10000, 10000], [10010, 10010]] };
  const grid = new SpatialGrid([near, far], shape => pointBounds(shape.points));
  assert.deepEqual(grid.query([-10, -10, 300, 20]), [near]);
});

function assertClosedBands(positions) {
  const edges = new Map();
  const vertex = i => positions.slice(i, i + 3).map(v => v.toFixed(6)).join(":");
  for (let i = 0; i < positions.length; i += 18) {
    for (const [a, b] of [[i, i + 3], [i + 6, i + 15]]) {
      const key = [vertex(a), vertex(b)].sort().join("|");
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  assert(edges.size > 0);
  const open = [...edges].filter(([, count]) => count % 2 !== 0);
  assert.equal(open.length, 0, `yellow bands must have no exposed strip ends: ${JSON.stringify(open.slice(0, 4))}`);
}

function curbPositions(data) {
  const view = Object.assign(Object.create(Map3DView.prototype), {
    data, nodes: data.nodes, elevation: data.elevation,
    groundMap: { unique: data.edges,
      roadIndex: new SpatialGrid(data.edges, edge => pointBounds([data.nodes[edge.a], data.nodes[edge.b]], 24)) },
  });
  const task = view.curbMarkings();
  let result;
  do { result = task.next(); } while (!result.done);
  return result.value;
}

test("yellow bands are continuous across the entire packaged ground-road map", () => {
  const data = JSON.parse(readFileSync(new URL("../data/district.json", import.meta.url)));
  data.driving = { widths: { primary: 9, secondary: 9, residential: 6 } };
  data.elevation = JSON.parse(readFileSync(new URL("../data/elevation.json", import.meta.url)));
  const positions = curbPositions(data);
  assert(positions.every(Number.isFinite));
  assertClosedBands(positions);
});

test("curved yellow bands stay connected on slopes and exclude flyovers", () => {
  const data = { bounds: [-30, -30, 30, 30], nodes: { a: [0, 0], b: [10, 0] },
    driving: { widths: {} }, edges: [{ id: "slope", a: "a", b: "b", width: 10, kind: "residential" }],
    elevation: { node_heights: { a: 2, b: 6 } } };
  const positions = curbPositions(data);
  assertClosedBands(positions);
  for (let i = 0; i < positions.length; i += 3) {
    const expected = 2.12 + 4 * Math.max(0, Math.min(1, positions[i] / 10));
    assert(Math.abs(positions[i + 1] - expected) < 1e-9);
  }
  data.edges[0].bridge = "yes";
  assert.equal(curbPositions(data).length, 0);
});

test("mixed-width junction yellow bands have closed, rounded corner connections", () => {
  const data = { bounds: [-30, -30, 30, 30],
    nodes: { a: [-20, 0], b: [0, 0], c: [20, 0], d: [0, -20], e: [0, 20] },
    driving: { widths: {} },
    edges: [{ id: "wide", a: "a", b: "b", width: 9 }, { id: "narrow", a: "b", b: "c", width: 6 },
      { id: "cross", a: "d", b: "e", width: 6 }].map(edge => ({ ...edge, kind: "residential" })) };
  const positions = curbPositions(data);
  assertClosedBands(positions);
  const corner = [];
  for (let i = 0; i < positions.length; i += 3)
    if (positions[i] > -2.92 && positions[i] < -2 && positions[i + 2] > 3.5 && positions[i + 2] < 4.42)
      corner.push(Math.hypot(positions[i] + 3, positions[i + 2] - 4.5));
  assert(corner.length >= 12, "the turn has intermediate arc vertices");
  assert(corner.every(radius => radius <= .710001), "no sharp miter projects beyond the rounded band");
});

test("yellow corner connections stay above overlapping ground-road decks", () => {
  const data = { bounds: [-30, -30, 30, 30],
    nodes: { a: [-20, 0], b: [20, 0], c: [0, -20], d: [0, 20] },
    driving: { widths: {} },
    edges: [{ id: "low", a: "a", b: "b", width: 9 }, { id: "high", a: "c", b: "d", width: 6 }],
    elevation: { node_heights: { a: 0, b: 0, c: .3, d: .3 } } };
  const positions = curbPositions(data);
  for (let i = 0; i < positions.length; i += 3)
    if (Math.abs(positions[i]) <= 3 && Math.abs(positions[i + 2]) <= 20)
      assert(positions[i + 1] >= .42 - 1e-9, "the higher asphalt must not hide a joined yellow corner");
});

test("stream loads only nearby chunks with at most two simultaneous requests", async () => {
  const data = fixture(["0:0", "1:0", "2:0", "100:100"]);
  const releases = [], requests = [];
  const stream = new VisualStream(data, { fetcher: url => new Promise(resolve => {
    const [, x, y] = url.match(/\/(-?\d+)\/(-?\d+)$/);
    const key = `${x}:${y}`; requests.push(key); releases.push(() => resolve(response(key)));
  }) });
  stream.interest("player", [0, 0, 600, 100]);
  assert.equal(stream.pending.size, 2);
  while (releases.length) { releases.shift()(); await tick(); }
  assert.equal(stream.cache.size, 3);
  assert(!requests.includes("100:100"));
  assert.equal(data.backdrop.length, 3);
  stream.dispose();
});

test("resident chunks are bounded and revisiting cached regions avoids downloads", async () => {
  const keys = Array.from({ length: 100 }, (_, x) => `${x}:0`);
  const data = fixture(keys), requests = [];
  const stream = new VisualStream(data, { fetcher: async url => {
    const [, x, y] = url.match(/\/(-?\d+)\/(-?\d+)$/);
    requests.push(`${x}:${y}`); return response(`${x}:${y}`);
  } });
  for (let x = 0; x < 100; x++) {
    stream.interest("player", [x * 256 + 1, 1, x * 256 + 2, 2], performance.now() + x * 300);
    await tick();
  }
  assert.equal(stream.cache.size, VISUAL_CHUNK_CACHE_LIMIT);
  assert.equal(data.backdrop.length, VISUAL_CHUNK_CACHE_LIMIT);
  const count = requests.length;
  stream.interest("player", [99 * 256 + 1, 1, 99 * 256 + 2, 2], performance.now() + 31000);
  await tick();
  assert.equal(requests.length, count);
  stream.dispose();
});

test("stale aborted downloads cannot replace the active region", async () => {
  const data = fixture(["0:0", "10:0"]);
  const releases = new Map();
  const stream = new VisualStream(data, { fetcher: url => new Promise(resolve => {
    const [, x, y] = url.match(/\/(-?\d+)\/(-?\d+)$/);
    releases.set(`${x}:${y}`, () => resolve(response(`${x}:${y}`)));
  }) });
  stream.interest("player", [1, 1, 2, 2], 0);
  stream.interest("player", [2561, 1, 2562, 2], 300);
  releases.get("0:0")(); await tick();
  releases.get("10:0")(); await tick();
  assert.deepEqual([...stream.cache.keys()], ["10:0"]);
  stream.dispose();
});

test("failed chunks surface errors, back off, and recover without changing gameplay", async () => {
  const data = fixture(["0:0"]), errors = [];
  data.nodes = { road: [1, 2] };
  const nodes = data.nodes;
  let failing = true, recovered = false;
  const stream = new VisualStream(data, {
    fetcher: async () => failing ? { ok: false, status: 503 } : response("0:0"),
    onError: error => errors.push(error.message), onRecovery: () => { recovered = true; },
  });
  stream.interest("player", [1, 1, 2, 2]); await tick();
  assert.equal(errors.length, 1);
  assert.equal(stream.cache.size, 0);
  assert.equal(data.nodes, nodes);
  failing = false;
  stream.failures.set("0:0", 0);
  stream.pump(); await tick();
  assert(recovered);
  assert.equal(stream.cache.size, 1);
  stream.dispose();
});

test("overlapping visual chunks deduplicate shapes and reject mixed dataset revisions", async () => {
  const data = fixture(["0:0", "1:0"]), errors = [];
  const stream = new VisualStream(data, {
    fetcher: async () => response("0:0"), onError: error => errors.push(error.message),
  });
  stream.interest("player", [1, 1, 300, 2]); await tick();
  assert.equal(errors.length, 1);
  assert.equal(stream.cache.size, 1);
  stream.failures.set("1:0", 0);
  stream.fetcher = async () => ({ ok: true, json: async () => ({
    version: "v1", key: "1:0", backdrop: [...(await response("0:0").json()).backdrop,
      { id: 21, kind: "roof", points: [[0, 0], [1, 0], [0, 1]] }],
  }) });
  stream.pump(); await tick();
  assert.equal(stream.cache.size, 2);
  assert.deepEqual(data.backdrop.map(shape => shape.kind), ["building", "roof"]);
  stream.dispose();
});

test("progressive building groups preserve streamed elevation and dispose distant geometry", () => {
  const view = Object.create(Map3DView.prototype);
  view.data = { driving: { widths: { service: 2 } }, backdrop: [{ id: 7, kind: "building",
    points: [[0, 0], [10, 0], [10, 10], [0, 10]],
    building: { height: 30, base: 12, osm_way: 102411832 } }] };
  view.stream = { revision: 1 };
  view.camera = { x: 0, y: 0 };
  view.nodes = { a: [-5, -2], b: [15, -2] };
  view.groundMap = { roadIndex: { query: () => [{ a: "a", b: "b", kind: "service", layer: "0", tunnel: "no" }] } };
  view.scene = new THREE.Scene();
  view.cityMaterial = new THREE.MeshBasicMaterial();
  view.landmarkMaterial = new THREE.MeshBasicMaterial();
  view.advertMaterial = new THREE.MeshBasicMaterial();
  view.cityGroups = new Map();
  view.cityQueue = [];
  view.buildings = [];
  for (let i = 0; i < 10; i++) view.updateStreamedCity();
  assert.equal(view.buildingCount, 1);
  const geometry = view.buildings[0].geometry;
  geometry.computeBoundingBox();
  assert(Math.abs(geometry.boundingBox.min.y - 12.05) < .001);
  assert(Math.abs(geometry.boundingBox.max.y - 42.05) < .001);
  const advertisement = view.buildings.find(mesh => mesh.name === "city-advertisements").geometry;
  let disposed = false, advertDisposed = false;
  geometry.addEventListener("dispose", () => { disposed = true; });
  advertisement.addEventListener("dispose", () => { advertDisposed = true; });
  view.camera.x = 10000;
  view.updateStreamedCity();
  assert.equal(view.buildingCount, 0);
  assert.equal(view.buildings.length, 0);
  assert(disposed);
  assert(advertDisposed);
  view.cityMaterial.dispose();
  view.landmarkMaterial.dispose();
  view.advertMaterial.dispose();
});

test("elevated buildings and parks leave clearance below their surfaces", () => {
  const edge = { id: "road", a: "a", b: "b", kind: "service", layer: "0", tunnel: "building_passage" };
  const view = Object.assign(Object.create(Map3DView.prototype), {
    data: { driving: { widths: { service: 4 } } },
    nodes: { a: [0, 10], b: [20, 10] },
    elevation: { buildings: [], node_heights: { a: 3, b: 7 } },
    groundMap: { roadIndex: { query: () => [edge] } }, scene: new THREE.Scene(),
    cityMaterial: new THREE.MeshBasicMaterial(), landmarkMaterial: new THREE.MeshBasicMaterial(),
    advertMaterial: new THREE.MeshBasicMaterial(), parkMaterial: new THREE.MeshBasicMaterial(),
  });
  const points = [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]];
  const task = view.cityGeometry([
    { kind: "building", points, building: { base: 2, height: 18, min_height: 7 } },
    { kind: "park", points, layer: "2" },
  ]);
  let next;
  do { next = task.next(); } while (!next.done);
  const building = next.value.find(mesh => mesh.name === "building-block");
  const park = next.value.find(mesh => mesh.name === "elevated-park");
  assert(building && park);
  building.geometry.computeBoundingBox();
  park.geometry.computeBoundingBox();
  assert(Math.abs(building.geometry.boundingBox.min.y - 9.05) < .001);
  assert(Math.abs(building.geometry.boundingBox.max.y - 20.05) < .001);
  assert(park.geometry.boundingBox.min.y >= 12.199);
  for (const mesh of next.value) mesh.geometry.dispose();
  for (const material of [view.cityMaterial, view.landmarkMaterial, view.advertMaterial, view.parkMaterial]) material.dispose();
});

test("Olympian Park's raised slab clears its restored station roads", () => {
  const data = JSON.parse(readFileSync(new URL("../data/district.json", import.meta.url)));
  data.elevation = JSON.parse(readFileSync(new URL("../data/elevation.json", import.meta.url)));
  data.driving = { widths: { service: 6, residential: 6, primary: 9, secondary: 9 } };
  const park = data.backdrop.find(shape => shape.osm_way === 185084371);
  const roadIndex = new SpatialGrid(data.edges, edge => pointBounds([data.nodes[edge.a], data.nodes[edge.b]]));
  const view = Object.assign(Object.create(Map3DView.prototype), {
    data, nodes: data.nodes, elevation: data.elevation, groundMap: { roadIndex },
    scene: new THREE.Scene(), parkMaterial: new THREE.MeshBasicMaterial(), roofPostMaterial: new THREE.MeshBasicMaterial(),
  });
  const task = view.cityGeometry([park]);
  let next;
  do { next = task.next(); } while (!next.done);
  const slab = next.value.find(mesh => mesh.name === "elevated-park");
  assert(slab);
  assert(next.value.some(mesh => mesh.name === "park-pillars"));
  slab.geometry.computeBoundingBox();
  const street = data.edges.find(candidate => candidate.id === "30148986:16:1172166326");
  const streetHeight = surfacePose(view, street, { x: -699.925, y: -152.995 }, 0).height;
  assert(slab.geometry.boundingBox.min.y - streetHeight < 6.5,
    "park clearance should not be inflated by roof-contaminated terrain");
  for (const way of [185084381, 185084385, 185084426, 185084428, 185084387, 314017119]) {
    const edge = data.edges.find(candidate => candidate.way === way);
    const a = data.nodes[edge.a], b = data.nodes[edge.b];
    const height = surfacePose(view, edge, { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 }, 0).height;
    assert(slab.geometry.boundingBox.min.y - height >= 5.19, `way ${way}`);
  }
  for (const mesh of next.value) mesh.geometry.dispose();
  view.parkMaterial.dispose();
  view.roofPostMaterial.dispose();
});

test("Central Park side roads produce ground-road geometry", () => {
  const data = JSON.parse(readFileSync(new URL("../data/district.json", import.meta.url)));
  data.elevation = JSON.parse(readFileSync(new URL("../data/elevation.json", import.meta.url)));
  data.driving = { widths: { service: 6 } };
  const edges = [1365726722, 101515908].map(way => data.edges.find(edge => edge.way === way));
  assert(edges.every(Boolean));
  const view = Object.assign(Object.create(Map3DView.prototype), {
    nodes: data.nodes, data, elevation: data.elevation,
    groundMap: { unique: edges, collisionLines: { all: () => [] } },
    camera: { x: 0, y: 0 }, stream: null, resources: [], structures: [], asphaltTexture: new THREE.Texture(),
    addRoadTile(tile) { this.tiles.push(tile); }, tiles: [], scene: { add() {} },
  });
  const task = view.roadSurfaceGeometry();
  while (!task.next().done) {}
  const ranges = view.tiles.flatMap(tile => tile.roadRanges?.deck ?? []);
  for (const edge of edges) assert(ranges.some(range => range.edge.id === edge.id), edge.id);
  for (const resource of view.resources) resource.dispose();
  view.asphaltTexture.dispose();
});

test("elevated park perimeter supports avoid roads and meet the slab", () => {
  const edge = { id: "road", a: "a", b: "b", kind: "service", layer: "0", tunnel: "no" };
  const park = { kind: "park", layer: "2", points: [[0, 0], [40, 0], [40, 30], [0, 30], [0, 0]] };
  const view = Object.assign(Object.create(Map3DView.prototype), {
    data: { backdrop: [park], driving: { widths: { service: 6 } } },
    nodes: { a: [-5, 15], b: [45, 15] },
    elevation: { buildings: [], node_heights: { a: 0, b: 0 } },
    groundMap: { roadIndex: { query: () => [edge] } }, scene: new THREE.Scene(),
    parkMaterial: new THREE.MeshBasicMaterial(), roofPostMaterial: new THREE.MeshBasicMaterial(),
  });
  const task = view.cityGeometry([park]);
  let next;
  do { next = task.next(); } while (!next.done);
  const slab = next.value.find(mesh => mesh.name === "elevated-park");
  const posts = next.value.find(mesh => mesh.name === "park-pillars");
  assert(slab && posts);
  slab.geometry.computeBoundingBox();
  const positions = posts.geometry.getAttribute("position");
  assert(positions.count >= 36);
  for (let first = 0; first < positions.count; first += 36) {
    const box = new THREE.Box3();
    for (let i = first; i < first + 36; i++)
      box.expandByPoint(new THREE.Vector3(positions.getX(i), positions.getY(i), positions.getZ(i)));
    assert(box.min.z > 18 || box.max.z < 12, "pillar intersects the road");
    assert(Math.abs(box.max.y - slab.geometry.boundingBox.min.y) < .001);
  }
  for (const mesh of next.value) mesh.geometry.dispose();
  view.parkMaterial.dispose();
  view.roofPostMaterial.dispose();
});

test("an elevated park opens for a lower road layer without raising the entire slab", () => {
  const edges = [
    { id: "lower", a: "a", b: "b", kind: "service", layer: "1", bridge: "yes", tunnel: "no" },
    { id: "same", a: "c", b: "d", kind: "service", layer: "2", bridge: "yes", tunnel: "no" },
  ];
  const park = { kind: "park", layer: "2", points: [[0, 0], [40, 0], [40, 30], [0, 30], [0, 0]] };
  const view = Object.assign(Object.create(Map3DView.prototype), {
    data: { backdrop: [park], driving: { widths: { service: 6 } } },
    nodes: { a: [-5, 10], b: [45, 10], c: [-5, 20], d: [45, 20] },
    elevation: { buildings: [], node_heights: { a: 6, b: 6, c: 20, d: 20 } },
    groundMap: { roadIndex: { query: () => edges } }, scene: new THREE.Scene(),
    parkMaterial: new THREE.MeshBasicMaterial(), roofPostMaterial: new THREE.MeshBasicMaterial(),
  });
  const task = view.cityGeometry([park]);
  let next;
  do { next = task.next(); } while (!next.done);
  const slab = next.value.find(mesh => mesh.name === "elevated-park");
  slab.geometry.computeBoundingBox();
  assert(Math.abs(slab.geometry.boundingBox.min.y - 5.2) < .001);
  slab.updateMatrixWorld();
  const ray = new THREE.Raycaster(new THREE.Vector3(20, 10, 10), new THREE.Vector3(0, -1, 0), 0, 10);
  assert.equal(ray.intersectObject(slab).length, 0);
  ray.ray.origin.z = 20;
  assert(ray.intersectObject(slab).length > 0);
  for (const mesh of next.value) mesh.geometry.dispose();
  view.parkMaterial.dispose();
  view.roofPostMaterial.dispose();
});

test("a raised low podium opens beneath the overlapping elevated park", () => {
  const park = { kind: "park", layer: "2", points: [[0, 0], [40, 0], [40, 30], [0, 30], [0, 0]] };
  const building = { kind: "building", points: [[0, 0], [60, 0], [60, 30], [0, 30], [0, 0]],
    building: { base: 0, height: 4, building_layer: "2" } };
  const view = Object.assign(Object.create(Map3DView.prototype), {
    data: { backdrop: [park, building], driving: { widths: {} } }, nodes: {},
    elevation: { buildings: [] }, groundMap: { roadIndex: { query: () => [] } }, scene: new THREE.Scene(),
    cityMaterial: new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
    landmarkMaterial: new THREE.MeshBasicMaterial(), advertMaterial: new THREE.MeshBasicMaterial(),
  });
  const task = view.cityGeometry([building]);
  let next;
  do { next = task.next(); } while (!next.done);
  const mesh = next.value.find(item => item.name === "building-block");
  mesh.updateMatrixWorld();
  const ray = new THREE.Raycaster(new THREE.Vector3(20, 2, 15), new THREE.Vector3(0, -1, 0), 0, 3);
  assert.equal(ray.intersectObject(mesh).length, 0);
  ray.ray.origin.x = 50;
  assert(ray.intersectObject(mesh).length > 0);
  for (const item of next.value) item.geometry.dispose();
  for (const material of [view.cityMaterial, view.landmarkMaterial, view.advertMaterial]) material.dispose();
});

test("streaming a park later rebuilds its overlapping podium", () => {
  const building = { id: 1, kind: "building", points: [[0, 0], [160, 0], [160, 30], [0, 30], [0, 0]],
    building: { base: 0, height: 4, building_layer: "2" } };
  const park = { id: 2, kind: "park", layer: "2", points: [[0, 0], [40, 0], [40, 30], [0, 30], [0, 0]] };
  const view = Object.assign(Object.create(Map3DView.prototype), {
    data: { backdrop: [building], driving: { widths: {} } }, nodes: {}, elevation: { buildings: [] },
    stream: { revision: 1 }, camera: { x: 0, y: 0 }, cityGroups: new Map(), cityQueue: [], buildings: [],
    groundMap: { roadIndex: { query: () => [] } }, scene: new THREE.Scene(),
    cityMaterial: new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
    landmarkMaterial: new THREE.MeshBasicMaterial(), advertMaterial: new THREE.MeshBasicMaterial(),
    parkMaterial: new THREE.MeshBasicMaterial(), roofPostMaterial: new THREE.MeshBasicMaterial(),
  });
  const hit = () => {
    const mesh = view.buildings.find(item => item.name === "building-block");
    mesh.updateMatrixWorld();
    return new THREE.Raycaster(new THREE.Vector3(20, 2, 15), new THREE.Vector3(0, -1, 0), 0, 3)
      .intersectObject(mesh).length;
  };
  for (let i = 0; i < 10; i++) view.updateStreamedCity();
  assert(hit() > 0);
  view.data.backdrop.push(park);
  view.stream.revision++;
  for (let i = 0; i < 20; i++) view.updateStreamedCity();
  assert.equal(hit(), 0);
  for (const mesh of view.buildings) mesh.geometry.dispose();
  for (const material of [view.cityMaterial, view.landmarkMaterial, view.advertMaterial,
    view.parkMaterial, view.roofPostMaterial]) material.dispose();
});

test("ground-level building passages do not acquire a tunnel shell", () => {
  const edges = [
    { id: "passage", a: "a", b: "b", way: 1, kind: "service", layer: "0", tunnel: "building_passage" },
    { id: "tunnel", a: "c", b: "d", way: 2, kind: "service", layer: "-1", tunnel: "yes" },
  ];
  const view = Object.assign(Object.create(Map3DView.prototype), {
    nodes: { a: [0, 0], b: [20, 0], c: [0, 30], d: [20, 30] },
    data: { bounds: [-10, -10, 30, 40], driving: { widths: { service: 4 } } },
    elevation: { node_heights: { a: 0, b: 0, c: -6, d: -6 }, pilot: { triangles: [] } },
    groundMap: { unique: edges, collisionLines: { all: () => [] } },
    camera: { x: 0, y: 0 }, stream: null, resources: [], structures: [], asphaltTexture: new THREE.Texture(),
    addRoadTile(tile) { this.tiles.push(tile); }, tiles: [], scene: { add() {} },
  });
  Object.assign(view.data, { nodes: view.nodes, edges, elevation: view.elevation });
  const task = view.roadSurfaceGeometry();
  while (!task.next().done) {}
  const ranges = view.tiles.flatMap(tile => tile.roadRanges?.shell ?? []);
  assert(ranges.some(range => range.edge.id === "tunnel"));
  assert(!ranges.some(range => range.edge.id === "passage"));
  for (const resource of view.resources) resource.dispose();
  view.asphaltTexture.dispose();
});

test("mapped covered roads create an opening in an otherwise solid building", () => {
  const edge = { id: "road", a: "a", b: "b", kind: "service", layer: "0", covered: "yes" };
  const view = Object.assign(Object.create(Map3DView.prototype), {
    data: { driving: { widths: { service: 4 } } }, nodes: { a: [-5, 10], b: [25, 10] },
    elevation: { buildings: [], node_heights: { a: 0, b: 0 } },
    groundMap: { roadIndex: { query: () => [edge] } }, scene: new THREE.Scene(),
    cityMaterial: new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
    landmarkMaterial: new THREE.MeshBasicMaterial(), advertMaterial: new THREE.MeshBasicMaterial(),
  });
  const points = [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]];
  const task = view.cityGeometry([{ kind: "building", points, building: { base: 0, height: 18 } }]);
  let next;
  do { next = task.next(); } while (!next.done);
  const building = next.value.find(mesh => mesh.name === "building-block");
  building.updateMatrixWorld();
  const ray = new THREE.Raycaster(new THREE.Vector3(10, 3, 10), new THREE.Vector3(0, -1, 0), 0, 4);
  assert.equal(ray.intersectObject(building).length, 0);
  ray.ray.direction.set(0, 1, 0);
  assert(ray.intersectObject(building).length > 0);
  ray.ray.direction.set(0, -1, 0);
  ray.ray.origin.z = 4;
  assert(ray.intersectObject(building).length > 0);
  for (const mesh of next.value) mesh.geometry.dispose();
  edge.covered = "no";
  const solidTask = view.cityGeometry([{ kind: "building", points, building: { base: 0, height: 18 } }]);
  do { next = solidTask.next(); } while (!next.done);
  const solid = next.value.find(mesh => mesh.name === "building-block");
  solid.updateMatrixWorld();
  ray.ray.origin.z = 10;
  assert.equal(ray.intersectObject(solid).length, 0);
  for (const mesh of next.value) mesh.geometry.dispose();
  for (const material of [view.cityMaterial, view.landmarkMaterial, view.advertMaterial]) material.dispose();
});

test("a raised building opens above a lower road layer but not a same-layer road", () => {
  const edge = { id: "road", a: "a", b: "b", kind: "service", layer: "1", bridge: "yes", tunnel: "no" };
  const view = Object.assign(Object.create(Map3DView.prototype), {
    data: { driving: { widths: { service: 4 } } }, nodes: { a: [-5, 10], b: [25, 10] },
    elevation: { buildings: [], node_heights: { a: 6, b: 6 } },
    groundMap: { roadIndex: { query: () => [edge] } }, scene: new THREE.Scene(),
    cityMaterial: new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
    landmarkMaterial: new THREE.MeshBasicMaterial(), advertMaterial: new THREE.MeshBasicMaterial(),
  });
  const building = { kind: "building", points: [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]],
    building: { base: 0, height: 20, building_layer: "2" } };
  const hit = () => {
    const task = view.cityGeometry([building]);
    let next;
    do { next = task.next(); } while (!next.done);
    const mesh = next.value.find(item => item.name === "building-block");
    mesh.updateMatrixWorld();
    const result = new THREE.Raycaster(new THREE.Vector3(10, 9, 10), new THREE.Vector3(0, -1, 0), 0, 10)
      .intersectObject(mesh).length;
    for (const item of next.value) item.geometry.dispose();
    return result;
  };
  assert.equal(hit(), 0);
  edge.layer = "2";
  assert(hit() > 0);
  for (const material of [view.cityMaterial, view.landmarkMaterial, view.advertMaterial]) material.dispose();
});

test("a real building passage stays open through its mapped building", () => {
  const data = JSON.parse(readFileSync(new URL("../data/district.json", import.meta.url)));
  data.elevation = JSON.parse(readFileSync(new URL("../data/elevation.json", import.meta.url)));
  data.driving = { widths: { service: 6, residential: 6, primary: 9, secondary: 9 } };
  const metadata = data.elevation.buildings.find(item => item.osm_way === 1415166820);
  const edge = data.edges.find(item => item.id === "198861996:0:2089428244");
  assert.equal(edge.tunnel, "building_passage");
  const a = data.nodes[edge.a], b = data.nodes[edge.b];
  const point = { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 };
  const roadIndex = new SpatialGrid(data.edges, item => pointBounds([data.nodes[item.a], data.nodes[item.b]], 24));
  const view = Object.assign(Object.create(Map3DView.prototype), {
    data, nodes: data.nodes, elevation: data.elevation, groundMap: { roadIndex }, scene: new THREE.Scene(),
    cityMaterial: new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
    landmarkMaterial: new THREE.MeshBasicMaterial(), advertMaterial: new THREE.MeshBasicMaterial(),
  });
  const task = view.cityGeometry([{ ...data.backdrop[metadata.index], building: metadata }]);
  let next;
  do { next = task.next(); } while (!next.done);
  const building = next.value.find(mesh => mesh.name === "building-block");
  building.updateMatrixWorld();
  const height = surfacePose(view, edge, point, 0).height;
  const ray = new THREE.Raycaster(new THREE.Vector3(point.x, height + 3, point.y), new THREE.Vector3(0, -1, 0), 0, 4);
  assert.equal(ray.intersectObject(building).length, 0);
  for (const mesh of next.value) mesh.geometry.dispose();
  for (const material of [view.cityMaterial, view.landmarkMaterial, view.advertMaterial]) material.dispose();
});

test("streamed roofs have curved transparent covers and pillars clear of the flyover", () => {
  const view = Object.assign(Object.create(Map3DView.prototype), {
    data: { backdrop: [{ id: 8, kind: "roof", points: [[0, 0], [30, 0], [30, 12], [0, 12], [0, 0]] }] },
    nodes: { a: [-10, 6], b: [40, 6] },
    elevation: { node_heights: { a: 10, b: 10 } },
    groundMap: { roadIndex: { query: () => [{ id: "ab", a: "a", b: "b", width: 7, bridge: "yes" }] } },
    stream: { revision: 1 }, camera: { x: 0, y: 0 },
    scene: new THREE.Scene(), cityGroups: new Map(), cityQueue: [], buildings: [],
    roofMaterial: new THREE.MeshBasicMaterial({ transparent: true, opacity: .48 }),
    roofPostMaterial: new THREE.MeshBasicMaterial(),
  });
  for (let i = 0; i < 10; i++) view.updateStreamedCity();
  assert.equal(view.buildingCount, 0);
  const [pillars, canopy] = view.buildings;
  assert.equal(canopy.name, "canopy-cover");
  assert(canopy.material.transparent && canopy.material.opacity < 1);
  const cover = canopy.geometry.getAttribute("position");
  const heights = Array.from({ length: cover.count }, (_, i) => cover.getY(i));
  assert(Math.min(...heights) >= 15.19, "eaves clear the elevated road");
  assert(Math.max(...heights) - Math.min(...heights) > 1, "cover has a raised center");
  const posts = pillars.geometry.getAttribute("position");
  assert.equal(posts.count / 36, 6);
  for (let i = 0; i < posts.count; i++) assert(Math.abs(posts.getZ(i) - 6) > 3.5);
  const edgeOnlyCover = [];
  view.buildCanopy([[0, 8], [30, 8], [30, 12], [0, 12]], edgeOnlyCover, []);
  assert(Math.min(...edgeOnlyCover.filter((_, i) => i % 3 === 1)) >= 15.19,
    "eaves clear a flyover even when only its edge overlaps the canopy");
  let disposed = false;
  canopy.geometry.addEventListener("dispose", () => { disposed = true; });
  view.camera.x = 10000;
  view.updateStreamedCity();
  assert(disposed);
  view.roofMaterial.dispose();
  view.roofPostMaterial.dispose();
});

test("each shop sign is either wall-mounted or projecting, with a wall fallback", () => {
  const view = Object.create(Map3DView.prototype);
  view.data = { driving: { widths: { primary: 9 } } };
  view.elevation = { buildings: [] };
  view.nodes = { a: [-100, 0], b: [100, 0] };
  const road = { a: "a", b: "b", kind: "primary", width: 9 };
  view.groundMap = { roadIndex: { query: () => [road] } };
  view.scene = new THREE.Scene();
  view.cityMaterial = new THREE.MeshBasicMaterial();
  view.advertMaterial = new THREE.MeshBasicMaterial();
  const sign = (left, bottom) => {
    const footprint = { kind: "building", building: { height: 15, base: 0 },
      points: [[left, bottom], [left + 15, bottom], [left + 15, bottom + 8], [left, bottom + 8]] };
    const task = view.cityGeometry([footprint]);
    let next;
    do { next = task.next(); } while (!next.done);
    const meshes = next.value;
    const geometry = meshes.find(mesh => mesh.name === "city-advertisements").geometry;
    const positions = Array.from(geometry.getAttribute("position").array);
    const uvs = Array.from(geometry.getAttribute("uv").array);
    for (const mesh of meshes) { view.scene.remove(mesh); mesh.geometry.dispose(); }
    return { positions, uvs };
  };
  const projecting = sign(10, 8);
  const wall = sign(13, 8);
  const restricted = sign(12, 6);
  assert.equal(projecting.positions.length / 3, 12, "one double-sided projecting sign");
  assert.notEqual(projecting.uvs[0], projecting.uvs[12], "reverse face remains readable");
  assert.equal(wall.positions.length / 3, 6, "random wall placement produces one sign");
  assert.equal(restricted.positions.length / 3, 6, "insufficient clearance falls back to one wall sign");
  assert.deepEqual(sign(10, 8), projecting, "placement remains stable across rebuilds");
  view.cityMaterial.dispose();
  view.advertMaterial.dispose();
});

test("OSM building types tint apartment, commercial, and industrial facades differently", () => {
  const colorFor = building_type => {
    const view = Object.assign(Object.create(Map3DView.prototype), {
      data: { driving: { widths: {} } }, elevation: { buildings: [] },
      groundMap: { roadIndex: { query: () => [] } }, scene: new THREE.Scene(),
      cityMaterial: new THREE.MeshBasicMaterial(), landmarkMaterial: new THREE.MeshBasicMaterial(),
      advertMaterial: new THREE.MeshBasicMaterial(),
    });
    const task = view.cityGeometry([{ kind: "building", building: { height: 24, building_type },
      points: [[0, 0], [10, 0], [10, 10], [0, 10]] }]);
    let next;
    do { next = task.next(); } while (!next.done);
    const mesh = next.value.find(item => item.name === "building-block");
    const color = Array.from(mesh.geometry.getAttribute("color").array.slice(0, 3));
    for (const item of next.value) { view.scene.remove(item); item.geometry.dispose(); }
    view.cityMaterial.dispose(); view.landmarkMaterial.dispose(); view.advertMaterial.dispose();
    return color;
  };
  assert.notDeepEqual(colorFor("apartments"), colorFor("commercial"));
  assert.notDeepEqual(colorFor("commercial"), colorFor("industrial"));
});

test("clipped road junctions preserve continuous height across different grades", () => {
  const nodes = { a: [-30, 0], b: [0, 0], c: [30, 0], d: [0, 30] };
  const edges = [["a", "b"], ["b", "d"]].map(([a, b]) => ({
    id: a + b, a, b, way: a + b, name: "Local road", kind: "service", width: 4,
    bridge: "no", tunnel: "no", layer: "0", oneway: true,
  }));
  const view = Object.assign(Object.create(Map3DView.prototype), {
    nodes, data: { driving: { widths: { service: 4 } } },
    elevation: { node_heights: { a: 5, b: 5, c: 5, d: 8 },
      road_profiles: {}, road_junctions: {}, pilot: { triangles: [] } },
    groundMap: { unique: edges, collisionLines: { all: () => [] } },
    camera: { x: 0, y: 0 }, stream: null, resources: [], structures: [],
    scene: new THREE.Scene(), sceneSize: new THREE.Vector2(100, 100), asphaltTexture: null,
    *curbMarkings() { return []; },
  });
  Object.assign(view.data, { nodes, edges, elevation: view.elevation });
  const task = view.roadSurfaceGeometry();
  while (!task.next().done) {}
  const decks = view.structures.map(({ mesh }) => mesh).filter(mesh =>
    mesh.name === "level-separated-solid-road-decks" || mesh.name === "continuous-shared-node-road-joints");
  const height = (x, z) => {
    const ray = new THREE.Raycaster(new THREE.Vector3(x, 100, z), new THREE.Vector3(0, -1, 0), 0, 200);
    const hit = ray.intersectObjects(decks)[0];
    assert(hit, `road surface is missing at ${x}, ${z}`);
    return hit.point.y;
  };
  for (const z of [.2, .6, 1, 1.4, 1.8])
    assert(Math.abs(height(-.001, z) - height(.001, z)) < .01, "junction edges must meet without a vertical step");
  for (const x of [-1.8, -1.4, -.6, .001, .6, 1.4, 1.8]) {
    const before = height(x, 1.999), after = height(x, 2.001);
    assert(Math.abs(before - after) < .01, `clipped sections must meet continuously: ${before}, ${after}`);
  }
  for (const geometry of new Set(decks.map(mesh => mesh.geometry))) geometry.dispose();
  for (const resource of view.resources) resource.dispose();
});

test("road clipping combines same-level crossings but preserves different heights", () => {
  const nodes = { a: [-30, 0], b: [30, 0], c: [0, -30], d: [0, 30] };
  const edges = [["a", "b"], ["c", "d"]].map(([a, b]) => ({
    id: a + b, a, b, way: a + b, name: "Local road", kind: "service", width: 4,
    bridge: "no", tunnel: "no", layer: "0", oneway: true,
  }));
  for (const upper of [0, 6]) {
    const view = Object.assign(Object.create(Map3DView.prototype), {
      nodes, data: { driving: { widths: { service: 4 } } },
      elevation: { node_heights: { a: 0, b: 0, c: upper, d: upper },
        road_profiles: {}, road_junctions: {}, pilot: { triangles: [] } },
      groundMap: { unique: edges, collisionLines: { all: () => [] } },
      camera: { x: 0, y: 0 }, stream: null, resources: [], structures: [],
      scene: new THREE.Scene(), sceneSize: new THREE.Vector2(100, 100), asphaltTexture: null,
      *curbMarkings() { return []; },
    });
    Object.assign(view.data, { nodes, edges, elevation: view.elevation });
    const task = view.roadSurfaceGeometry();
    while (!task.next().done) {}
    const decks = view.structures.map(({ mesh }) => mesh).filter(mesh => mesh.name === "level-separated-solid-road-decks");
    const ray = new THREE.Raycaster(new THREE.Vector3(.3, 100, .4), new THREE.Vector3(0, -1, 0), 0, 200);
    const heights = ray.intersectObjects(decks).map(hit => hit.point.y).sort((a, b) => a - b);
    assert.equal(heights.length, upper ? 2 : 1);
    assert(Math.abs(heights[0] - .08) < 1e-5);
    if (upper) assert(Math.abs(heights[1] - 6.08) < 1e-5);
    for (const geometry of new Set(decks.map(mesh => mesh.geometry))) geometry.dispose();
    for (const resource of view.resources) resource.dispose();
  }
});

test("overlapping connected ramps remain separate as their heights diverge", () => {
  const nodes = { a: [-30, 0], b: [0, 0], c: [-30, 0] };
  const edges = [["a", "b"], ["b", "c"]].map(([a, b]) => ({
    id: a + b, a, b, way: a + b, name: "Local road", kind: "service", width: 4,
    bridge: "yes", tunnel: "no", layer: "1", oneway: true,
  }));
  const view = Object.assign(Object.create(Map3DView.prototype), {
    nodes, data: { driving: { widths: { service: 4 } } },
    elevation: { node_heights: { a: 6, b: 0, c: 0 }, node_quality: { a: 1, b: 1, c: 1 },
      road_profiles: {}, road_junctions: {}, pilot: { triangles: [] } },
    groundMap: { unique: edges, collisionLines: { all: () => [] } },
    camera: { x: 0, y: 0 }, stream: null, resources: [], structures: [],
    scene: new THREE.Scene(), sceneSize: new THREE.Vector2(100, 100), asphaltTexture: null,
    *curbMarkings() { return []; },
  });
  Object.assign(view.data, { nodes, edges, elevation: view.elevation });
  const task = view.roadSurfaceGeometry();
  while (!task.next().done) {}
  const decks = view.structures.map(({ mesh }) => mesh).filter(mesh => mesh.name === "level-separated-solid-road-decks");
  const ray = new THREE.Raycaster(new THREE.Vector3(-15, 100, .4), new THREE.Vector3(0, -1, 0), 0, 200);
  const heights = ray.intersectObjects(decks).map(hit => hit.point.y).sort((a, b) => a - b);
  assert.equal(heights.length, 2);
  assert(Math.abs(heights[0] - .08) < 1e-5);
  assert(Math.abs(heights[1] - 3.08) < 1e-5);
  for (const geometry of new Set(decks.map(mesh => mesh.geometry))) geometry.dispose();
  for (const resource of view.resources) resource.dispose();
});

test("3D road surfaces and tunnel shells blocking the taxi become transparent", () => {
  const previousDocument = globalThis.document;
  const previousWidth = globalThis.innerWidth, previousHeight = globalThis.innerHeight;
  globalThis.document = { timeline: { currentTime: 1000 } };
  globalThis.innerWidth = 1280; globalThis.innerHeight = 720;
  try {
    const view = Object.assign(Object.create(Map3DView.prototype), {
      camera: { x: 0, y: 0 }, cameraSmoothness: 1, chaseDistanceScale: 1, zoom: 1.65,
      data: { mapLabels: [{
        kind: "block", name: "Tower 1", zh: "1座", point: [0, 0],
        polygon: [[-5, -1], [5, -1], [5, 1], [-5, 1]],
      }] },
      mapLabelIndex: new SpatialGrid([{
        kind: "block", name: "Tower 1", zh: "1座", point: [0, 0],
        polygon: [[-5, -1], [5, -1], [5, 1], [-5, 1]],
      }], label => pointBounds(label.polygon)),
      edges: new Map([["road", { id: "road", a: "a", b: "b", name: "Local road", zh: "支路", tunnel: "yes" }]]),
      nodes: { a: [-4, 0], b: [4, 0] }, elevation: {},
      scene: new THREE.Scene(), lens: new THREE.PerspectiveCamera(), resources: [], structures: [],
      cameraReady: true, cameraHeading: 0, cameraRotationSpeed: .9, orbitYaw: 0,
      orbitPitch: Math.atan2(.6, .9), lastRender: 900, frameTimes: [], asphaltTexture: new THREE.Texture(),
      ground: { material: {} }, terrainTiles: [], boundaryOutline: { children: [] }, directionLines: {},
      taxi: new THREE.Object3D(), buildings: [], roadLabel: {}, updateStreamedCity() {},
      updateGroundDetail() {}, updateSkids() {}, drawScene() {},
    });
    view.scene.fog = { near: 0, far: 0 };
    view.lens.position.set(-43.2, 20, 0);
    const plane = (height, left, right) => [
      left, height, -5, right, height, -5, right, height, 5,
      left, height, -5, right, height, 5, left, height, 5,
    ];
    view.addRoadTile({ shell: [...plane(2.4, -3.5, -2.5), ...plane(-20, -90, -80)],
      deck: plane(1.9, -2.4, -1.5), elevatedDeck: plane(1.6, -5, -.8),
      markings: plane(1.92, -2.4, -1.5) });
    view.addRoadTile({ deck: plane(.08, -20, 0) });
    const shell = view.scene.children.find(mesh => mesh.name === "bridge-and-tunnel-shells");
    const [deck, elevatedDeck, markings, road] = view.scene.children.filter(mesh => mesh !== shell);
    view.render({ x: 0, y: 0, heading: 0, edge: "road" }, null, "en", null);
    assert.equal(view.roadLabel.textContent, "Tower 1");
    assert.equal(shell.material.opacity, 0.12, "tunnel shell blocks the camera");
    assert.equal(deck.material.opacity, 0.12, "road deck blocks the camera");
    assert.equal(elevatedDeck.material.opacity, 0.12, "flyover deck blocks the camera");
    assert.equal(markings.material.opacity, 0.12, "road markings block the camera");
    assert.equal(road.material.opacity, 1, "the road underneath the taxi stays opaque");
    view.overview = true;
    view.data = { bounds: [-100, -100, 100, 100] };
    view.render({ x: 0, y: 0, heading: 0, edge: "road" }, null, "en", null);
    for (const mesh of [shell, deck, elevatedDeck, markings, road]) {
      assert.equal(mesh.material.opacity, 1, "overview restores road surfaces");
    }
    view.overview = false;
    view.cameraReady = false;
    view.render({ x: 100, y: 0, heading: 0, edge: "road" }, null, "en", null);
    for (const mesh of [shell, deck, elevatedDeck, markings, road]) {
      assert.equal(mesh.material.opacity, 1, "unobstructed surfaces return to normal");
    }
    view.edges.get("road").tunnel = "no";
    view.lens.position.set(-43.2, 10, 0);
    view.lookAt = new THREE.Vector3(10, 1, 0);
    view.cameraReady = true;
    view.lastRender = 900;
    view.render({ x: 0, y: 0, heading: 0, edge: "road" }, null, "en", null);
    assert.equal(elevatedDeck.material.opacity, .12, "flyover also fades outside a tunnel");
    assert.equal(road.material.opacity, 1, "the current road remains opaque outside a tunnel");
  } finally {
    globalThis.document = previousDocument;
    globalThis.innerWidth = previousWidth; globalThis.innerHeight = previousHeight;
  }
});
