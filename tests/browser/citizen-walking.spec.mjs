import { test, expect } from "@playwright/test";

test("citizen screen eligibility ignores occlusion but excludes overview, distant and offscreen people", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=citizen-motion-2");
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
    const { Map3DView } = await import("/map3d.mjs?v=citizen-motion-2");
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
