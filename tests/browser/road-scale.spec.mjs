import { test, expect } from "@playwright/test";

test.use({ trace: "off" });

test("overlapping road joints match the road surface without visible patches", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=hk-streets-5");
    const THREE = await import("/vendor/three/three.module.min.js");
    const data = {
      bounds: [-50, -20, 50, 20], nodes: { a: [-40, 0], b: [0, 0], c: [40, 0] },
      driving: { taxi_length: 4.7, taxi_width: 1.7, widths: { residential: 10 } },
      edges: [
        { id: "one", way: 1, a: "a", b: "b", name: "Test Road", kind: "residential", width: 10, length: 40 },
        { id: "two", way: 1, a: "b", b: "c", name: "Test Road", kind: "residential", width: 10, length: 40 },
      ].map(edge => ({ ...edge, oneway: true, layer: "0", bridge: "no", tunnel: "no" })),
      backdrop: [],
      elevation: {
        node_heights: { a: 0, b: 0, c: 0 }, pilot: {}, buildings: [],
        terrain: { origin: [-50, -20], spacing: 100, width: 2, height: 2, values: [-1, -1, -1, -1] },
      },
    };
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const view = new Map3DView(canvas, data, []);
    const target = new THREE.WebGLRenderTarget(64, 64);
    try {
      const scene = new THREE.Scene();
      const roads = view.scene.children.filter(mesh => mesh.name === "level-separated-solid-road-decks");
      const joints = view.scene.children.filter(mesh => mesh.name === "continuous-shared-node-road-joints");
      for (const mesh of [...roads, ...joints]) scene.add(mesh.clone());
      const camera = new THREE.OrthographicCamera(-4, 4, 4, -4, 0.1, 100);
      camera.position.set(0, 20, 0);
      camera.up.set(0, 0, -1);
      camera.lookAt(0, 0, 0);
      const render = () => {
        view.renderer.setRenderTarget(target);
        view.renderer.render(scene, camera);
        const pixels = new Uint8Array(64 * 64 * 4);
        view.renderer.readRenderTargetPixels(target, 0, 0, 64, 64, pixels);
        return pixels;
      };
      const withJoints = render();
      for (const mesh of scene.children) if (mesh.name === "continuous-shared-node-road-joints") mesh.visible = false;
      const withoutJoints = render();
      let different = 0;
      for (let y = 24; y < 40; y++) for (let x = 24; x < 40; x++) {
        const i = (y * 64 + x) * 4;
        if (withJoints[i] !== withoutJoints[i] || withJoints[i + 1] !== withoutJoints[i + 1]
            || withJoints[i + 2] !== withoutJoints[i + 2]) different++;
      }
      return different;
    } finally {
      view.renderer.setRenderTarget(null);
      target.dispose();
      view.dispose();
      view.renderer.forceContextLoss();
      canvas.remove();
    }
  });
  expect(result).toBe(0);
});

test("street details extend beyond Nathan Road and stop at junction openings", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=hk-streets-5");
    const data = {
      bounds: [-20, -40, 100, 50],
      nodes: { a: [0, 0], b: [40, 0], c: [40, 30], d: [40, -30] },
      driving: { taxi_length: 4.7, taxi_width: 1.7, widths: { primary: 9, residential: 6 } },
      edges: [
        { id: "nathan", way: 1, a: "a", b: "b", name: "Nathan Road", kind: "primary", width: 9, length: 40 },
        { id: "cross", way: 2, a: "b", b: "c", name: "Cross Street", kind: "residential", width: 6, length: 30 },
        { id: "other", way: 2, a: "d", b: "b", name: "Cross Street", kind: "residential", width: 6, length: 30 },
      ].map(edge => ({ ...edge, oneway: true, layer: "0", bridge: "no", tunnel: "no" })),
      backdrop: [{ kind: "building", points: [[10, 8], [25, 8], [25, 16], [10, 16]] }],
      elevation: {
        node_heights: { a: 0, b: 0, c: 0, d: 0 }, pilot: {},
        buildings: [{ index: 0, height: 15, base: 0 }],
        terrain: { origin: [-20, -40], spacing: 120, width: 2, height: 2, values: [-1, -1, -1, -1] },
      },
    };
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const view = new Map3DView(canvas, data, []);
    try {
      let nathanCrossing = false, crossStreetLines = false;
      for (const mesh of view.scene.children.filter(mesh => mesh.userData.streetRanges?.yellow)) {
        const p = mesh.geometry.getAttribute("position");
        const [start, count] = mesh.userData.streetRanges.yellow;
        for (let i = start; i < start + count; i += 6) {
          if (Math.abs(p.getY(i) - .12) > .001) continue;
          const x = [p.getX(i), p.getX(i + 2)], z = [p.getZ(i), p.getZ(i + 2)];
          if (Math.abs(x[1] - x[0]) > Math.abs(z[1] - z[0])
              && Math.max(...x) > 37.05 && Math.min(...x) < 40 && Math.abs(z[0]) < 5) nathanCrossing = true;
          if (Math.abs(z[1] - z[0]) > Math.abs(x[1] - x[0])
              && Math.abs(x[0] - 40) < 3.1 && Math.min(...z) < 12 && Math.max(...z) > 12) crossStreetLines = true;
        }
      }
      const adverts = view.scene.children.filter(mesh => mesh.name === "city-advertisements");
      const p = adverts[0]?.geometry.getAttribute("position");
      const uv = adverts[0]?.geometry.getAttribute("uv");
      const depth = p ? Math.max(...Array.from({ length: p.count }, (_, i) => p.getZ(i)))
        - Math.min(...Array.from({ length: p.count }, (_, i) => p.getZ(i))) : 0;
      const boxes = view.scene.children.filter(mesh => mesh.name === "yellow-box-markings");
      return { nathanCrossing, crossStreetLines, depth, boxes: boxes.length,
        readableBack: p?.count === 12 && uv.getX(0) !== uv.getX(6) };
    } finally { view.dispose(); view.renderer.forceContextLoss(); canvas.remove(); }
  });
  expect.soft(result.nathanCrossing).toBe(false);
  expect.soft(result.crossStreetLines).toBe(true);
  expect.soft(result.depth).toBeGreaterThan(1);
  expect.soft(result.readableBack).toBe(true);
  expect.soft(result.boxes).toBe(0);
});

test("the verified Nathan Road and Argyle Street junction has a yellow box", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=hk-streets-5");
    const { project } = await import("/physics.mjs?v=tunnel-clearance-1");
    const data = await (await fetch("/api/map?stream=true")).json();
    const center = data.nodes["1151084860"];
    data.edges = data.edges.filter(edge => [edge.a, edge.b].some(node =>
      Math.hypot(data.nodes[node][0] - center[0], data.nodes[node][1] - center[1]) < 45));
    data.bounds = [center[0] - 100, center[1] - 100, center[0] + 100, center[1] + 100];
    data.backdrop = [];
    delete data.visualChunks;
    delete data.overview;
    data.elevation = { ...data.elevation, buildings: [], pilot: {},
      terrain: { origin: [center[0] - 100, center[1] - 100], spacing: 200,
        width: 2, height: 2, values: [-10, -10, -10, -10] } };
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const view = new Map3DView(canvas, data, []);
    try {
      const boxes = view.scene.children.filter(mesh => mesh.name === "yellow-box-markings");
      const boxInfo = boxes.map(mesh => {
        const bounds = mesh.geometry.boundingBox;
        return { count: mesh.geometry.getAttribute("position").count,
          containsJunction: bounds.min.x < center[0] && bounds.max.x > center[0]
            && bounds.min.z < center[1] && bounds.max.z > center[1] };
      });
      const intersects = (point, name) => data.edges.some(edge => edge.name === name
        && project(point, data.nodes[edge.a], data.nodes[edge.b]).distance < edge.width / 2 - .2);
      let curbInJunction = false;
      for (const mesh of view.scene.children.filter(mesh => mesh.userData.streetRanges?.yellow)) {
        const p = mesh.geometry.getAttribute("position");
        const [start, count] = mesh.userData.streetRanges.yellow;
        for (let i = start; i < start + count; i += 6) for (let step = 0; step <= 10; step++) {
          const t = step / 10;
          const point = { x: p.getX(i) * (1 - t) + p.getX(i + 2) * t,
            y: p.getZ(i) * (1 - t) + p.getZ(i + 2) * t };
          if (Math.hypot(point.x - center[0], point.y - center[1]) < 30
              && intersects(point, "Nathan Road") && intersects(point, "Argyle Street")) curbInJunction = true;
        }
      }
      return { boxes: boxInfo, curbInJunction };
    } finally { view.dispose(); view.renderer.forceContextLoss(); canvas.remove(); }
  });
  expect(result.boxes).toHaveLength(1);
  expect(result.boxes[0].count).toBeGreaterThan(0);
  expect(result.boxes[0].containsJunction).toBe(true);
  expect(result.curbInJunction).toBe(false);
});

test("Hong Kong street details follow nearby buildings and ground-level Nathan Road junctions", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=hk-streets-5");
    const data = {
      bounds: [-20, -20, 220, 140],
      nodes: { a: [0, 0], b: [40, 0], c: [40, 20], d: [-1, 0] },
      driving: { taxi_length: 4.7, taxi_width: 1.7, widths: { primary: 9, residential: 6 } },
      edges: [
        { id: "nathan", way: 1, a: "a", b: "b", name: "Nathan Road", kind: "primary", width: 9, length: 40 },
        { id: "cross", way: 2, a: "b", b: "c", name: "Cross Street", kind: "residential", width: 6, length: 20 },
        { id: "short", way: 1, a: "d", b: "a", name: "Nathan Road", kind: "primary", width: 9, length: 1 },
      ].map(edge => ({ ...edge, oneway: true, layer: "0", bridge: "no", tunnel: "no" })),
      backdrop: [
        { kind: "building", points: [[10, 7], [25, 7], [25, 15], [10, 15]] },
        { kind: "building", points: [[180, 90], [200, 90], [200, 110], [180, 110]] },
      ],
      elevation: {
        node_heights: { a: 0, b: 0, c: 0, d: 0 }, pilot: {},
        buildings: [{ index: 0, osm_way: 102411832, height: 15, base: 0 }, { index: 1, height: 15, base: 0 }],
        terrain: { origin: [-20, -20], spacing: 240, width: 2, height: 2, values: [-1, -1, -1, -1] },
      },
    };
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const view = new Map3DView(canvas, data, []);
    try {
      const adverts = view.scene.children.filter(mesh => mesh.name === "city-advertisements");
      const advert = adverts[0].geometry.getAttribute("position");
      const uv = adverts[0].geometry.getAttribute("uv");
      const details = view.scene.children.filter(mesh => mesh.userData.streetRanges);
      const white = view.scene.children.find(mesh => mesh.material?.color?.getHexString() === "c2d0bf");
      const positions = white.geometry.getAttribute("position");
      let crossingVertices = 0;
      for (let i = 0; i < positions.count; i++) {
        if (Math.abs(positions.getX(i) - 31.5) < .001 || Math.abs(positions.getX(i) - 34.5) < .001) crossingVertices++;
      }
      const deck = view.scene.getObjectByName("level-separated-solid-road-decks");
      const sidewalks = details.filter(mesh => mesh.userData.streetRanges.sidewalk);
      return {
        advertCount: adverts.length,
        advertVertices: advert.count,
        advertX: Array.from({ length: advert.count }, (_, i) => advert.getX(i)),
        landmarkUv: Array.from({ length: uv.count }, (_, i) => uv.getX(i)),
        landmarkGlass: view.buildings.some(mesh => mesh.userData.cityLandmark
          && mesh.material === view.landmarkMaterial && mesh.material.map),
        yellowVertices: details.reduce((sum, mesh) => sum + (mesh.userData.streetRanges.yellow?.[1] ?? 0), 0),
        crossingVertices,
        shortSidewalk: sidewalks.some(mesh => mesh.geometry.boundingBox.min.x <= -1),
        railing: details.some(mesh => mesh.userData.streetRanges.railing),
        signals: details.some(mesh => mesh.userData.streetRanges.signalRed),
        asphalt: Boolean(deck.material.map && deck.geometry.getAttribute("uv")),
      };
    } finally { view.dispose(); view.renderer.forceContextLoss(); canvas.remove(); }
  });
  expect(result.advertCount).toBe(1);
  expect(result.advertVertices).toBe(6);
  expect(Math.min(...result.advertX)).toBeGreaterThanOrEqual(10);
  expect(Math.max(...result.advertX)).toBeLessThanOrEqual(25);
  expect(Math.min(...result.landmarkUv)).toBeCloseTo(.8, 5);
  expect(Math.max(...result.landmarkUv)).toBeCloseTo(1, 5);
  expect(result.landmarkGlass).toBe(true);
  expect(result.yellowVertices).toBeGreaterThan(0);
  expect(result.crossingVertices).toBeGreaterThan(0);
  expect(result.shortSidewalk).toBe(true);
  expect(result.railing).toBe(true);
  expect(result.signals).toBe(true);
  expect(result.asphalt).toBe(true);
});

test("parallel carriageways retain a visible metric gap in 2D and elevated 3D", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { MapView } = await import("/map.mjs?v=parabolic-steering-1");
    const { Map3DView } = await import("/map3d.mjs?v=parabolic-steering-1");
    const { RoadNetwork } = await import("/physics.mjs?v=parabolic-steering-1");
    const data = {
      bounds: [-10, -20, 110, 30], backdrop: [
        { kind: "building", points: [[10.37, 15], [20.37, 15], [20.37, 23], [10.37, 23], [10.37, 15]] },
      ],
      nodes: { a: [0, 0], b: [100, 0], c: [0, 4.6], d: [100, 4.6] },
      driving: { taxi_length: 4.7, taxi_width: 1.7, taxi_radius: 2.5, widths: { residential: 10, primary: 16 } },
      edges: [
        { id: "narrow", way: 1, a: "a", b: "b", kind: "residential", width: 2.8 },
        { id: "main", way: 2, a: "c", b: "d", kind: "primary", width: 5.6 },
      ].map(edge => ({ ...edge, length: 100, name: "Local road", layer: "0", bridge: "no", tunnel: "no", oneway: true })),
      elevation: {
        node_heights: { a: 0, b: 0, c: 0, d: 0 }, pilot: {},
        buildings: [{ index: 0, height: 9.6, base: 0, quality: "estimated-levels-times-3.2m" }],
        terrain: { origin: [-10, -20], spacing: 120, width: 2, height: 2, values: [-1, -1, -1, -1] },
      },
    };
    const roads = new RoadNetwork(data);
    const map = new MapView(document.createElement("canvas"), data, []);
    map.drawRoadDirections = () => {};
    map.buildBackdrop(data.bounds, 20);
    const c = map.backdrop.getContext("2d");
    const pixel = y => [...c.getImageData(1200, Math.round((y + 20) * 20), 1, 1).data];
    const gapPixel = pixel(1.6), roadPixels = [pixel(0), pixel(4.6)];
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const view = new Map3DView(canvas, data, []);
    try {
    const reference = new MapView(document.createElement("canvas"), data, []);
    reference.drawCollisionLines = () => {};
    reference.drawRoadDirections = () => {};
    reference.buildBackdrop(data.bounds, 24);
    const sample = (image, x) => {
      const scale = image.width / (data.bounds[2] - data.bounds[0]);
      const coordinate = (x - data.bounds[0]) * scale - .5;
      const first = Math.floor(coordinate), fraction = coordinate - first;
      const pixels = image.getContext("2d").getImageData(first, Math.floor((18 - data.bounds[1]) * scale), 2, 1).data;
      return [0, 1, 2].map(channel => pixels[channel] * (1 - fraction) + pixels[channel + 4] * fraction);
    };
    let oldEdgeError = 0, detailedEdgeError = 0;
    for (let x = 9.5; x < 11.2; x += .025) {
      const expected = sample(reference.backdrop, x);
      const old = sample(view.overviewTexture.image, x), detailed = sample(view.chaseTexture.image, x);
      for (let channel = 0; channel < 3; channel++) {
        oldEdgeError += Math.abs(old[channel] - expected[channel]);
        detailedEdgeError += Math.abs(detailed[channel] - expected[channel]);
      }
    }
      const mesh = view.scene.getObjectByName("level-separated-solid-road-decks");
      const positions = mesh.geometry.getAttribute("position");
      const strips = [];
      for (let offset = 0; offset < positions.count; offset += 6) {
        strips.push(Array.from({ length: 6 }, (_, index) => positions.getZ(offset + index)));
      }
      const taxiBody = view.taxi.children[0].geometry.parameters;
      const THREE = await import("/vendor/three/three.module.min.js");
      const bodyBounds = new THREE.Box3();
      for (const child of view.taxi.children) {
        if (!child.visible || child.geometry.type === "PlaneGeometry") continue;
        bodyBounds.union(new THREE.Box3().setFromObject(child));
      }
      const wheel = view.taxi.getObjectByName("taxi-wheel").geometry.parameters;
      const sign = view.taxi.getObjectByName("taxi-sign").geometry.parameters;
      view.updateBoundaries({ x: 50, y: 0, edge: "narrow" });
      const boundary = view.boundaryOutline.geometry.getAttribute("position");
      let roundedCaps = true;
      for (const [index, line] of view.boundaryLines.entries()) {
        const dx = line.b[0] - line.a[0], dy = line.b[1] - line.a[1], length = Math.hypot(dx, dy);
        let beyond = 0;
        for (let i = index * 54; i < (index + 1) * 54; i++) {
          beyond = Math.max(beyond, ((boundary.getX(i) - line.b[0]) * dx
            + (boundary.getZ(i) - line.b[1]) * dy) / length);
        }
        roundedCaps &&= Math.abs(beyond - .125) < .00001;
      }
      const building = view.buildings[0].geometry;
      building.computeBoundingBox();
      const buildingBox = building.boundingBox;
      const markings = view.scene.children.find(mesh => mesh.material?.color?.getHexString() === "c2d0bf")
        .geometry.getAttribute("position");
      // The narrow road contributes one arrow triangle before the wide-road dashes.
      const dash = Array.from({ length: 6 }, (_, index) => [markings.getX(index + 3), markings.getZ(index + 3)]);
      const uv = building.getAttribute("uv"), buildingPositions = building.getAttribute("position"),
        normals = building.getAttribute("normal");
      let floorError = 0;
      for (let i = 0; i < uv.count; i++) {
        if (normals.getY(i) > .5) continue;
        floorError = Math.max(floorError, Math.abs(uv.getY(i) - (buildingPositions.getY(i) - .05) / 3.2));
      }
      return {
        gapPixel, roadPixels, strips,
        radii: data.edges.map(edge => roads.radius(edge)),
        fits: data.edges.map(edge => roads.bodyFits({ x: 50, y: edge.id === "main" ? 4.6 : 0 }, 0, edge)),
        cannotCross: roads.match({ x: 50, y: 4.6 }, 0, data.edges[0]) === null,
        taxiBody: [taxiBody.width, taxiBody.depth],
        taxiBounds: [bodyBounds.max.x - bodyBounds.min.x, bodyBounds.max.y, bodyBounds.max.z - bodyBounds.min.z],
        wheel: [wheel.radiusTop, wheel.height], sign: [sign.width, sign.height, sign.depth],
        roundedCaps, boundaryVertices: boundary.count, boundarySegments: view.boundaryLines.length,
        buildingSize: [buildingBox.max.x - buildingBox.min.x, buildingBox.max.y - buildingBox.min.y,
          buildingBox.max.z - buildingBox.min.z], floorError,
        oldEdgeError, detailedEdgeError,
        terrainSizes: [view.overviewTexture.image.width, view.chaseTexture.image.width],
        dashSize: [Math.max(...dash.map(p => p[0])) - Math.min(...dash.map(p => p[0])),
          Math.max(...dash.map(p => p[1])) - Math.min(...dash.map(p => p[1]))],
      };
    } finally { view.dispose(); view.renderer.forceContextLoss(); canvas.remove(); }
  });
  expect(result.radii).toEqual([1.4, 2.8]);
  expect(result.fits).toEqual([true, true]);
  expect(result.cannotCross).toBe(true);
  expect(result.taxiBody).toEqual([4.7, 1.7]);
  expect(result.taxiBounds[0]).toBeCloseTo(4.7, 5);
  expect(result.taxiBounds[1]).toBeCloseTo(1.62, 5);
  expect(result.taxiBounds[2]).toBeCloseTo(1.7, 5);
  expect(result.wheel).toEqual([.31, .19]);
  expect(result.sign).toEqual([.4, .12, .25]);
  expect(result.roundedCaps).toBe(true);
  expect(result.boundaryVertices).toBe(result.boundarySegments * 54);
  expect(result.buildingSize[0]).toBeCloseTo(10, 5);
  expect(result.buildingSize[1]).toBeCloseTo(9.6, 5);
  expect(result.buildingSize[2]).toBeCloseTo(8, 5);
  expect(result.floorError).toBeLessThan(.00001);
  expect(result.terrainSizes[1]).toBe(result.terrainSizes[0] * 2);
  expect(result.detailedEdgeError).toBeLessThan(result.oldEdgeError * .8);
  expect(result.dashSize[0]).toBeCloseTo(3, 5);
  expect(result.dashSize[1]).toBeCloseTo(.1, 5);
  expect(result.gapPixel.slice(0, 3)).toEqual([26, 44, 48]);
  for (const pixel of result.roadPixels) expect(pixel.slice(0, 3)).not.toEqual(result.gapPixel.slice(0, 3));
  const gap = Math.min(...result.strips[1]) - Math.max(...result.strips[0]);
  expect(gap).toBeCloseTo(.4, 5);
});

test("real Ferry and Ching Ping widths agree across renderer, browser and server", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await page.locator("#start").click();
  const result = await page.evaluate(async () => {
    const data = await (await fetch("/api/map")).json();
    const { Map3DView } = await import("/map3d.mjs?v=parabolic-steering-1");
    const { RoadNetwork, project } = await import("/physics.mjs?v=parabolic-steering-1");
    const roads = new RoadNetwork(data);
    const side = roads.edges.get("485635353:2:6505945379"), main = roads.edges.get("1067815827:9:13108528146");
    const a = data.nodes[side.a], b = data.nodes[side.b];
    const c = data.nodes[main.a], d = data.nodes[main.b], point = p => ({ x: p[0], y: p[1] });
    const spacing = Math.min(project(point(a), c, d).distance, project(point(b), c, d).distance,
      project(point(c), a, b).distance, project(point(d), a, b).distance);
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;z-index:10000";
    document.body.append(canvas);
    const view = new Map3DView(canvas, data, []);
    const car = { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2,
      heading: Math.atan2(b[1] - a[1], b[0] - a[0]), edge: side.id, speed: 0 };
    for (let i = 0; i < 3; i++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      view.render(car, null, "en", null);
    }
    window.scalePreview = view;
    return {
      spacing, gap: spacing - roads.radius(side) - roads.radius(main),
      widths: [side.width, main.width],
      audit: data.road_width_audit, taxi: [data.driving.taxi_length, data.driving.taxi_width],
      bodyFits: roads.bodyFits(car, car.heading, side),
      boundaryHeightCount: view.boundaryOutline.geometry.getAttribute("position").count,
    };
  });
  expect(result.gap).toBeGreaterThanOrEqual(.3);
  expect(result.widths[0]).toBeLessThanOrEqual(3);
  expect(result.widths[1]).toBeLessThanOrEqual(6);
  expect(result.audit.unresolved_pairs).toBe(2);
  expect(result.taxi[0]).toBeGreaterThan(result.taxi[1]);
  expect(result.taxi[1]).toBeLessThan(Math.min(...result.widths));
  expect(result.bodyFits).toBe(true);
  expect(result.boundaryHeightCount).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath("corrected-road-scale.png") });
  await page.evaluate(() => { window.scalePreview.dispose(); window.scalePreview.canvas.remove(); delete window.scalePreview; });
  console.log(`Real road scale ${JSON.stringify(result)}`);
});

test("Waterloo and Ferry junction clips internal walls at the reported overlap", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await page.locator("#start").click();
  const result = await page.evaluate(async () => {
    const data = await (await fetch("/api/map")).json();
    const { Map3DView } = await import("/map3d.mjs?v=parabolic-steering-1");
    const { project } = await import("/physics.mjs?v=parabolic-steering-1");
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;z-index:10000";
    document.body.append(canvas);
    const view = new Map3DView(canvas, data, []);
    const car = { x: -208.373119, y: 184.53314, heading: -2.95987, speed: 0,
      edge: "1299955103:0:1168380653" };
    view.render(car, null, "en", null);
    const roads = view.groundMap.collisionLines.roads;
    const key = edge => [edge.a, edge.b].sort().join(":");
    const nearby = [...new Map(view.boundaryLines.filter(({ edge }) =>
      project(car, roads.nodes[edge.a], roads.nodes[edge.b]).distance < 70)
      .map(line => [key(line.edge), line.edge])).values()];
    let internalWalls = 0;
    for (const { a, b, edge } of view.boundaryLines) {
      const point = { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 };
      if (Math.hypot(point.x - car.x, point.y - car.y) > 60) continue;
      for (const next of nearby) {
        if (key(edge) === key(next)) continue;
        if (![edge.a, edge.b].some(node => node === next.a || node === next.b)) continue;
        if (!["layer", "bridge", "tunnel"].every(tag => edge[tag] === next[tag])) continue;
        if (project(point, roads.nodes[next.a], roads.nodes[next.b]).distance < roads.radius(next) - .05)
          internalWalls++;
      }
    }
    const point = { x: -206.62623, y: 184.66240 };
    const incoming = roads.edges.get("~1299955103:0:1168380653");
    const found = roads.candidates(point, incoming).some(edge => edge.id === "706423404:0:6637957634");
    const geometry = view.boundaryOutline.geometry;
    view.render(car, null, "en", null);
    const lines = view.boundaryLines;
    const distant = data.edges.find(edge => edge.id !== car.edge
      && Math.hypot(data.nodes[edge.a][0] - car.x, data.nodes[edge.a][1] - car.y) > 500);
    const [x, y] = data.nodes[distant.a];
    view.render({ ...car, x, y, edge: distant.id }, null, "en", null);
    view.overview = true;
    view.render(car, null, "en", null);
    const staticOverview = view.boundaryOutline.visible && view.boundaryOutline.geometry === geometry
      && view.boundaryLines === lines;
    view.overview = false;
    view.cameraReady = false;
    view.render(car, null, "en", null);
    window.junctionPreview = view;
    return { internalWalls, found, cached: geometry === view.boundaryOutline.geometry,
      staticOverview, segments: view.boundaryLines.length };
  });
  expect(result.internalWalls).toBe(0);
  expect(result.found).toBe(true);
  expect(result.cached).toBe(true);
  expect(result.staticOverview).toBe(true);
  expect(result.segments).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath("junction-without-internal-walls.png") });
  await page.evaluate(() => { window.junctionPreview.dispose(); window.junctionPreview.canvas.remove(); delete window.junctionPreview; });
});
