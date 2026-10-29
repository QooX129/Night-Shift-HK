import test from "node:test";
import assert from "node:assert/strict";
import { JunctionInput, junctionShortcuts, junctionDirection } from "../web/junction-input.mjs";

const fan = (direction = "straight", center = 0, count = 3) =>
  Array.from({ length: count }, (_, i) => ({
    edge: `exit-${i}`, direction, angle: center + (i - (count - 1) / 2) * 0.1,
  }));

test("HUD shortcuts use real selection rules for every road, including large fans", () => {
  for (const options of [fan(), fan("straight", 0, 7), [
    { edge: "ferry", angle: -0.7612558769673607 },
    { edge: "waterloo-left", angle: -0.36676369551951105 },
    { edge: "waterloo-right", angle: 0.22857796116330523 },
  ].map(option => ({ ...option, direction: junctionDirection(option.angle) }))]) {
    const shortcuts = junctionShortcuts(options);
    assert.equal(shortcuts.size, options.length);
    for (const option of options) {
      const label = shortcuts.get(option.edge);
      const [main, side] = label.split(" + ");
      const actions = { W: "gas", A: "left", D: "right", S: "brake" };
      const input = new JunctionInput({ releaseGrace: 0 });
      input.press("main", actions[main], options);
      if (side) {
        const [key, count = "1"] = side.split(" ×");
        for (let i = 0; i < Number(count); i++) {
          input.press("side", actions[key], options);
          if (i < Number(count) - 1) input.release("side");
        }
      }
      assert.equal(input.preview, option.edge, label);
    }
  }
});
test("sub-road release grace confirms either release order within 150 ms", () => {
  for (const first of ["w", "a"]) {
    const input = new JunctionInput(), options = fan();
    input.press("w", "gas", options, 0);
    input.press("a", "left", options, 1);
    assert.equal(input.release(first, 10), null);
    input.advance(159);
    assert.equal(input.preview, "exit-0");
    assert.equal(input.release(first === "w" ? "a" : "w", 159), "exit-0");
    assert.equal(input.releaseDeadline, null);
  }
});

test("grace expires at 150 ms and remaining keys determine confirmation even without animation", () => {
  for (const first of ["w", "a"]) {
    const input = new JunctionInput(), options = [
      ...fan(), { edge: "left", direction: "left", angle: -1 },
    ];
    input.press("w", "gas", options, 0);
    input.press("a", "left", options, 1);
    input.release(first, 10);
    const expected = first === "w" ? "left" : "exit-1";
    assert.equal(input.release(first === "w" ? "a" : "w", 160), expected);
  }
});

test("grace cancels on reset and new input uses the current held combination", () => {
  const input = new JunctionInput(), options = fan();
  input.press("w", "gas", options, 0);
  input.press("a", "left", options, 1);
  input.release("a", 10);
  assert.equal(input.press("d", "right", options, 50), "exit-2");
  assert.equal(input.releaseDeadline, null);
  input.release("d", 60);
  input.reset();
  input.advance(1000);
  assert.equal(input.preview, null);
  assert.equal(input.release("w", 1001), null);
});

test("main key chooses the middle and combinations choose both sides of every relative fan", () => {
  for (const [main, group, center, left, right] of [
    ["gas", "straight", 0, "left", "right"],
    ["left", "left", -Math.PI / 2, "brake", "gas"],
    ["right", "right", Math.PI / 2, "gas", "brake"],
    ["brake", "uturn", Math.PI, "right", "left"],
  ]) {
    for (const [side, expected] of [[left, "exit-0"], [right, "exit-2"]]) {
      for (const releaseMainFirst of [true, false]) {
        const input = new JunctionInput({ releaseGrace: 0 }), options = fan(group, center);
        assert.equal(input.press("main", main, options), "exit-1");
        assert.equal(input.press("side", side, options), expected);
        assert.equal(input.release(releaseMainFirst ? "main" : "side"), null);
        const remaining = new JunctionInput();
        const latest = remaining.press("remaining", releaseMainFirst ? side : main, options);
        assert.equal(input.preview, latest);
        assert.equal(input.release(releaseMainFirst ? "side" : "main"), latest);
        assert.equal(input.release("side"), null);
      }
    }
  }
});

test("two exits default to closest angle and side keys address both exits", () => {
  const options = fan("straight", 0.03, 2), input = new JunctionInput({ releaseGrace: 0 });
  assert.equal(input.press("w", "gas", options), "exit-0");
  assert.equal(input.press("d", "right", options), "exit-1");
  assert.equal(input.release("d"), null);
  assert.equal(input.press("a", "left", options), "exit-0");
});

test("actual Waterloo junction prioritizes its two forward branches over Ferry Street", () => {
  const options = [
    { edge: "1299955103:0:1168380653", direction: "left", angle: -0.7612558769673607 },
    { edge: "1299955104:0:1168380653", direction: "straight", angle: -0.36676369551951105 },
    { edge: "1299955105:0:1168380653", direction: "straight", angle: 0.22857796116330523 },
  ];
  const input = new JunctionInput({ releaseGrace: 0 });
  assert.equal(input.press("w", "gas", options), options[2].edge);
  assert.equal(input.press("a", "left", options), options[1].edge);
  assert.equal(input.release("w"), null);
  assert.equal(input.preview, options[0].edge);
  assert.equal(input.release("a"), options[0].edge, "releasing the main direction switches to the remaining direction");
  input.reset();
  input.press("w", "gas", options);
  assert.equal(input.press("d", "right", options), options[2].edge);
  assert.equal(input.release("d"), null);
  assert.equal(input.release("w"), options[2].edge);
});

test("releasing a side key restores the middle, while releasing the main key switches direction", () => {
  const options = [
    ...fan(),
    { edge: "right", direction: "right", angle: Math.PI / 2 },
    { edge: "left", direction: "left", angle: -Math.PI / 2 },
  ];
  for (const [mainKey, sideKey, sideAction, expectedSide] of [
    ["w", "d", "right", "right"], ["arrowup", "arrowleft", "left", "left"],
  ]) {
    const input = new JunctionInput({ releaseGrace: 0 });
    input.press(mainKey, "gas", options);
    input.press(sideKey, sideAction, options);
    assert.equal(input.release(sideKey), null);
    assert.equal(input.preview, "exit-1");
    input.press(sideKey, sideAction, options);
    assert.equal(input.release(mainKey), null);
    assert.equal(input.preview, expectedSide);
    assert.equal(input.release(sideKey), expectedSide);
    assert.equal(input.release(mainKey), null);
  }
});

test("larger fans cycle through every exit with distinct taps, not key repeat", () => {
  const input = new JunctionInput({ releaseGrace: 0 }), options = fan("straight", 0, 5);
  assert.equal(input.press("w", "gas", options), "exit-2");
  assert.equal(input.press("d", "right", options), "exit-4");
  assert.equal(input.press("d", "right", options), "exit-4");
  input.release("d");
  assert.equal(input.press("d", "right", options), "exit-0");
  input.release("d");
  assert.equal(input.press("d", "right", options), "exit-1");
});

test("single-road directions follow latest input, including opposing keys and aliases", () => {
  const options = [
    { edge: "front", direction: "straight", angle: 0 },
    { edge: "left", direction: "left", angle: -1 },
    { edge: "right", direction: "right", angle: 1 },
    { edge: "back", direction: "uturn", angle: Math.PI },
  ];
  const input = new JunctionInput({ releaseGrace: 0 });
  assert.equal(input.press("w", "gas", options), "front");
  assert.equal(input.press("a", "left", options), "left");
  assert.equal(input.press("d", "right", options), "right");
  assert.equal(input.press("arrowup", "gas", options), "front");
  assert.equal(input.release("arrowup"), null);
  assert.equal(input.preview, "front", "W still holds the same direction as ArrowUp");
  assert.equal(input.press("s", "brake", options), "back");
  input.release("w");
  input.release("a");
  input.release("d");
  assert.equal(input.release("s"), "back");
});

test("latest single direction can enter a locked fan and switch to another fan on main release", () => {
  const options = [
    { edge: "left", direction: "left", angle: -1 },
    ...fan(),
    ...fan("right", Math.PI / 2).map(option => ({ ...option, edge: `right-${option.edge}` })),
  ];
  const input = new JunctionInput({ releaseGrace: 0 });
  assert.equal(input.press("a", "left", options), "left");
  assert.equal(input.press("w", "gas", options), "exit-1");
  input.release("a");
  assert.equal(input.press("d", "right", options), "exit-2");
  assert.equal(input.main, "gas");
  assert.equal(input.release("w"), null);
  assert.equal(input.main, "right");
  assert.equal(input.preview, "right-exit-1");
  assert.equal(input.press("s", "brake", options), "right-exit-2");
  input.release("s");
  assert.equal(input.release("d"), "right-exit-1");
});

test("aliases wait for every physical key, conflicting keys cancel, and blur/reset cannot select", () => {
  const input = new JunctionInput({ releaseGrace: 0 }), options = fan();
  input.press("w", "gas", options);
  input.press("arrowup", "gas", options);
  assert.equal(input.release("w"), null);
  assert.equal(input.release("arrowup"), "exit-1");
  input.press("w", "gas", options);
  assert.equal(input.press("s", "brake", options), null);
  assert.equal(input.release("s"), null);
  assert.equal(input.preview, "exit-1");
  assert.equal(input.release("w"), "exit-1");
  input.press("w", "gas", options);
  input.press("a", "left", options);
  assert.equal(input.press("d", "right", options), null);
  input.reset();
  assert.equal(input.release("w"), null);
  assert.equal(input.release("a"), null);
  assert.equal(input.press("a", "left", options), null, "missing groups must not choose another direction");
});
