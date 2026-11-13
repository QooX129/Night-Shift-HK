import { test } from "node:test";
import assert from "node:assert/strict";
import { doorSide, peopleOnMap, drawHailBubble, describeTraits, describeCharges, drawCitizen } from "../web/citizens.mjs";
import { en, zh } from "../web/i18n.mjs";

const near = (actual, expected) => assert.ok(Math.hypot(actual[0] - expected[0], actual[1] - expected[1]) < 1e-9, ` != ${expected}`);

test("hail text and pointer are centred on the bubble body", () => {
  let body, label;
  const pointer = [];
  const context = {
    beginPath() {}, fill() {}, stroke() {},
    roundRect(...args) { body = args; },
    moveTo(...args) { pointer.push(args); },
    lineTo(...args) { pointer.push(args); },
    fillText(...args) { label = args; },
  };
  drawHailBubble(context, "Taxi!");
  const [x, y, width, height] = body;
  assert.deepEqual(label, ["Taxi!", x + width / 2, y + height / 2]);
  assert.equal(context.textAlign, "center");
  assert.equal(context.textBaseline, "middle");
  assert.equal(pointer[1][0], x + width / 2);
  assert.equal((pointer[0][0] + pointer[2][0]) / 2, x + width / 2);
});

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

test("traits persist from waiting through boarding and alighting", () => {
  const traits = { luggage: 2, bag: "backpack", animal: "bird", wheelchair: true };
  const car = { x: 0, y: 0, heading: 0 };
  const waiting = peopleOnMap({ customer: [7, 8], traits, citizens: [] }, car)[0];
  assert.deepEqual(waiting.traits, traits);
  for (const alighting of [false, true]) {
    const person = peopleOnMap({ elapsed: .5, traits,
      boarding: { point: [7, 8], starts: 0, ends: 2, alighting, traits } }, car)[0];
    assert.deepEqual(person.traits, traits);
    assert.equal(person.walking, true);
    assert.ok(Number.isFinite(person.heading));
  }
});

test("trait and surcharge descriptions include counts and localize without charging free items", () => {
  const traits = { luggage: 2, bag: "backpack", animal: "bird", wheelchair: true };
  const charges = { luggage: 12, animal: 5, booking: 5 };
  assert.equal(describeTraits(traits, en), "Large luggage ×2 · Backpack (free) · Caged bird ×1 · Wheelchair (free)");
  assert.equal(describeCharges(charges, traits, en), "Large luggage ×2 · HK$ 12; Caged bird ×1 · HK$ 5; Phone booking · HK$ 5");
  assert.equal(describeCharges(charges, traits, zh), "大型行李 ×2 · HK$ 12; 籠裝雀鳥 ×1 · HK$ 5; 電召費 · HK$ 5");
  assert.equal(describeCharges({ luggage: 0, animal: 0, booking: 0 }, traits, en), "");
  assert.equal(describeTraits(undefined, en), "");
});

test("2D wheelchair animation rolls wheels instead of swinging legs, with visible luggage and bird cage", () => {
  const strokes = [], rectangles = [];
  const context = {
    beginPath() {}, fill() {}, stroke() {},
    moveTo(...args) { strokes.push(["move", ...args]); },
    lineTo(...args) { strokes.push(["line", ...args]); },
    arc(...args) { strokes.push(["arc", ...args]); },
    fillRect(...args) { rectangles.push(args); }, strokeRect() {},
  };
  const person = { walking: true, walkSpeed: 1, traits: { wheelchair: true, luggage: 2, animal: "bird" } };
  drawCitizen(context, person, 0);
  const initial = strokes.map(item => [...item]);
  strokes.length = 0;
  drawCitizen(context, person, 1);
  assert.deepEqual(strokes.filter(item => item[0] === "arc"), initial.filter(item => item[0] === "arc"));
  assert.notDeepEqual(strokes, initial);
  const [left, right] = rectangles.slice(0, 2);
  assert.ok(left[0] + left[2] / 2 < 0);
  assert.ok(right[0] + right[2] / 2 > 0);
  assert.ok(Math.abs(left[0] + left[2] / 2 + right[0] + right[2] / 2) < 1e-9);
  assert.equal(left[1], right[1]);
  assert.ok(strokes.some(([kind, x]) => kind === "move" && x === 4.5));
  rectangles.length = 0;
  drawCitizen(context, { traits: { luggage: 1 } }, 0);
  assert.equal(rectangles.length, 1);
  assert.deepEqual(rectangles[0], left);
  rectangles.length = 0;
  drawCitizen(context, { traits: { luggage: 2, bag: "handbag" } }, 0);
  const bag = rectangles.find(([, , width]) => width === 1);
  assert.ok(bag[1] + bag[3] <= rectangles[1][1]);
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
    { elapsed, boarding: { point: [0, -6], starts: 0, ends: 2, alighting: true } }, car)[0];
  assert.equal(render(0).scale, 0);
  assert.ok(render(0.2).scale > 0 && render(0.2).scale < 1);
  near(render(0.4).point, [0, -1.2]);
  assert.ok(render(1.2).point[1] < -1.2 && render(1.2).point[1] > -6);
  near(render(2).point, [0, -6]);
  assert.equal(render(2).scale, 1);
});

test("alighting always uses the taxi left door at every heading", () => {
  for (const heading of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const car = { x: 4, y: 5, heading };
    const point = [car.x + Math.sin(heading) * 6, car.y - Math.cos(heading) * 6];
    const state = { elapsed: .4, boarding: { point, starts: 0, ends: 2, alighting: true } };
    assert.equal(doorSide(state, car), -1);
    near(peopleOnMap(state, car)[0].point,
      [car.x + Math.sin(heading) * 1.2, car.y - Math.cos(heading) * 1.2]);
  }
});

test("returning hails walk back smoothly and clamp at the original sidewalk", () => {
  const person = { id: "returning", point: [0, 0],
    motion: { points: [[0, 0], [4, 0]], distance: 4, direction: -1,
      speed: 1, returning_to_walk: true } };
  const at = elapsed => peopleOnMap({ citizens: [person], citizens_at: 0, elapsed }, {})[0];
  near(at(1).point, [3, 0]);
  near(at(10).point, [0, 0]);
  assert.equal(at(1).heading, -Math.PI);
});

test("boarding door follows the taxi heading and absent city data is safe", () => {
  assert.deepEqual(peopleOnMap({}, {}), []);
  const people = peopleOnMap({ elapsed: 1, boarding: { point: [10, 4], starts: 0, ends: 1 } },
    { x: 4, y: 5, heading: Math.PI / 2 });
  near(people[0].point, [5.2, 5]);
});
