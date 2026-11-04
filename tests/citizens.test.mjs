import { test } from "node:test";
import assert from "node:assert/strict";
import { doorSide, peopleOnMap } from "../web/citizens.mjs";

const near = (actual, expected) => assert.ok(Math.hypot(actual[0] - expected[0], actual[1] - expected[1]) < 1e-9, ` != ${expected}`);

test("walking continuously samples safe paths and reverses without overshooting", () => {
  const citizen = { id: "walker", point: [9, 0], hailing: false,
    motion: { points: [[0, 0], [10, 0]], distance: 9, direction: 1, speed: 1, seeking_curb: false } };
  const at = elapsed => peopleOnMap({ citizens: [citizen], elapsed, citizens_at: 0 }, {})[0];
  near(at(.5).point, [9.5, 0]);
  near(at(1.5).point, [9.5, 0]);
  assert.equal(Math.abs(at(1.5).heading), Math.PI);
  near(at(12).point, [1, 0]);
  assert.deepEqual(citizen.point, [9, 0]);
});

test("curb approach clamps at the safe target and hailing citizens do not drift", () => {
  const citizen = { id: "walker", point: [0, 2], hailing: false,
    motion: { points: [[0, 2], [0, 1]], distance: 0, direction: 1, speed: 1, seeking_curb: true } };
  const at = elapsed => peopleOnMap({ citizens: [citizen], elapsed, citizens_at: 0 }, {})[0];
  near(at(.5).point, [0, 1.5]);
  near(at(5).point, [0, 1]);
  assert.equal(at(5).walking, false);
  citizen.motion.speed = 0;
  citizen.motion.distance = 1;
  citizen.hailing = true;
  near(at(100).point, [0, 1]);
});

test("walking does not jump when a server snapshot acknowledges a reversal", () => {
  const motion = { points: [[0, 0], [10, 0]], distance: 9, direction: 1, speed: 1, seeking_curb: false };
  const citizen = { id: "walker", point: [9, 0], motion };
  const predicted = peopleOnMap({ citizens: [citizen], elapsed: 2, citizens_at: 0 }, {})[0];
  const acknowledged = { ...citizen, point: [9.5, 0], motion: { ...motion, distance: 9.5, direction: -1 } };
  const updated = peopleOnMap({ citizens: [acknowledged], elapsed: 2, citizens_at: 1.5 }, {})[0];
  near(updated.point, predicted.point);
  assert.equal(updated.heading, predicted.heading);
});

test("boarding animation walks to the taxi door then shrinks inside without mutating citizens", () => {
  const citizens = [{ id: "waiting", point: [30, 2], hailing: true }];
  const boarding = { point: [10, 4], starts: 0, ends: 2 };
  const car = { x: 0, y: 0, heading: 0 };
  const render = elapsed => peopleOnMap({ citizens, boarding, elapsed }, car).at(-1);
  assert.deepEqual(render(0).point, [10, 4]);
  assert.ok(render(1).point[0] > 0 && render(1).point[0] < 10);
  assert.ok(Math.hypot(render(1.6).point[0], render(1.6).point[1] - 1.2) < 1e-10);
  assert.ok(render(1.8).scale > 0 && render(1.8).scale < 1);
  assert.equal(render(2).scale, 0);
  assert.equal(render(3).scale, 0);
  assert.equal(citizens.length, 1);
});

test("phone customer waits waving at the pickup curb", () => {
  const people = peopleOnMap({ customer: [7, 8], citizens: [] }, {});
  assert.deepEqual(people, [{ id: "customer", point: [7, 8], hailing: true }]);
});

test("door opens on the side nearer the passenger", () => {
  const car = { x: 0, y: 0, heading: 0 };
  const at = point => ({ elapsed: 1.6, boarding: { point, starts: 0, ends: 2 } });
  assert.equal(doorSide(at([0, 6]), car), 1);
  assert.equal(doorSide(at([0, -6]), car), -1);
  near(peopleOnMap(at([0, -6]), car)[0].point, [0, -1.2]);
  near(peopleOnMap(at([0, 6]), car)[0].point, [0, 1.2]);
});

test("alighting grows out of the door and walks to the curb", () => {
  const car = { x: 0, y: 0, heading: 0 };
  const render = elapsed => peopleOnMap(
    { elapsed, boarding: { point: [0, 6], starts: 0, ends: 2, alighting: true } }, car)[0];
  assert.equal(render(0).scale, 0);
  assert.ok(render(0.2).scale > 0 && render(0.2).scale < 1);
  near(render(0.4).point, [0, 1.2]);
  assert.ok(render(1.2).point[1] > 1.2 && render(1.2).point[1] < 6);
  near(render(2).point, [0, 6]);
  assert.equal(render(2).scale, 1);
});

test("boarding door follows the taxi heading and absent city data is safe", () => {
  assert.deepEqual(peopleOnMap({}, {}), []);
  const people = peopleOnMap({ elapsed: 1, boarding: { point: [10, 4], starts: 0, ends: 1 } },
    { x: 4, y: 5, heading: Math.PI / 2 });
  near(people[0].point, [5.2, 5]);
});
