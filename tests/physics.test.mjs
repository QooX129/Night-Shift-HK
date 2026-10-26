import test from "node:test";
import assert from "node:assert/strict";
import { stepCar, stepAssist, makeAssist, project, angleDifference } from "../web/physics.mjs";

test("accelerate and steer, then brake without reversing", () => {
  const car = { x: 0, y: 0, speed: 0, heading: 0 };
  for (let i = 0; i < 180; i++) stepCar(car, { gas: true, right: true }, 1 / 60);
  assert.ok(car.speed > 17 && car.speed <= 18);
  assert.ok(car.heading > 0);
  for (let i = 0; i < 180; i++) stepCar(car, { brake: true }, 1 / 60);
  assert.equal(car.speed, 0);
});
test("traffic and fuel constrain movement; map boundary never leaks", () => {
  const car = { x: 0, y: 0, speed: 18, heading: 0 };
  stepCar(car, { gas: true }, 1 / 60, { traffic: 0.5 });
  assert.equal(car.speed, 9);
  car.speed = 0;
  for (let i = 0; i < 60; i++) stepCar(car, { gas: true }, 1 / 60, { fuel: 0 });
  assert.equal(car.speed, 0);
  car.x = 0.9; car.speed = 18;
  assert.equal(stepCar(car, { gas: true }, 1 / 30, { bounds: [-1, -1, 1, 1] }), false);
  assert.equal(car.x, 0.9); assert.equal(car.speed, 0);
});
test("projection and heading wrap are well defined", () => {
  assert.deepEqual(project({ x: 5, y: 3 }, [0, 0], [10, 0]), { x: 5, y: 0, t: 0.5, distance: 3 });
  assert.ok(Math.abs(angleDifference(-Math.PI + 0.1, Math.PI - 0.1) - 0.2) < 1e-10);
});
test("turn assist follows connected geometry, respects brake, and completes on exit", () => {
  const nodes = { a: [0, 0], b: [20, 0], c: [20, 40] };
  const edges = new Map([["in", { a: "a", b: "b", length: 20 }], ["out", { a: "b", b: "c", length: 40 }]]);
  const car = { x: 8, y: 0, heading: 0, speed: 0 };
  const assist = makeAssist(car, ["in", "out"], edges, nodes);
  stepAssist(car, assist, 1 / 60, 1, 100, true);
  assert.equal(car.x, 8); assert.equal(car.speed, 0);
  let done = false;
  for (let i = 0; i < 900 && !done; i++) done = stepAssist(car, assist, 1 / 60, 1, 100);
  assert.equal(done, true); assert.equal(car.x, 20); assert.equal(car.y, 20);
  assert.equal(car.heading, Math.PI / 2);
});
