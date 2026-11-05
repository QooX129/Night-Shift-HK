import { test, expect } from "@playwright/test";

test("citizen screen eligibility ignores occlusion but excludes overview, distant and offscreen people", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=local-map-popup-1");
    const THREE = await import("/vendor/three/three.module.min.js");
    const lens = new THREE.PerspectiveCamera(48, 1, .3, 5000);
    lens.position.set(0, 20, 30);
    lens.lookAt(0, 0, 0);
    const view = Object.assign(Object.create(Map3DView.prototype), {
      lens, overview: false, edges: new Map([["road", { a: "a", b: "b" }]]),
      nodes: { a: [-100, 0], b: [100, 0] }, scene: new THREE.Scene(),
    });
    const blocker = new THREE.Mesh(new THREE.BoxGeometry(10, 30, 10));
    blocker.position.set(0, 10, 10);
    view.scene.add(blocker);
    const person = (id, x, y) => ({
      id, point: [x, y], edge: "road", hailing: false,
      motion: { points: [[x, y], [x + 1, y]], distance: 0, direction: 1, speed: 1, seeking_curb: false },
    });
    const state = { elapsed: 0, citizens_at: 0, phase: "available",
      citizens: [person("occluded", 0, 0), person("behind", 0, 60),
        person("offscreen", 70, 0), person("distant", 0, -90)] };
    const car = { x: 0, y: 0 };
    const visible = view.visibleCitizens(state, car);
    const entering = person("entering", 70, 0);
    entering.motion = { ...entering.motion, points: [[70, 0], [0, 0]], speed: 10 };
    const predicted = view.visibleCitizens({ ...state, elapsed: 7, citizens: [entering] }, car);
    view.overview = true;
    const overview = view.visibleCitizens(state, car);
    view.overview = false;
    const onboard = view.visibleCitizens({ ...state, phase: "onboard" }, car);
    const boarding = view.visibleCitizens({ ...state, boarding: {} }, car);
    blocker.geometry.dispose(); blocker.material.dispose();
    return { visible, predicted, overview, onboard, boarding };
  });
  expect(result.visible).toEqual(["occluded"]);
  expect(result.predicted).toEqual(["entering"]);
  expect(result.overview).toEqual([]);
  expect(result.onboard).toEqual([]);
  expect(result.boarding).toEqual([]);
});

test("3D walking moves continuously, alternates limbs and eases a reversal", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=local-map-popup-1");
    const THREE = await import("/vendor/three/three.module.min.js");
    const view = Object.assign(Object.create(Map3DView.prototype), {
      data: { driving: { taxi_width: 1.7 } }, scene: new THREE.Scene(),
      taxi: new THREE.Group(), resources: [], stops: [], edges: new Map(),
    });
    view.buildCitizens();
    const citizen = { id: "walker", point: [0, 0], hailing: false,
      motion: { points: [[0, 0], [1, 0]], distance: 0, direction: 1, speed: 1, seeking_curb: false } };
    const state = { citizens: [citizen], citizens_at: 0, elapsed: 0 };
    const sample = elapsed => {
      view.updateCitizens({ ...state, elapsed }, {});
      const item = view.people[0];
      return { x: item.group.position.x, facing: item.heading,
        arms: [item.arm.rotation.z, item.otherArm.rotation.z], legs: item.legs.map(leg => leg.rotation.z) };
    };
    sample(0);
    const a = sample(.25), b = sample(.2666666667);
    sample(.99);
    const before = sample(1), after = sample(1.0166666667), later = sample(1.1);
    const sameMesh = view.people.length === 1;
    for (const resource of view.resources) resource.dispose();
    view.door.geometry.dispose(); view.door.material.dispose();
    return { a, b, before, after, later, sameMesh };
  });
  expect(result.b.x - result.a.x).toBeCloseTo(1 / 60, 6);
  expect(result.a.arms[0]).toBeCloseTo(-result.a.arms[1]);
  expect(result.a.legs[0]).toBeCloseTo(-result.a.legs[1]);
  expect(result.a.arms[0]).toBeCloseTo(-result.a.legs[1]);
  expect(Math.abs(result.a.arms[0])).toBeGreaterThan(.1);
  expect(Math.abs(result.after.facing - result.before.facing)).toBeLessThan(.6);
  expect(Math.abs(result.later.facing)).toBeGreaterThan(Math.abs(result.after.facing));
  expect(result.sameMesh).toBe(true);
});

test("hailing bubbles follow citizens, switch language and disappear after hailing", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=local-map-popup-1");
    const { MapView } = await import("/map.mjs?v=taxi-map-icons-1");
    const { HAIL_BUBBLE } = await import("/citizens.mjs?v=local-map-popup-1");
    const THREE = await import("/vendor/three/three.module.min.js");
    const view = Object.assign(Object.create(Map3DView.prototype), {
      data: { driving: {} }, scene: new THREE.Scene(), taxi: new THREE.Group(), resources: [],
    });
    view.buildCitizens();
    const citizen = { id: "hail", point: [10, 7], hailing: true };
    const state = { citizens: [citizen], elapsed: 0 };
    view.updateCitizens(state, {}, "en");
    const item = view.people[0], material = item.bubble.material;
    const visible = item.bubble.visible && item.bubble.parent === view.bubbleScene
      && item.group.position.x === 10 && item.bubble.position.y > 2;
    const anchored = item.bubble.position.x === item.group.position.x
      && item.bubble.position.z === item.group.position.z
      && item.bubble.center.x === (HAIL_BUBBLE.x + HAIL_BUBBLE.width / 2) / HAIL_BUBBLE.canvasWidth
      && item.bubble.center.y === 1 - (HAIL_BUBBLE.y + HAIL_BUBBLE.height
        + HAIL_BUBBLE.tailHeight) / HAIL_BUBBLE.canvasHeight;
    view.updateCitizens(state, {}, "zh");
    const localized = item.bubble.material === view.hailBubbles.zh && material !== item.bubble.material;
    view.updateCitizens({ ...state, citizens: [{ ...citizen, hailing: false }] }, {}, "zh");
    const hidden = !item.bubble.visible;
    view.overview = true;
    view.updateCitizens(state, {}, "en");
    const overviewHidden = !item.bubble.visible;
    view.overview = false;
    view.updateCitizens({ ...state, citizens: [], customer: [10, 7] }, {}, "en");
    const customerHidden = !item.bubble.visible;
    view.updateCitizens({ ...state, citizens: [] }, {}, "en");
    const removed = !item.group.visible && !item.bubble.visible;
    const data = { nodes: {}, edges: [], backdrop: [], bounds: [-100, -100, 100, 100],
      driving: {} };
    const calls = [];
    for (const compact of [false, true]) {
      const map = new MapView(document.createElement("canvas"), data, [], { compact });
      map.ctx.fillText = text => {
        const transform = map.ctx.getTransform();
        const tip = new DOMPoint(HAIL_BUBBLE.x + HAIL_BUBBLE.width / 2,
          HAIL_BUBBLE.y + HAIL_BUBBLE.height + HAIL_BUBBLE.tailHeight).matrixTransform(transform);
        calls.push({ text, compact, error: Math.hypot(
          tip.x - (map.width / 2 + (10 - map.camera.x) * map.zoom) * map.ratio,
          tip.y - (map.height * .61 + (7 - map.camera.y) * map.zoom - 5) * map.ratio) });
      };
      map.render({ x: 0, y: 0, heading: 0 }, { ...state, closed: [], traffic: {} }, "en");
      map.render({ x: 0, y: 0, heading: 0 }, { ...state, closed: [], traffic: {} }, "zh");
    }
    for (const resource of view.resources) resource.dispose();
    view.door.geometry.dispose(); view.door.material.dispose();
    return { visible, anchored, localized, hidden, overviewHidden, customerHidden, removed,
      bubbles: calls.filter(call => ["Taxi!", "的士！"].includes(call.text)) };
  });
  for (const key of ["visible", "anchored", "localized", "hidden", "overviewHidden", "customerHidden", "removed"])
    expect(result[key]).toBe(true);
  expect(result.bubbles.map(({ text, compact }) => ({ text, compact })))
    .toEqual([{ text: "Taxi!", compact: false }, { text: "的士！", compact: false }]);
  for (const bubble of result.bubbles) expect(bubble.error).toBeLessThan(.01);
});

test("hailing bubbles render over red boundary lines in the final native-resolution pass", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=local-map-popup-1");
    const THREE = await import("/vendor/three/three.module.min.js");
    const renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true });
    renderer.setSize(128, 128);
    const lens = new THREE.OrthographicCamera(-8, 8, 8, -8, .1, 100);
    lens.position.set(10, 2.3, 17); lens.lookAt(10, 2.3, 7);
    const view = Object.assign(Object.create(Map3DView.prototype), {
      data: { driving: {} }, scene: new THREE.Scene(), taxi: new THREE.Group(), resources: [],
      renderer, lens, sceneTarget: new THREE.WebGLRenderTarget(128, 128),
      outputScene: new THREE.Scene(), outputCamera: lens, boundaryScene: new THREE.Scene(),
    });
    view.buildCitizens();
    const boundary = new THREE.Mesh(new THREE.PlaneGeometry(100, 100),
      new THREE.MeshBasicMaterial({ color: "#ff0000", depthTest: false }));
    boundary.position.set(10, 2.3, 8);
    view.boundaryScene.add(boundary);
    const read = () => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 128;
      const context = canvas.getContext("2d");
      context.drawImage(renderer.domElement, 0, 0);
      return [...context.getImageData(64, 52, 1, 1).data];
    };
    view.updateCitizens({ citizens: [{ id: "hail", point: [10, 7], hailing: true }], elapsed: 0 }, {}, "en");
    view.bubbleScene.visible = false;
    view.drawScene();
    const red = read();
    view.bubbleScene.visible = true;
    view.drawScene();
    const bubble = read();
    view.updateCitizens({ citizens: [], elapsed: 1 }, {}, "en");
    view.drawScene();
    const cleared = read();
    boundary.geometry.dispose(); boundary.material.dispose();
    for (const resource of view.resources) resource.dispose();
    view.door.geometry.dispose(); view.door.material.dispose();
    view.sceneTarget.dispose(); renderer.dispose(); renderer.forceContextLoss();
    return { red, bubble, cleared };
  });
  expect(result.red[0]).toBeGreaterThan(240);
  expect(result.red[1]).toBeLessThan(5);
  expect(result.bubble[1]).toBeGreaterThan(20);
  expect(result.cleared).toEqual(result.red);
});
