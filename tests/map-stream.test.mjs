import assert from "node:assert/strict";
import test from "node:test";
import { VisualStream, VISUAL_CHUNK_CACHE_LIMIT } from "../web/map-stream.mjs";
import { SpatialGrid, pointBounds } from "../web/spatial-grid.mjs";
import { Map3DView } from "../web/map3d.mjs";
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

test("spatial queries deduplicate crossing objects and omit distant objects", () => {
  const near = { points: [[-5, -5], [270, 10]] }, far = { points: [[10000, 10000], [10010, 10010]] };
  const grid = new SpatialGrid([near, far], shape => pointBounds(shape.points));
  assert.deepEqual(grid.query([-10, -10, 300, 20]), [near]);
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
    version: "v1", key: "1:0", backdrop: (await response("0:0").json()).backdrop,
  }) });
  stream.pump(); await tick();
  assert.equal(stream.cache.size, 2);
  assert.equal(data.backdrop.length, 1);
  stream.dispose();
});

test("progressive building groups preserve streamed elevation and dispose distant geometry", () => {
  const view = Object.create(Map3DView.prototype);
  view.data = { backdrop: [{ id: 7, kind: "building",
    points: [[0, 0], [10, 0], [10, 10], [0, 10]], building: { height: 30, base: 12 } }] };
  view.stream = { revision: 1 };
  view.camera = { x: 0, y: 0 };
  view.scene = new THREE.Scene();
  view.cityMaterial = new THREE.MeshBasicMaterial();
  view.cityGroups = new Map();
  view.cityQueue = [];
  view.buildings = [];
  for (let i = 0; i < 10; i++) view.updateStreamedCity();
  assert.equal(view.buildingCount, 1);
  const geometry = view.buildings[0].geometry;
  geometry.computeBoundingBox();
  assert(Math.abs(geometry.boundingBox.min.y - 12.05) < .001);
  assert(Math.abs(geometry.boundingBox.max.y - 42.05) < .001);
  let disposed = false;
  geometry.addEventListener("dispose", () => { disposed = true; });
  view.camera.x = 10000;
  view.updateStreamedCity();
  assert.equal(view.buildingCount, 0);
  assert.equal(view.buildings.length, 0);
  assert(disposed);
  view.cityMaterial.dispose();
});

test("3D road surfaces and tunnel shells blocking the taxi become transparent", () => {
  const previousDocument = globalThis.document;
  const previousWidth = globalThis.innerWidth, previousHeight = globalThis.innerHeight;
  globalThis.document = { timeline: { currentTime: 1000 } };
  globalThis.innerWidth = 1280; globalThis.innerHeight = 720;
  try {
    const view = Object.assign(Object.create(Map3DView.prototype), {
      camera: { x: 0, y: 0 }, cameraSmoothness: 1, chaseDistanceScale: 1, zoom: 1.65,
      edges: new Map([["road", { id: "road", tunnel: "yes" }]]), elevation: {},
      scene: new THREE.Scene(), lens: new THREE.PerspectiveCamera(), resources: [], structures: [],
      cameraReady: true, cameraHeading: 0, lastRender: 900, frameTimes: [],
      ground: { material: {} }, terrainTiles: [], boundaryOutline: { children: [] }, directionLines: {},
      taxi: new THREE.Object3D(), buildings: [], roadLabel: {}, updateStreamedCity() {},
      updateGroundDetail() {}, drawScene() {},
    });
    view.scene.fog = { near: 0, far: 0 };
    view.lens.position.set(-43.2, 20, 0);
    const plane = (height, left, right) => [
      left, height, -5, right, height, -5, right, height, 5,
      left, height, -5, right, height, 5, left, height, 5,
    ];
    view.addRoadTile({ shell: [...plane(5.08, -16, -8), ...plane(-20, -90, -80)],
      deck: plane(7, -23, -14), elevatedDeck: plane(9, -28, -20),
      markings: plane(7.04, -23, -14) });
    view.addRoadTile({ deck: plane(.08, -20, 0) });
    const shell = view.scene.children.find(mesh => mesh.name === "bridge-and-tunnel-shells");
    const [deck, elevatedDeck, markings, road] = view.scene.children.filter(mesh => mesh !== shell);
    view.render({ x: 0, y: 0, heading: 0, edge: "road" }, null, "en", null);
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
    view.render({ x: 0, y: 0, heading: 0, edge: "road" }, null, "en", null);
    for (const mesh of [shell, deck, elevatedDeck, markings, road]) {
      assert.equal(mesh.material.opacity, 1, "unobstructed surfaces return to normal");
    }
    view.edges.get("road").tunnel = "no";
    view.lens.position.set(-43.2, 10, 0);
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
