import test from "node:test";
import assert from "node:assert/strict";
import {
  stepCar, RoadNetwork, project, angleDifference, STEERING_SENSITIVITY, BOUNDARY_DRAG,
} from "../web/physics.mjs";

function network({ stacked = false, crossing = false, body = false } = {}) {
  const nodes = { a: [0, 0], b: [60, 0], c: [120, 0], d: [60, 60], x: [30, -60], y: [30, 60] };
  const edges = [
    { id: "ab", a: "a", b: "b", way: 1, kind: "residential", length: 60 },
    { id: "bc", a: "b", b: "c", way: 2, kind: "residential", length: 60 },
    { id: "bd", a: "b", b: "d", way: 3, kind: "residential", length: 60 },
  ];
  if (crossing) edges.push({ id: "xy", a: "x", b: "y", way: 4, kind: "primary", layer: "1", length: 120 });
  for (const e of [...edges]) edges.push({ ...e, id: `~${e.id}`, a: e.b, b: e.a, wrongway: true });
  return new RoadNetwork({
    nodes, edges, bounds: [-100, -100, 200, 200],
    branch_levels: Object.fromEntries(edges.map(e => [e.id, [stacked && e.way === 3 ? "1" : "0", "no", "no"]])),
    driving: { taxi_radius: 2.5, ...(body ? { taxi_length: 5.4, taxi_width: 2.6 } : {}),
      widths: { residential: 10, primary: 16 },
      max_speed: 150 / 3.6, acceleration: 7, upgraded_acceleration: 9.1 },
  });
}
const carAt = (x = 20, y = 0) => ({ x, y, speed: 0, heading: 0, edge: "ab" });
const freeDriving = { maxSpeed: 150 / 3.6, acceleration: 7 };

test("rectangular body permits side clearance but rejects nose and corner overlaps at every heading", () => {
  const roads = network({ body: true }), edge = roads.edges.get("ab");
  for (const heading of [0, Math.PI / 6, Math.PI / 4, Math.PI / 2, Math.PI, -Math.PI / 4]) {
    const support = Math.abs(Math.sin(heading)) * 2.7 + Math.abs(Math.cos(heading)) * 1.3;
    for (const side of [-1, 1]) {
      assert.equal(roads.bodyFits({ x: 25, y: side * (5 - support - 0.001) }, heading, edge), true);
      assert.equal(roads.bodyFits({ x: 25, y: side * (5 - support + 0.001) }, heading, edge), false);
    }
  }
  assert.equal(roads.bodyFits({ x: 25, y: 3.6 }, 0, edge), true, "use body width, not a circular radius");
  assert.equal(roads.bodyFits({ x: 25, y: 3.6 }, Math.PI / 2, edge), false, "nose must not cross the wall");
});

test("wall contact permits steering overlap and sliding without deeper penetration", () => {
  const roads = network({ body: true }), car = carAt(20, 3.7);
  car.speed = 8;
  const result = stepCar(car, { gas: true, right: true }, 1 / 60, { roads });
  assert.ok(car.heading > 0, "wall must not cancel manual rotation");
  assert.equal(roads.bodyFits(car, car.heading, roads.edges.get(car.edge)), false);
  assert.equal(result.blocked, true);
  assert.ok(car.x > 20);
  assert.ok(car.y <= 3.7 + 1e-5);
  assert.ok(car.speed < 8, "contact drag must outweigh acceleration at this speed");
  stepCar(car, { gas: true, left: true }, 1 / 60, { roads });
  assert.ok(car.heading < 0.05, "steering back must still work while overlapping");
  car.heading = 0;
  for (let frame = 0; frame < 60; frame++) stepCar(car, { gas: true }, 1 / 60, { roads });
  assert.ok(car.x > 20);
  const before = car.x;
  for (let frame = 0; frame < 180; frame++) {
    stepCar(car, { brake: true }, 1 / 60, { roads });
    assert.ok(roads.bodyFits(car, car.heading, roads.edges.get(car.edge)));
  }
  assert.ok(car.x < before);
  assert.ok(car.speed < 0 && car.speed > -4, "reverse also slows while touching the wall");
});

test("body containment uses connected junction surfaces but not disconnected flyovers or concave gaps", () => {
  const roads = network({ body: true, crossing: true }), edge = roads.edges.get("ab");
  for (let heading = 0; heading < Math.PI * 2; heading += 0.1) {
    assert.ok(roads.bodyFits({ x: 60, y: 0 }, heading, edge));
  }
  assert.equal(roads.bodyFits({ x: 30, y: 4 }, Math.PI / 2, edge), false);
  assert.equal(roads.bodyFits({ x: 55, y: 5 }, Math.PI / 4, edge), false);
  assert.equal(roads.bodyFits({ x: 60, y: 1 }, Math.PI / 2, edge), true);
});

test("body-shaped movement cannot tunnel at top speed or cross district bounds", () => {
  const roads = network({ body: true });
  roads.bounds = [0, -10, 120, 10];
  const car = carAt(10, 0);
  car.speed = roads.driving.max_speed;
  for (let frame = 0; frame < 240; frame++) {
    stepCar(car, { gas: true }, 1 / 30, { roads });
    assert.ok(roads.bodyFits(car, car.heading, roads.edges.get(car.edge)));
    assert.ok(car.x + 2.7 <= 120 + 1e-6);
  }
  assert.ok(car.speed < 4, "continued wall contact must reduce speed even with the accelerator held");
});

test("overlapping taxi can slide, drive inward and reverse inward but cannot penetrate deeper", () => {
  const roads = network({ body: true }), edge = roads.edges.get("ab");
  const old = { x: 25, y: 3.7 }, heading = Math.PI / 4;
  const initial = roads.penetration(old, heading, edge);
  for (const desired of [{ x: 25.2, y: 3.7 }, { x: 25.2, y: 3.5 }, { x: 24.8, y: 3.5 }]) {
    const result = roads.constrain(old, desired, heading, edge, new Set());
    assert.ok(Math.hypot(result.x - old.x, result.y - old.y) > 0.1);
    assert.ok(roads.penetration(result, heading, edge) <= initial + 1e-5);
  }
  const outward = roads.constrain(old, { x: 25.2, y: 3.9 }, heading, edge, new Set());
  assert.ok(outward.x > old.x, "retain tangent movement");
  assert.ok(outward.y <= old.y + 1e-5, "remove outward movement");
});

test("boundary drag is continuous, symmetric in reverse and independent of frame rate", () => {
  for (const speed of [-4, 10]) {
    const speeds = [];
    for (const dt of [1 / 60, 1 / 30]) {
      const roads = network({ body: true }), car = carAt(25, 3.7);
      car.speed = speed;
      for (let frame = 0; frame < Math.round(1 / dt); frame++) {
        stepCar(car, { gas: speed > 0, brake: speed < 0 }, dt, {
          roads, acceleration: 0,
        });
      }
      speeds.push(Math.abs(car.speed));
    }
    if (speed > 0) {
      for (const value of speeds) assert.ok(Math.abs(value - speed * Math.exp(-BOUNDARY_DRAG)) < 1e-8);
    } else {
      for (const value of speeds) assert.ok(value < 2 && value > 0);
    }
  }
});

test("sustained wall sliding does not creep through the boundary or onto a disconnected crossing", () => {
  const roads = network({ body: true, crossing: true }), car = carAt(20, 3.7);
  car.heading = Math.PI / 4; car.speed = 8;
  for (let frame = 0; frame < 300; frame++) {
    stepCar(car, { gas: true }, 1 / 60, { roads });
    assert.ok(car.y <= 3.7 + 1e-5);
    assert.notEqual(car.edge, "xy");
    assert.notEqual(car.edge, "~xy");
  }
  assert.ok(car.x > 20);
});

test("body-shaped queued turns preserve speed and fit throughout the snap", () => {
  const roads = network({ body: true }), car = carAt(55, 1);
  car.speed = 10;
  let snaps = 0;
  for (let frame = 0; frame < 90; frame++) {
    const result = stepCar(car, { gas: true }, 1 / 60, {
      roads, acceleration: 0, selectedExit: "bd", selectedJunction: "b",
    });
    if (result.junctionPoint) snaps++;
    assert.ok(roads.bodyFits(car, car.heading, roads.edges.get(car.edge)));
    assert.equal(car.speed, 10);
  }
  assert.equal(snaps, 1);
  assert.equal(car.edge, "bd");
  assert.equal(car.heading, Math.PI / 2);
});

test("accelerate and steer, brake to a stop, then hold for low-speed reverse", () => {
  const car = carAt();
  for (let i = 0; i < 180; i++) stepCar(car, { gas: true }, 1 / 60, freeDriving);
  assert.ok(car.speed > 20 && car.speed <= 150 / 3.6);
  while (car.speed > 0) stepCar(car, { brake: true }, 1 / 60, freeDriving);
  assert.equal(car.speed, 0);
  const x = car.x;
  for (let i = 0; i < 100; i++) stepCar(car, { brake: true }, 1 / 60, freeDriving);
  assert.equal(car.speed, -4); assert.ok(car.x < x);
  const heading = car.heading;
  stepCar(car, { brake: true, right: true }, 1 / 60, freeDriving);
  assert.ok(car.heading < heading);
  for (let i = 0; i < 100; i++) stepCar(car, {}, 1 / 60, freeDriving);
  assert.equal(Math.abs(car.speed), 0);
});

test("handbrake rapidly slows the taxi without reversing", () => {
  const car = carAt();
  car.speed = 12;
  for (let i = 0; i < 60; i++) stepCar(car, { handbrake: true }, 1 / 60, freeDriving);
  assert.equal(car.speed, 0);
  for (let i = 0; i < 60; i++) stepCar(car, { handbrake: true }, 1 / 60, freeDriving);
  assert.equal(car.speed, 0);
});

test("the full conservative footprint remains inside road and slides along its edge", () => {
  const roads = network(), car = carAt(20, roads.radius(roads.edges.get("ab")));
  car.heading = Math.PI / 4; car.speed = 10;
  const x = car.x;
  for (let i = 0; i < 90; i++) {
    stepCar(car, { gas: true }, 1 / 60, { roads });
    const p = project(car, roads.nodes.a, roads.nodes.b);
    assert.ok(p.distance + roads.driving.taxi_radius <= 5 + 1e-6);
  }
  assert.ok(car.x > x + 1);
  assert.ok(Math.abs(car.heading - Math.PI / 4) < 1e-10, "boundary collision must not auto-steer");
});

test("crossing an unconnected flyover cannot change the road or level", () => {
  const roads = network({ crossing: true }), car = carAt(30, 0);
  car.heading = Math.PI / 2;
  for (let i = 0; i < 300; i++) stepCar(car, { gas: true }, 1 / 60, { roads });
  assert.ok(Math.abs(car.y) <= 2.5 + 1e-6);
  assert.ok(["ab", "~ab"].includes(car.edge));
  assert.equal(roads.approach(car), null);
});

test("normal two-exit forks stay manual while stacked forks request a choice", () => {
  const roads = network(), car = carAt(45);
  car.speed = 3;
  const approach = roads.approach(car);
  assert.equal(approach.stacked, false);
  assert.deepEqual(approach.options.map(e => e.id), ["bc", "bd"]);
  const early = carAt(15);
  early.speed = 3;
  assert.equal(roads.approach(early).node, "b", "choice should be available well before reaching the junction");
  const stacked = network({ stacked: true });
  assert.equal(stacked.approach(car).stacked, true);
  car.x = 59; car.speed = 5;
  for (let i = 0; i < 90; i++) stepCar(car, { gas: true }, 1 / 60, { roads: stacked });
  assert.equal(car.edge, "bc");
  assert.equal(car.heading, 0);
});

test("selected exits never add steering assist or raise manual sensitivity", () => {
  const roads = network();
  for (const [x, y, edge, heading] of [[52, 0, "ab", 0], [60, 1, "bd", Math.PI / 2],
    [60, 10, "bd", Math.PI / 2]]) {
    for (const direction of [-1, 0, 1]) {
      const car = { ...carAt(x, y), edge, heading };
      car.speed = 10;
      stepCar(car, { gas: true, left: direction < 0, right: direction > 0 }, 1 / 60, {
        roads, acceleration: 0, selectedExit: "bd", selectedJunction: "b",
      });
      assert.ok(Math.abs(car.heading - (heading + direction * STEERING_SENSITIVITY / 60)) < 1e-10);
      assert.equal(car.speed, 10);
    }
  }
});

test("a taxi snapped onto the selected road continues straight without assist", () => {
  const roads = network();
  const car = { ...carAt(60, 2), edge: "bd", heading: Math.PI / 2 };
  car.speed = 10;
  for (let i = 0; i < 60; i++) {
    stepCar(car, { gas: true }, 1 / 60, {
      roads, selectedExit: "bd", selectedJunction: "b",
    });
  }
  assert.equal(car.edge, "bd");
  assert.equal(car.heading, Math.PI / 2);
  assert.equal(car.x, 60);
  assert.ok(car.y > 12);
});

test("queued turns snap only on junction arrival and preserve speed across sharp exits", () => {
  for (const angle of [0, Math.PI / 2, -Math.PI / 2, Math.PI - 0.1, -Math.PI + 0.1]) {
    for (const offset of [-2.5, -1, 0, 1, 2.5]) {
      const roads = network(), car = carAt(45, offset);
      roads.nodes.d = [60 + Math.cos(angle) * 60, Math.sin(angle) * 60];
      car.speed = 10;
      const options = { roads, acceleration: 0, selectedExit: "bd", selectedJunction: "b" };
      for (let frame = 0; frame < 88; frame++) {
        const result = stepCar(car, { gas: true }, 1 / 60, options);
        assert.equal(result.junctionPoint, undefined);
        assert.equal(car.heading, 0);
        assert.equal(car.edge, "ab");
        assert.ok(Math.abs(car.y - offset) < 1e-10);
      }
      let snapped = null;
      for (let frame = 0; frame < 4; frame++) {
        const result = stepCar(car, { gas: true }, 1 / 60, options);
        if (result.junctionPoint) { snapped = result; break; }
      }
      assert.ok(snapped, `turn must snap at arrival: angle=${angle}, offset=${offset}`);
      assert.deepEqual(snapped.junctionPoint, { x: 60, y: 0, heading: 0 });
      assert.ok(Math.abs(angleDifference(car.heading, angle)) < 1e-10);
      assert.equal(car.edge, "bd");
      assert.equal(car.speed, 10);
    }
  }
});

test("queued junction arrival covers both road boundaries even while steering into an overlapping exit", () => {
  for (const width of [10, 14, 16]) {
    for (const side of [-1, 1]) {
      for (const heading of [-0.2, 0.2]) {
        const roads = network();
        roads.driving.widths.residential = width;
        const radius = roads.radius(roads.edges.get("ab"));
        const car = carAt(45, side * radius);
        car.heading = heading; car.speed = 10;
        let snapped;
        for (let frame = 0; frame < 120; frame++) {
          const before = { ...car };
          const result = stepCar(car, { gas: true }, 1 / 60, {
            roads, acceleration: 0, selectedExit: "bd", selectedJunction: "b",
          });
          if (result.junctionPoint) {
            snapped = result;
            assert.ok(before.x < 60 && before.x + Math.cos(heading) * 10 / 60 >= 60 - 1e-8);
            break;
          }
          assert.equal(car.edge, "ab", "an overlapping exit must not steal the queued arrival");
          assert.equal(car.heading, heading, "approach must retain manual steering");
          assert.ok(Math.abs(car.y) <= radius + 1e-6);
        }
        assert.ok(snapped, `width=${width}, side=${side}, heading=${heading}`);
        assert.deepEqual(snapped.junctionPoint, { x: 60, y: 0, heading });
        assert.equal(car.edge, "bd");
        assert.equal(car.heading, Math.PI / 2);
        assert.equal(car.speed, 10);
      }
    }
  }
});

test("short-road junction detection spans the full drivable width, not a centre-point circle", () => {
  const roads = network({ stacked: true });
  roads.nodes.a = [59, 0];
  roads.edges.get("ab").length = 1;
  for (const offset of [-2.5, 0, 2.5]) {
    const car = carAt(59.3, offset);
    car.speed = 3;
    assert.equal(roads.approach(car)?.node, "b");
    car.x = 59.1;
    assert.equal(roads.approach(car), null, "must not extend the approach distance");
    car.x = 59.3; car.y = Math.sign(offset || 1) * 2.51;
    assert.equal(roads.approach(car), null, "must not extend beyond the road corridor");
  }
});

test("stopping, reversing, or closing the exit does not execute a queued snap", () => {
  for (const [speed, closed] of [[0, new Set()], [-4, new Set()], [10, new Set([3])]]) {
    const roads = network(), car = carAt(59.99);
    car.speed = speed;
    const result = stepCar(car, {}, 1 / 60, {
      roads, closed, selectedExit: "bd", selectedJunction: "b",
    });
    assert.equal(result.junctionPoint, undefined);
    assert.equal(car.heading, 0);
  }
});

test("dead-end reverse remains in the road footprint and reverses out", () => {
  const roads = network(), car = carAt(119, 0);
  car.edge = "bc"; car.speed = 8;
  for (let i = 0; i < 120; i++) stepCar(car, { gas: true }, 1 / 60, { roads });
  assert.ok(car.x <= 122.5 + 1e-6);
  const end = car.x;
  for (let i = 0; i < 180; i++) stepCar(car, { brake: true }, 1 / 60, { roads });
  assert.ok(car.x < end - 3);
  assert.ok(car.speed < 0 && car.speed >= -4);
});

test("traffic, fuel, closed roads, and world bounds constrain both forward and reverse", () => {
  const roads = network(), car = carAt();
  car.speed = roads.driving.max_speed;
  stepCar(car, { gas: true }, 1 / 60, { traffic: 0.5, roads });
  assert.equal(car.speed, roads.driving.max_speed / 2);
  car.speed = 0;
  for (let i = 0; i < 60; i++) stepCar(car, { brake: true }, 1 / 60, { fuel: 0, roads });
  assert.equal(Math.abs(car.speed), 0);
  const x = car.x;
  stepCar(car, { gas: true }, 1 / 60, { roads, closed: new Set([1]) });
  assert.equal(car.x, x); assert.equal(Math.abs(car.speed), 0);
  car.x = 21; roads.bounds = [0, -10, 24, 10]; car.speed = 18;
  for (let i = 0; i < 120; i++) stepCar(car, { gas: true }, 1 / 60, { roads });
  assert.ok(car.x + 2.5 <= 24 + 1e-6);
});

test("projection and heading wrap are well defined", () => {
  assert.deepEqual(project({ x: 5, y: 3 }, [0, 0], [10, 0]), { x: 5, y: 0, t: 0.5, distance: 3 });
  assert.ok(Math.abs(angleDifference(-Math.PI + 0.1, Math.PI - 0.1) - 0.2) < 1e-10);
});

test("extended manual steering and reverse never leave the conservative road footprint", () => {
  const roads = network({ crossing: true }), car = carAt();
  for (let i = 0; i < 6000; i++) {
    const reverse = Math.floor(i / 240) % 3 === 2;
    stepCar(car, {
      gas: !reverse, brake: reverse,
      right: Math.floor(i / 100) % 3 === 0, left: Math.floor(i / 100) % 3 === 1,
    }, 1 / 60, { roads });
    const edge = roads.edges.get(car.edge);
    const p = project(car, roads.nodes[edge.a], roads.nodes[edge.b]);
    assert.ok(p.distance <= roads.radius(edge) + 1e-6, `outside road at frame ${i}`);
    assert.notEqual(edge.way, 4, "must not switch onto the disconnected flyover");
  }
});

test("standard and upgraded engines reach exactly 150 km/h, with faster upgraded acceleration", () => {
  const normal = carAt(), upgraded = carAt();
  for (let i = 0; i < 60; i++) {
    stepCar(normal, { gas: true }, 1 / 60, freeDriving);
    stepCar(upgraded, { gas: true }, 1 / 60, { ...freeDriving, acceleration: 9.1 });
  }
  assert.ok(Math.abs(upgraded.speed / normal.speed - 1.3) < 1e-9);
  for (let i = 0; i < 1200; i++) {
    stepCar(normal, { gas: true }, 1 / 60, freeDriving);
    stepCar(upgraded, { gas: true }, 1 / 60, { ...freeDriving, acceleration: 9.1 });
  }
  assert.equal(normal.speed * 3.6, 150);
  assert.equal(upgraded.speed * 3.6, 150);
});

test("preview highlights the full road ahead even stopped or beyond the old horizon, without advancing popup timing", () => {
  const roads = network({ stacked: true });
  roads.nodes.a = [-200, 0]; roads.edges.get("ab").length = 260;
  const car = carAt(-100); car.speed = 40;
  assert.equal(roads.preview(car).start.x, -100);
  assert.deepEqual(roads.preview(car).edges.map(e => e.id), ["ab"]);
  assert.equal(roads.preview(car).node, "b");
  assert.equal(roads.approach(car), null);
  car.x = -101;
  assert.equal(roads.preview(car).node, "b");
  car.speed = 60; car.x = -120;
  assert.equal(roads.preview(car).node, "b");
  car.x = -121;
  assert.equal(roads.preview(car).node, "b");
  car.speed = 0;
  assert.equal(roads.preview(car).start.x, -121);
  car.speed = -1;
  assert.equal(roads.preview(car), null);
});

test("preview follows connected bends across short segments but stops at closures and dead ends", () => {
  const roads = network();
  roads.nodes.start = [-20, -40];
  const start = { id: "start", a: "start", b: "a", way: 8, length: Math.hypot(20, 40), kind: "residential" };
  roads.edges.set("start", start);
  const car = { x: -10, y: -20, heading: roads.angle(start), speed: 25, edge: "start" };
  const preview = roads.preview(car);
  assert.equal(preview.incoming, "ab");
  assert.deepEqual(preview.edges.map(e => e.id), ["start", "ab"]);
  assert.equal(preview.start.x, -10);
  assert.deepEqual(roads.preview(car, new Set([1])).edges.map(e => e.id), ["start"]);
  assert.deepEqual(roads.preview(car, new Set([2])).edges.map(e => e.id), ["start", "ab", "bd"]);
  assert.equal(roads.preview(car, new Set([8])), null);
  car.heading += Math.PI;
  assert.equal(roads.preview(car), null);
});

test("each possible exit follows its bends and short segments only to the following junction", () => {
  const roads = network();
  roads.nodes.e = [150, 30]; roads.nodes.f = [180, 30]; roads.nodes.g = [150, 60];
  const add = (id, a, b, way) => {
    const edge = { id, a, b, way, kind: "residential", length: 42 };
    roads.edges.set(id, edge);
    roads.outgoing.set(a, [...(roads.outgoing.get(a) || []), edge]);
  };
  add("ce", "c", "e", 5); add("ef", "e", "f", 6); add("eg", "e", "g", 7);
  const car = carAt(); car.speed = 0;
  const preview = roads.preview(car);
  assert.deepEqual(preview.exits.map(exit => exit.path.edges.map(e => e.id)), [["bc", "ce"], ["bd"]]);
  assert.equal(preview.exits[0].path.node, "e");
  assert.deepEqual(preview.exits[0].path.options.map(e => e.id), ["ef", "eg"]);
  assert.deepEqual(roads.preview(car, new Set([5])).exits[0].path.edges.map(e => e.id), ["bc"]);
});

test("preview ignores disconnected flyovers and terminates on a connected loop", () => {
  const roads = network({ crossing: true }), car = carAt(20);
  car.speed = 10;
  assert.equal(roads.preview(car).node, "b");
  assert.deepEqual(roads.preview(car).options.map(e => e.id), ["bc", "bd"]);
  roads.nodes.c = [70, 0]; roads.edges.get("bc").length = 10;
  roads.outgoing.set("b", [roads.edges.get("bc"), roads.edges.get("~ab")]);
  const back = { id: "ca", a: "c", b: "a", way: 5, length: 70, kind: "residential" };
  roads.outgoing.set("c", [roads.edges.get("~bc"), back]);
  car.speed = 100;
  assert.deepEqual(roads.preview(car).edges.map(e => e.id), ["ab", "bc", "ca"]);
  assert.deepEqual(roads.preview(car).exits, []);
});

test("150 km/h movement crosses short connected segments without jumping road corridors", () => {
  const nodes = {}, edges = [];
  for (let i = 0; i <= 20; i++) nodes[i] = [i * 5, 0];
  for (let i = 0; i < 20; i++) {
    const edge = { id: `e${i}`, a: i, b: i + 1, way: 1, length: 5, kind: "residential" };
    edges.push(edge, { ...edge, id: `~e${i}`, a: i + 1, b: i, wrongway: true });
  }
  const roads = new RoadNetwork({ nodes, edges, driving: network().driving, bounds: [-10, -10, 110, 10] });
  const car = { ...carAt(1), edge: "e0", speed: roads.driving.max_speed };
  for (let i = 0; i < 100; i++) {
    const old = car.x;
    stepCar(car, { gas: true }, 1 / 60, { roads });
    assert.equal(car.speed, roads.driving.max_speed);
    assert.ok(Math.abs(car.x - old - car.speed / 60) < 1e-9);
    assert.equal(car.y, 0);
  }
  assert.ok(Number(car.edge.slice(1)) > 10);
});

test("boundary sliding cannot cut outside a concave connected-road corner between valid endpoints", () => {
  const nodes = { a: [-2.07, 435.21], b: [-3.38, 439.51], c: [-6.65, 442.92] };
  const edges = [
    { id: "ab", a: "a", b: "b", way: 1, kind: "secondary", length: 4.5 },
    { id: "bc", a: "b", b: "c", way: 1, kind: "secondary", length: 4.7 },
  ];
  for (const edge of [...edges]) edges.push({ ...edge, id: `~${edge.id}`, a: edge.b, b: edge.a });
  const roads = new RoadNetwork({ nodes, edges, bounds: [-100, 400, 100, 500],
    driving: { taxi_radius: 2.5, widths: { secondary: 14 } } });
  const old = { x: -7.354127361445913, y: 437.1135950866321 };
  const desired = { x: -7.68115699260194, y: 437.4936843546785 };
  const heading = 2.5402007220180094, previous = roads.edges.get("ab");
  assert.ok(roads.match(old, heading, previous));
  assert.ok(roads.match(desired, heading, previous));
  const midpoint = { x: (old.x + desired.x) / 2, y: (old.y + desired.y) / 2 };
  assert.equal(roads.match(midpoint, heading, previous), null, "fixture must reproduce an off-road interior point");
  const result = roads.constrain(old, desired, heading, previous, new Set());
  const steps = Math.max(1, Math.ceil(Math.hypot(result.x - old.x, result.y - old.y) / 0.4));
  let current = previous;
  for (let i = 1; i <= steps; i++) {
    const match = roads.match({ x: old.x + (result.x - old.x) * i / steps,
      y: old.y + (result.y - old.y) * i / steps }, heading, current);
    assert.ok(match, "every movement substep must be server-valid");
    current = match.edge;
  }
});
