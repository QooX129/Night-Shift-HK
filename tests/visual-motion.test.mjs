import test from "node:test";
import assert from "node:assert/strict";
import { interpolateCar } from "../web/visual-motion.mjs";

test("rendered motion remains smooth when frames contain zero or two physics steps", () => {
  const step = 1 / 60, speed = 42;
  const car = { x: 0, y: 0, heading: 0, speed, edge: "road" };
  let previous = null, bank = 0, last = null, zeroSteps = 0, doubleSteps = 0;
  for (let frame = 0; frame < 120; frame++) {
    const dt = frame % 2 ? .0174 : .016;
    const hadPrevious = previous !== null;
    bank += dt;
    let steps = 0;
    while (bank >= step) {
      previous = { ...car };
      car.x += speed * step;
      bank -= step;
      steps++;
    }
    if (steps === 0) zeroSteps++;
    if (steps === 2) doubleSteps++;
    const visual = interpolateCar(previous, car, bank / step);
    if (last !== null && hadPrevious) assert.ok(Math.abs((visual.x - last) - speed * dt) < 1e-8);
    last = visual.x;
  }
  assert.ok(zeroSteps > 0 && doubleSteps > 0);
});

test("interpolation wraps headings, preserves current state and snaps without a previous step", () => {
  const previous = { x: 1, y: 2, heading: Math.PI - .1, edge: "old" };
  const current = { x: 5, y: 6, heading: -Math.PI + .1, edge: "new", speed: 10 };
  const visual = interpolateCar(previous, current, .5);
  assert.equal(visual.x, 3);
  assert.equal(visual.y, 4);
  assert.ok(Math.abs(visual.heading - Math.PI) < 1e-10);
  assert.equal(visual.edge, "new");
  assert.equal(visual.speed, 10);
  assert.deepEqual(interpolateCar(null, current, 0), current);
  assert.equal(current.x, 5);
});
