import { test, expect } from "@playwright/test";

test("sloped GPS subdivisions do not fade across internal joins", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=parabolic-steering-1");
    const THREE = await import("/vendor/three/three.module.min.js");
    const view = Object.assign(Object.create(Map3DView.prototype), {
      nodes: { a: [0, 0], b: [20, 0], c: [40, 0] },
      elevation: { node_heights: { a: 0, b: 4, c: 4 },
        road_profiles: { ab: [0, 0], bc: [0, 0] } },
    });
    const edges = [{ id: "ab", a: "a", b: "b", way: 1 },
      { id: "bc", a: "b", b: "c", way: 1 }];
    const geometry = view.ribbonGeometry(edges, .8, .22);
    try {
      const positions = geometry.getAttribute("position"), coverage = geometry.getAttribute("boundaryCoord");
      let seams = 0, sides = 0;
      for (let i = 0; i < positions.count; i += 3) {
        for (let j = 0; j < 3; j++) {
          const a = i + (j + 1) % 3, b = i + (j + 2) % 3;
          if (coverage.array[a * 3 + j] !== 0 || coverage.array[b * 3 + j] !== 0) continue;
          const x = positions.getX(a);
          if (Math.abs(x - positions.getX(b)) < 1e-6 && x > .01 && x < 39.99
              && Math.abs(positions.getZ(a) - positions.getZ(b)) > .7) seams++;
          if (Math.abs(positions.getZ(a) - positions.getZ(b)) < 1e-6) sides++;
        }
      }
      const renderer = new THREE.WebGLRenderer();
      const target = new THREE.WebGLRenderTarget(420, 80);
      const material = new THREE.ShaderMaterial({
        vertexShader: `attribute vec3 boundaryCoord; varying vec3 coverage;
          void main() { coverage = boundaryCoord; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `varying vec3 coverage;
          void main() { vec3 c = smoothstep(vec3(0.0), max(fwidth(coverage), vec3(0.00001)), coverage);
          gl_FragColor = vec4(vec3(min(c.x, min(c.y, c.z))), 1.0); }`,
        side: THREE.DoubleSide,
      });
      try {
        const scene = new THREE.Scene();
        scene.add(new THREE.Mesh(geometry, material));
        const camera = new THREE.OrthographicCamera(-21, 21, 4, -4, .1, 200);
        camera.position.set(20, 100, 0);
        camera.up.set(0, 0, -1);
        camera.lookAt(20, 0, 0);
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
        const pixels = new Uint8Array(420 * 4);
        renderer.readRenderTargetPixels(target, 0, 40, 420, 1, pixels);
        const minimumCentreCoverage = Math.min(...Array.from({ length: 380 }, (_, i) => pixels[(i + 20) * 4]));
        return { seams, sides, vertices: positions.count, minimumCentreCoverage };
      } finally {
        material.dispose();
        target.dispose();
        renderer.dispose();
        renderer.forceContextLoss();
      }
    } finally { geometry.dispose(); }
  });
  expect(result.vertices).toBeGreaterThan(100);
  expect(result.seams).toBe(0);
  expect(result.sides).toBeGreaterThan(0);
  expect(result.minimumCentreCoverage).toBeGreaterThan(245);
});

test("straight GPS sections share a strip without duplicate internal round caps", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=parabolic-steering-1");
    const nodes = { a: [0, 0], b: [10, 0], c: [20, 0], d: [30, 0] };
    const edges = [["a", "b"], ["b", "c"], ["c", "d"]].map(([a, b], i) => ({
      id: String(i), a, b, way: 1, width: 6, layer: "0", bridge: "no", tunnel: "no",
    }));
    const view = Object.assign(Object.create(Map3DView.prototype), {
      nodes, data: { nodes }, elevation: { node_heights: { a: 0, b: 0, c: 0, d: 0 } },
    });
    const joined = view.ribbonGeometry(edges, .8, .22);
    const singles = edges.map(edge => view.ribbonGeometry([edge], .8, .22));
    const positions = joined.getAttribute("position");
    const result = {
      joinedVertices: positions.count,
      separateVertices: singles.reduce((sum, geometry) => sum + geometry.getAttribute("position").count, 0),
      edgeStarts: joined.userData.edgeStarts,
      heightCorrect: Array.from({ length: positions.count }, (_, i) => positions.getY(i))
        .every(height => Math.abs(height - .3) < 1e-6),
    };
    for (const geometry of [joined, ...singles]) geometry.dispose();
    return result;
  });
  expect(result.joinedVertices).toBeLessThan(result.separateVertices * .5);
  expect(result.edgeStarts).toHaveLength(3);
  expect(result.edgeStarts[1]).toBeGreaterThan(0);
  expect(result.edgeStarts[2]).toBeGreaterThan(result.edgeStarts[1]);
  expect(result.heightCorrect).toBe(true);
});

test("main-road decks own the whole junction surface without side-road penetration", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=parabolic-steering-1");
    const THREE = await import("/vendor/three/three.module.min.js");
    const edges = [
      { id: "ab", a: "a", b: "b", kind: "primary", width: 16, bridge: "no", tunnel: "no" },
      { id: "bc", a: "b", b: "c", kind: "primary", width: 16, bridge: "no", tunnel: "no" },
      { id: "bd", a: "b", b: "d", kind: "residential", width: 8, bridge: "no", tunnel: "no" },
    ];
    const elevation = { node_heights: { a: 0, b: 5, c: 10, d: 15 },
      road_profiles: { ab: [.05, .05], bc: [.05, .05], bd: [0, .1] },
      road_junctions: { bd: [
        { id: "ab", node: "b", a: "a", b: "b", profile: [.05, .05], radius: 8, priority: 4 },
        { id: "bc", node: "b", a: "b", b: "c", profile: [.05, .05], radius: 8, priority: 4 },
      ] }, pilot: {} };
    const view = Object.assign(Object.create(Map3DView.prototype), {
      nodes: { a: [-100, 0], b: [0, 0], c: [100, 0], d: [0, 100] },
      elevation, data: { driving: { widths: {} } }, groundMap: { unique: edges },
      scene: new THREE.Scene(), resources: [],
    });
    view.buildRoadSurfaces();
    view.scene.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(), samples = [];
    for (const x of [-3, -1, 0, 1, 3]) for (const y of [.5, 2, 4, 6, 7.5]) {
      ray.set(new THREE.Vector3(x, 100, y), new THREE.Vector3(0, -1, 0));
      const hits = ray.intersectObjects(view.scene.children).filter(hit =>
        hit.object.name === "level-separated-solid-road-decks"
        || hit.object.name === "continuous-shared-node-road-joints");
      samples.push({ count: hits.length, error: Math.max(...hits.map(hit =>
        Math.abs(hit.point.y - (5 + .05 * x + .08)))) });
    }
    view.scene.traverse(object => { object.geometry?.dispose(); object.material?.dispose(); });
    return samples;
  });
  expect(result.every(sample => sample.count >= 2)).toBe(true);
  expect(Math.max(...result.map(sample => sample.error))).toBeLessThan(.005);
});

test("first passenger routes build in the worker without blocking launch or applying stale replies", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=parabolic-steering-1");
    const { RoadNetwork, stepCar } = await import("/physics.mjs?v=parabolic-steering-1");
    const data = await (await fetch("/api/map")).json();
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const view = new Map3DView(canvas, data, []);
    try {
      const ids = data.edges.slice(0, 100).map(edge => edge.id);
      const pickup = { closed: [], traffic: {}, route: ids, phase: "pickup" };
      const onboard = { ...pickup, route: [...ids].reverse(), phase: "onboard" };
      const times = [];
      const update = state => {
        const start = performance.now();
        view.updateOverlays(state, null, null);
        times.push(performance.now() - start);
      };
      const reply = request => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Route worker reply timed out")), 10000);
        const listener = ({ data }) => {
          if (data.type !== "route" || data.request !== request) return;
          clearTimeout(timeout);
          view.detailWorker.removeEventListener("message", listener);
          resolve();
        };
        view.detailWorker.addEventListener("message", listener);
      });
      view.ribbonGeometry = () => { throw new Error("GPS geometry must not build on the main thread"); };
      update(pickup);
      const pickupRequest = view.pendingRoute.request;
      update(onboard);
      const onboardRequest = view.pendingRoute.request;
      const arrived = reply(onboardRequest);
      const roads = new RoadNetwork(data);
      const edge = data.edges.find(edge => edge.length > 100 && !edge.wrongway);
      const a = data.nodes[edge.a], b = data.nodes[edge.b];
      const car = { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2,
        speed: 0, heading: roads.angle(edge), edge: edge.id };
      const launchTimes = [];
      for (let frame = 0; frame < 12; frame++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const start = performance.now();
        stepCar(car, { gas: true }, 1 / 60, { roads });
        update(onboard);
        launchTimes.push(performance.now() - start);
      }
      await arrived;
      update(onboard);
      const layer = view.overlayLayers.get("route");
      const geometry = layer.mesh.geometry;
      const reference = Map3DView.prototype.ribbonGeometry.call(view, onboard.route.map(id => view.edges.get(id)), .8, .22);
      const identical = Object.keys(reference.attributes).every(name =>
        reference.attributes[name].array.every((value, i) => value === geometry.attributes[name].array[i]));
      const startsMatch = JSON.stringify(reference.userData.edgeStarts) === JSON.stringify(geometry.userData.edgeStarts);
      reference.dispose();
      const correctPhase = layer.color === "#f3c047" && layer.ids[0] === onboard.route[0];
      update({ ...onboard, route: null });
      update(onboard);
      const movingRequest = view.pendingRoute.request;
      const movingReply = reply(movingRequest);
      const shortened = { ...onboard, route: onboard.route.slice(3) };
      update(shortened);
      const reusedPending = view.pendingRoute.request === movingRequest;
      await movingReply;
      update({ ...onboard, route: onboard.route.slice(6) });
      const movingLayer = view.overlayLayers.get("route");
      const followsMovingRoute = movingLayer?.mesh.geometry.drawRange.start
        === movingLayer?.mesh.geometry.userData.edgeStarts[6];
      const visibleMovingRoute = movingLayer?.mesh.geometry.drawRange.count > 0;
      update(pickup);
      const retained = view.overlayLayers.get("route") === movingLayer;
      const cancelledRequest = view.pendingRoute.request;
      update({ ...onboard, route: null });
      await reply(cancelledRequest);
      update({ ...onboard, route: null });
      return { maxUpdateMs: Math.max(...times), identical, startsMatch, correctPhase, retained,
        launched: car.speed > 0 && Math.hypot(car.x - (a[0] + b[0]) / 2, car.y - (a[1] + b[1]) / 2) > 0,
        maxLaunchMs: Math.max(...launchTimes),
        reusedPending, followsMovingRoute, visibleMovingRoute,
        superseded: onboardRequest > pickupRequest, cleared: !view.overlayLayers.has("route") && !view.readyRoute };
    } finally {
      view.dispose();
      view.renderer.forceContextLoss();
      canvas.remove();
    }
  });
  console.log(`First-route main-thread timing ${JSON.stringify(result)}`);
  expect(result.maxUpdateMs).toBeLessThan(16.7);
  expect(result.maxLaunchMs).toBeLessThan(16.7);
  expect(result.launched).toBe(true);
  expect(result.identical && result.startsMatch && result.correctPhase).toBe(true);
  expect(result.retained && result.superseded && result.cleared).toBe(true);
  expect(result.reusedPending && result.followsMovingRoute && result.visibleMovingRoute).toBe(true);
});

test("rerouted guides reuse sampled roads without changing attributes or partial starts", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=parabolic-steering-1");
    const view = Object.assign(Object.create(Map3DView.prototype), {
      nodes: { a: [0, 0], b: [20, 0], c: [40, 0] },
      elevation: { node_heights: { a: 0, b: 2, c: 2 }, road_profiles: { ab: [0, 0], bc: [0, 0] } },
    });
    const edges = [{ id: "ab", a: "a", b: "b" }, { id: "bc", a: "b", b: "c" }];
    const initial = view.ribbonGeometry(edges, .8, .22);
    initial.dispose();
    const round = view.roundLineGeometry;
    let builds = 0;
    view.roundLineGeometry = function (...args) { builds++; return round.apply(this, args); };
    const variant = view.ribbonGeometry([...edges].reverse(), .8, .22);
    variant.dispose();
    const variantBuilds = builds;
    const rerouted = view.ribbonGeometry([...edges].reverse(), .8, .22);
    const reused = builds === variantBuilds;
    const reference = Object.assign(Object.create(Map3DView.prototype), {
      nodes: view.nodes, elevation: view.elevation,
    }).ribbonGeometry([...edges].reverse(), .8, .22);
    const sameAttributes = Object.keys(reference.attributes).every(name =>
      reference.attributes[name].array.every((value, i) => value === rerouted.attributes[name].array[i]));
    const sameStarts = JSON.stringify(reference.userData.edgeStarts) === JSON.stringify(rerouted.userData.edgeStarts);
    const partial = view.ribbonGeometry(edges, .8, .22, { x: 10, y: 0 });
    const nextPartial = view.ribbonGeometry(edges, .8, .22, { x: 15, y: 0 });
    const firstX = partial.getAttribute("position").getX(0), nextX = nextPartial.getAttribute("position").getX(0);
    const partialBuilds = builds;
    const differentWidth = view.ribbonGeometry(edges, 2, .22);
    const widthRebuilt = builds > partialBuilds;
    const differentHeight = view.ribbonGeometry(edges, .8, .3);
    const heightChanged = Math.abs(differentHeight.getAttribute("position").getY(0)
      - initial.getAttribute("position").getY(0) - .08) < .00001;
    for (const geometry of [rerouted, reference, partial, nextPartial, differentWidth, differentHeight]) geometry.dispose();
    return { reused, sameAttributes, sameStarts, partialBuilds, firstX, nextX, widthRebuilt, heightChanged };
  });
  expect(result.reused && result.sameAttributes && result.sameStarts).toBe(true);
  expect(result.partialBuilds).toBeGreaterThan(0);
  expect(result.nextX - result.firstX).toBeGreaterThan(4);
  expect(result.widthRebuilt && result.heightChanged).toBe(true);
});

test("curved road decks, guides, taxi pose and speed physics share the vertical profile", async ({ page }) => {
  await page.goto("/");
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const result = await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=parabolic-steering-1");
    const { RoadNetwork } = await import("/physics.mjs?v=parabolic-steering-1");
    const { surfacePose } = await import("/elevation.mjs?v=parabolic-steering-1");
    const data = {
      bounds: [-20, -40, 320, 40], backdrop: [],
      nodes: { a: [0, 0], b: [100, 0], c: [200, 0], d: [300, 0] },
      edges: [["ab", "a", "b"], ["bc", "b", "c"], ["cd", "c", "d"]].map(([id, a, b]) => ({
        id, a, b, way: 1, kind: "residential", width: 6, length: 100,
        name: "Smooth ramp", layer: "0", bridge: "no", tunnel: "no",
      })),
      driving: { taxi_length: 4.7, taxi_width: 1.7, widths: { residential: 6 }, max_speed: 40 },
      elevation: {
        node_heights: { a: 0, b: 0, c: 10, d: 10 },
        road_profiles: { ab: [0, 0], bc: [0, 0], cd: [0, 0] }, pilot: {}, buildings: [],
        terrain: { origin: [-20, -40], spacing: 340, width: 2, height: 2, values: [-1, -1, -1, -1] },
      },
    };
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const view = new Map3DView(canvas, data, []);
    const roads = new RoadNetwork(data);
    const ramp = view.edges.get("bc");
    const height = x => surfacePose(view, ramp, { x, y: 0 }, 0).height;
    try {
      const positions = view.scene.getObjectByName("level-separated-solid-road-decks").geometry.getAttribute("position");
      let vertexError = 0, midpointError = 0, rampTriangles = 0;
      for (let i = 0; i < positions.count; i += 3) {
        const xs = [i, i + 1, i + 2].map(j => positions.getX(j));
        if (Math.min(...xs) < 100 || Math.max(...xs) > 200) continue;
        rampTriangles++;
        for (let j = i; j < i + 3; j++) vertexError = Math.max(vertexError,
          Math.abs(positions.getY(j) - height(positions.getX(j)) - .08));
        midpointError = Math.max(midpointError,
          Math.abs((positions.getY(i) + positions.getY(i + 1) + positions.getY(i + 2)) / 3
            - height(xs.reduce((a, b) => a + b) / 3) - .08));
      }
      const guide = view.ribbonGeometry([ramp], .8, .22);
      const guidePositions = guide.getAttribute("position");
      let guideError = 0;
      for (let i = 0; i < guidePositions.count; i++) guideError = Math.max(guideError,
        Math.abs(guidePositions.getY(i) - height(guidePositions.getX(i)) - .3));
      guide.dispose();
      const car = { x: 125, y: 0, heading: 0, edge: "bc", speed: 0 };
      view.render(car, null, "en", null);
      const pose = surfacePose(roads, roads.edges.get("bc"), car, car.heading);
      const geometry = view.scene.getObjectByName("level-separated-solid-road-decks").geometry;
      for (let i = 0; i < 3; i++) view.render(car, null, "en", null);
      return { vertexError, midpointError, rampTriangles, guideError,
        taxiHeight: view.taxi.position.y, taxiPitch: view.taxi.rotation.z, pose,
        geometryReused: geometry === view.scene.getObjectByName("level-separated-solid-road-decks").geometry };
    } finally {
      view.dispose();
      view.renderer.forceContextLoss();
      canvas.remove();
    }
  });
  expect(result.rampTriangles).toBe(100);
  expect(result.vertexError).toBeLessThan(.00001);
  expect(result.midpointError).toBeLessThan(.003);
  expect(result.guideError).toBeLessThan(.00001);
  expect(result.taxiHeight).toBeCloseTo(1.5625 + .08, 6);
  expect(result.taxiPitch).toBeCloseTo(Math.atan(.1125), 6);
  expect(result.pose.grade).toBe(.1125);
  expect(result.geometryReused).toBe(true);
  expect(errors).toEqual([]);
});
