import { test, expect } from "@playwright/test";

// A small deterministic map isolates stacked-fork UI from changing OSM geometry.
test("stacked selection previews the exit and waits until arrival to snap", async ({ page }, testInfo) => {
  const commands = [];
  const edges = [
    { id: "in", a: "a", b: "b", way: 1, kind: "residential", length: 60, name: "Approach", zh: "入口", layer: "0" },
    { id: "upper", a: "b", b: "c", way: 2, kind: "residential", length: 60, name: "Flyover", zh: "天橋", layer: "1" },
    { id: "surface", a: "b", b: "d", way: 3, kind: "residential", length: 60, name: "Surface street", zh: "地面街道", layer: "0" },
  ];
  for (const edge of [...edges]) edges.push({ ...edge, id: `~${edge.id}`, a: edge.b, b: edge.a, wrongway: true });
  const map = {
    version: "fixture", nodes: { a: [0, 0], b: [60, 0], c: [120, 0], d: [60, 60] },
    edges, backdrop: [], bounds: [-100, -100, 200, 200],
    branch_levels: Object.fromEntries(edges.map(e => [e.id, [e.layer, "no", "no"]])),
    driving: { taxi_radius: 2.5, widths: { residential: 10 },
      max_speed: 150 / 3.6, acceleration: 7, upgraded_acceleration: 9.1 },
  };
  let state = {
    id: "fixture", version: "fixture", seq: 0, x: 0, y: 0, heading: 0, edge: "in", speed: 0,
    paused: true, elapsed: 0, fuel: 100, money: 120, trips: 0, upgrades: [], phase: "available",
    fare: 60, pickup: "pickup", destination: "dest", passenger: { name: "Test rider", zh: "乘客", role: "Fixture", role_zh: "測試" },
    dialogue: "offer", warning: "", route: ["in", "upper"], no_route: false, closed: [], traffic: {},
    selected_exit: null, selected_junction: null, service_ready: false, depot_ready: false, junction: "b",
    stacked_choice: true, junction_choice: true,
    options: [
      { edge: "upper", name: "Flyover", zh: "天橋", angle: 0 },
      { edge: "surface", name: "Surface street", zh: "地面街道", angle: Math.PI / 2 },
    ],
  };
  const stops = [
    { id: "pickup", name: "Pickup", zh: "上車", edge: "upper", point: [90, 0] },
    { id: "dest", name: "Destination", zh: "落車", edge: "surface", point: [60, 30] },
  ];
  await page.route("**/api/map", route => route.fulfill({ json: map }));
  await page.route("**/api/stops", route => route.fulfill({ json: stops }));
  await page.route("**/api/sessions", route => route.fulfill({ json: state }));
  await page.route("**/api/sessions/fixture/commands", async route => {
    const body = route.request().postDataJSON(), command = body.command;
    commands.push(command);
    state = { ...state, seq: body.seq };
    if (command.action === "move") {
      const enteredSelectedRoad = command.y > 0;
      state = { ...state, x: command.x, y: command.y, heading: command.heading,
        speed: command.speed, elapsed: state.elapsed + command.dt,
        edge: enteredSelectedRoad ? "surface" : state.edge,
        selected_exit: enteredSelectedRoad ? null : state.selected_exit,
        selected_junction: enteredSelectedRoad ? null : state.selected_junction };
    } else if (command.action === "pause") state = {
      ...state, paused: command.paused, speed: command.preserve_speed ? state.speed : 0,
    };
    else if (command.action === "select_road") state = {
      ...state,
      paused: false, selected_exit: command.exit, selected_junction: "b", dialogue: "selected",
    };
    else throw new Error(`Unexpected fixture command: ${command.action}`);
    await route.fulfill({ json: state });
  });
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await page.evaluate(async () => {
    const { MapView } = await import("/map.mjs");
    const render = MapView.prototype.render, highlight = MapView.prototype.highlightExit;
    MapView.prototype.render = function (...args) {
      window.renderedCar = { ...args[0] };
      window.exitHighlights = [];
      return render.apply(this, args);
    };
    MapView.prototype.highlightExit = function (context, edge, color, zoom, path) {
      window.exitHighlights.push({ edge: edge.id, color, start: path?.start, segments: path?.edges.map(e => e.id) });
      return highlight.call(this, context, edge, color, zoom, path);
    };
  });
  await page.locator("#start").click();
  await expect(page.locator("#welcome")).not.toBeVisible();
  await expect.poll(() => page.evaluate(() => window.exitHighlights.some(h =>
    h.edge === "in" && h.color === "#92d7b6" && h.start.x === 0 && h.segments[0] === "in"))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.exitHighlights.some(h =>
    h.edge === "upper" && h.color === "#f5c65a" && h.segments[0] === "upper"))).toBe(true);
  await page.keyboard.down("w");
  await expect.poll(() => page.evaluate(() => window.exitHighlights.some(h => h.edge === "upper"))).toBe(true);
  expect(state.x).toBeLessThan(36);
  await expect(page.locator("#junction")).not.toBeVisible();
  await expect(page.locator("#junction")).toBeVisible();
  await page.keyboard.up("w");
  const clock = state.elapsed;
  await page.waitForTimeout(500);
  expect(state.elapsed).toBe(clock);
  const approachSpeed = state.speed;
  const commandCount = commands.length;
  const rightOption = page.getByRole("button", { name: /Turn right/ });
  const straightOption = page.getByRole("button", { name: /Straight/ });
  await rightOption.hover();
  await expect.poll(() => page.evaluate(() => window.exitHighlights
    .filter(h => h.color === "#55e9ff").map(h => h.edge))).toEqual(["surface"]);
  expect(await page.evaluate(() => window.exitHighlights.find(h =>
    h.edge === "surface" && h.color === "#55e9ff").segments)).toEqual(["surface"]);
  await straightOption.hover();
  await expect.poll(() => page.evaluate(() => window.exitHighlights
    .filter(h => h.color === "#55e9ff").map(h => h.edge))).toEqual(["upper"]);
  await page.mouse.move(0, 0);
  await straightOption.evaluate(button => button.blur());
  await expect.poll(() => page.evaluate(() => window.exitHighlights.some(h =>
    h.color === "#55e9ff"))).toBe(false);
  await rightOption.focus();
  await expect.poll(() => page.evaluate(() => window.exitHighlights
    .filter(h => h.color === "#55e9ff").map(h => h.edge))).toEqual(["surface"]);
  expect(commands.length).toBe(commandCount);
  expect(state.edge).toBe("in");
  expect(state.elapsed).toBe(clock);
  const approachX = state.x;
  await page.getByRole("button", { name: /Turn right/ }).click();
  await expect(page.locator("#junction")).not.toBeVisible();
  await expect(page.locator("#drive-mode")).toHaveText("MANUAL");
  expect(state.selected_exit).toBe("surface");
  expect(state.speed).toBe(approachSpeed);
  expect(state.x).toBe(approachX);
  expect(state.y).toBe(0);
  expect(state.heading).toBe(0);
  expect(state.elapsed).toBe(clock);
  expect(await page.evaluate(() => window.renderedCar.x)).toBeLessThan(60);
  expect(await page.evaluate(() => window.renderedCar.heading)).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("selected-road.png") });
  expect(commands.some(c => ["turn", "assist_done"].includes(c.action))).toBe(false);
  await page.keyboard.down("w");
  await expect.poll(() => commands.some(c => c.action === "move" &&
    c.x > approachX && c.x < 60 && c.y === 0 && c.heading === 0)).toBe(true);
  await expect.poll(() => commands.some(c => c.action === "move" && c.y >= 2)).toBe(true);
  await page.keyboard.up("w");
  const firstMove = commands.find(c => c.action === "move" && c.y >= 2);
  expect(commands.filter(c => c.action === "move").some(c =>
    c.trail.some(p => p.x === 60 && p.y === 0))).toBe(true);
  expect(firstMove.trail.filter(p => p.y > 0).every(p =>
    p.x === 60 && p.heading === Math.PI / 2)).toBe(true);
  expect(state.edge).toBe("surface");
  expect(state.y).toBeGreaterThan(2);
  expect(state.selected_exit).toBeNull();
  await expect.poll(() => page.evaluate(() => window.exitHighlights.some(h => h.color === "#55e9ff"))).toBe(false);
  await expect(page.locator("#error-dialog")).not.toBeVisible();
  await expect(page.locator("#junction")).not.toBeVisible();
});
