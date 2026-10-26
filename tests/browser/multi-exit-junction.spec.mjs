import { test, expect } from "@playwright/test";

test("junctions with three exits offer the GPS-recommended road for selection", async ({ page }) => {
  const exits = [
    { id: "straight", a: "b", b: "c", angle: 0, name: "Straight Road", zh: "直路" },
    { id: "right", a: "b", b: "d", angle: Math.PI / 2, name: "GPS Road", zh: "導航路線" },
    { id: "left", a: "b", b: "e", angle: -Math.PI / 2, name: "Left Road", zh: "左路" },
  ];
  const edges = [
    { id: "in", a: "a", b: "b", way: 1, kind: "residential", length: 60, name: "Approach", zh: "入口", layer: "0" },
    ...exits.map((edge, index) => ({
      ...edge, way: index + 2, kind: "residential", length: 60, layer: "0",
    })),
  ];
  for (const edge of [...edges]) edges.push({ ...edge, id: `~${edge.id}`, a: edge.b, b: edge.a, wrongway: true });
  const map = {
    version: "multi-exit-fixture",
    nodes: { a: [0, 0], b: [60, 0], c: [120, 0], d: [60, 60], e: [60, -60] },
    edges, backdrop: [], bounds: [-100, -100, 200, 200],
    branch_levels: Object.fromEntries(edges.map(edge => [edge.id, [edge.layer, "no", "no"]])),
    driving: { taxi_radius: 2.5, widths: { residential: 10 }, max_speed: 150 / 3.6,
      acceleration: 7, upgraded_acceleration: 9.1 },
  };
  let state = {
    id: "multi-exit", version: map.version, seq: 0, x: 0, y: 0, heading: 0, edge: "in", speed: 0,
    paused: true, elapsed: 0, fuel: 100, money: 120, trips: 0, upgrades: [], phase: "available",
    fare: 60, pickup: "pickup", destination: "destination",
    passenger: { name: "Test rider", zh: "乘客", role: "Fixture", role_zh: "測試" },
    dialogue: "offer", warning: "", route: ["in", "right"], no_route: false, closed: [], traffic: {},
    selected_exit: null, selected_junction: null, service_ready: false, depot_ready: false,
    junction: "b", stacked_choice: false, junction_choice: true,
    options: exits.map(({ id, name, zh, angle }) => ({ edge: id, name, zh, angle, restricted: false })),
  };
  const stops = [
    { id: "pickup", name: "Pickup", zh: "上車", edge: "straight", point: [90, 0] },
    { id: "destination", name: "Destination", zh: "落車", edge: "right", point: [60, 30] },
  ];
  await page.route("**/api/map", route => route.fulfill({ json: map }));
  await page.route("**/api/stops", route => route.fulfill({ json: stops }));
  await page.route("**/api/sessions", route => route.fulfill({ json: state }));
  await page.route("**/api/sessions/multi-exit/commands", async route => {
    const request = route.request().postDataJSON();
    const command = request.command;
    state = { ...state, seq: request.seq };
    if (command.action === "pause") {
      state = { ...state, paused: command.paused,
        speed: command.preserve_speed ? state.speed : 0 };
    } else if (command.action === "move") {
      state = { ...state, x: command.x, y: command.y, heading: command.heading,
        speed: command.speed, elapsed: state.elapsed + command.dt };
    } else if (command.action === "select_road") {
      state = { ...state, selected_exit: command.exit, selected_junction: "b", paused: false,
        dialogue: "selected" };
    } else {
      throw new Error(`Unexpected fixture command: ${command.action}`);
    }
    await route.fulfill({ json: state });
  });

  await page.goto("/");
  await page.locator("#start").click();
  await page.keyboard.down("w");
  await expect(page.locator("#junction")).toBeVisible({ timeout: 10_000 });
  await page.keyboard.up("w");
  const layout = await page.locator("#junction").evaluate(dialog => {
    const bounds = dialog.getBoundingClientRect();
    const backdrop = getComputedStyle(dialog, "::backdrop");
    return {
      right: innerWidth - bounds.right, bottom: innerHeight - bounds.bottom,
      width: bounds.width, height: bounds.height, viewportHeight: innerHeight,
      backdropColor: backdrop.backgroundColor, backdropFilter: backdrop.backdropFilter,
      scrollable: getComputedStyle(dialog).overflowY,
    };
  });
  expect(layout.right).toBeGreaterThanOrEqual(16);
  expect(layout.right).toBeLessThanOrEqual(32);
  expect(layout.bottom).toBeGreaterThanOrEqual(30);
  expect(layout.bottom).toBeLessThanOrEqual(45);
  expect(layout.width).toBeLessThanOrEqual(340);
  expect(layout.height).toBeLessThanOrEqual(layout.viewportHeight * 0.55 + 1);
  expect(layout.backdropColor).toBe("rgba(0, 0, 0, 0)");
  expect(layout.backdropFilter).toBe("none");
  expect(layout.scrollable).toBe("auto");
  await expect(page.locator("#exits .recommended")).toContainText("GPS Road");
  await page.locator("#exits .recommended").click();
  await expect(page.locator("#junction")).not.toBeVisible();
  expect(state.selected_exit).toBe("right");
});
