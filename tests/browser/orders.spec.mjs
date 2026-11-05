import { test, expect } from "@playwright/test";
import { toggleDrivingView, useLegacyInitialView } from "./driving-view.mjs";
test.beforeEach(async ({ page }) => useLegacyInitialView(page));

test("alighting passenger and open door project to the taxi left in the 3D chase camera", async ({ page }) => {
  await page.goto("/");
  const results = await page.evaluate(async () => {
    const [{ Map3DView }, THREE] = await Promise.all([
      import("/map3d.mjs?v=parabolic-steering-1"), import("/vendor/three/three.module.min.js"),
    ]);
    const view = Object.assign(Object.create(Map3DView.prototype), {
      data: { driving: { taxi_width: 1.7 } },
      nodes: { a: [-100, 0], b: [100, 0] },
      edges: new Map([["road", { id: "road", a: "a", b: "b" }]]),
      stops: [], scene: new THREE.Scene(), taxi: new THREE.Group(), resources: [],
    });
    view.buildCitizens();
    try {
      return [0, Math.PI / 2, Math.PI, -Math.PI / 2].map(heading => {
        const car = { x: 0, y: 0, heading, edge: "road" };
        const forward = new THREE.Vector3(Math.cos(heading), 0, Math.sin(heading));
        const camera = new THREE.PerspectiveCamera(60, 1, .1, 100);
        camera.position.copy(forward).multiplyScalar(-20).add(new THREE.Vector3(0, 12, 0));
        camera.lookAt(forward.clone().multiplyScalar(10));
        camera.updateMatrixWorld();
        view.taxi.rotation.y = -heading;
        view.updateCitizens({ citizens: [], elapsed: 1.2,
          boarding: { point: [Math.sin(heading) * 6, -Math.cos(heading) * 6],
            starts: 0, ends: 2, alighting: true } }, car);
        view.taxi.updateMatrixWorld(true);
        const centre = new THREE.Vector3(0, 1, 0).project(camera).x;
        const door = view.door.getWorldPosition(new THREE.Vector3()).project(camera).x;
        const passenger = view.people.find(person => person.id === "alighting")
          .group.position.clone().project(camera).x;
        return { doorLeft: door < centre, passengerLeft: passenger < centre };
      });
    } finally {
      for (const resource of view.resources) resource.dispose();
      view.door.geometry.dispose();
      view.door.material.dispose();
    }
  });
  for (const result of results) {
    expect(result.doorLeft).toBe(true);
    expect(result.passengerLeft).toBe(true);
  }
});

test("citizens and passengers stand on their road level after elevation is enabled", async ({ page }) => {
  await page.goto("/");
  const heights = await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=parabolic-steering-1");
    const THREE = await import("/vendor/three/three.module.min.js");
    const ground = { id: "ground", a: "a", b: "b" };
    const bridge = { id: "bridge", a: "c", b: "d" };
    const view = Object.assign(Object.create(Map3DView.prototype), {
      data: { driving: { taxi_width: 1.7 } },
      nodes: { a: [0, 0], b: [100, 0], c: [0, 0], d: [100, 0] },
      edges: new Map([["ground", ground], ["bridge", bridge]]),
      stops: [{ id: "pickup", edge: "ground" }],
      elevation: { node_heights: { a: 10, b: 20, c: 40, d: 50 } },
      scene: new THREE.Scene(), taxi: new THREE.Group(), resources: [],
    });
    view.buildCitizens();
    const car = { x: 50, y: 0, heading: 0, edge: "bridge" };
    const state = {
      elapsed: 0, pickup: "pickup", customer: [50, 6],
      citizens: [
        { id: "walker", point: [25, 6], edge: "ground", hailing: false },
        { id: "hailing", point: [75, 6], edge: "bridge", hailing: true },
      ],
      boarding: { point: [50, 6], starts: 0, ends: 2 },
    };
    const sample = () => view.people.map(person => person.group.position.y);
    view.updateCitizens(state, car);
    const elevated = sample();
    state.elapsed = 1;
    state.boarding.alighting = true;
    view.updateCitizens(state, car);
    const alighting = sample();
    view.elevation = null;
    view.updateCitizens(state, car);
    const legacy = sample();
    for (const resource of view.resources) resource.dispose();
    view.door.geometry.dispose();
    view.door.material.dispose();
    return { elevated, alighting, legacy };
  });
  for (const kind of ["elevated", "alighting"]) {
    for (const [index, height] of [12.6, 47.6, 15.1, 45.1].entries()) {
      expect(heights[kind][index]).toBeCloseTo(height, 6);
    }
  }
  expect(heights.legacy).toEqual([0, 0, 0, 0]);
});

async function dispatchFixture(page, moveDelay = 0, exhaustFuel = false) {
  const passenger = { name: "Mei", zh: "阿美", role: "Photographer", role_zh: "攝影師",
    pickup: "Thanks!", pickup_zh: "唔該！", arrival: "Here!", arrival_zh: "到喇！" };
  const edge = { id: "road", a: "a", b: "b", way: 1, kind: "residential", length: 300,
    name: "Test Street", zh: "測試街", layer: "0", bridge: "no", tunnel: "no" };
  const map = { version: "orders", nodes: { a: [0, 0], b: [300, 0] },
    edges: [edge, { ...edge, id: "~road", a: "b", b: "a" }], backdrop: [],
    bounds: [-150, -150, 450, 150], restrictions: [],
    driving: { taxi_length: 4.8, taxi_width: 2, taxi_radius: 2.5, widths: { residential: 12 },
      max_speed: 150 / 3.6, acceleration: 7, upgraded_acceleration: 9.1 } };
  const stops = [
    { id: "pickup", name: "Test Street pickup", zh: "測試街上車", edge: "road", point: [50, 0] },
    { id: "dest", name: "Test Street destination", zh: "測試街落車", edge: "road", point: [200, 0] },
    { id: "depot", name: "Rest stop", zh: "休息站", edge: "road", point: [20, 0] },
  ];
  const order = id => ({ id, pickup: "pickup", destination: "dest", passenger, fare: 60,
    source: "phone", distance: 0 });
  let state = {
    id: "orders", version: "orders", seq: 0, x: 50, y: 0, heading: 0, edge: "road", speed: 0,
    paused: true, elapsed: 0, fuel: 100, money: 120, trips: 0, upgrades: [], phase: "available",
    pickup: "pickup", destination: "dest", fare: 60, passenger, dialogue: "offer",
    warning: "", route: null, no_route: false, closed: [], traffic: {}, options: [],
    selected_exit: null, selected_junction: null, service_ready: true, depot_ready: false,
    offers: Array.from({ length: 8 }, (_, index) => order(`offer-${index}`)), accepted_orders: [],
    can_accept: true, boarding: null, cancelled_orders: 0, order_source: null, active_order: null,
    citizens: [{ id: "citizen", point: [55, 6], hailing: true, ready: true }],
  };
  const commands = [];
  let expire = false;
  let exhausted = false;
  await page.route("**/api/map*", route => route.fulfill({ json: map }));
  await page.route("**/api/stops", route => route.fulfill({ json: stops }));
  await page.route("**/api/sessions", route => route.fulfill({ json: state }));
  await page.route("**/api/sessions/orders/commands", async route => {
    const body = route.request().postDataJSON(), command = body.command;
    commands.push(command);
    state = { ...state, seq: body.seq };
    if (command.action === "pause") state.paused = command.paused;
    else if (command.action === "move") {
      if (exhausted && (Math.hypot(command.x - state.x, command.y - state.y) > .01
          || command.trail.some(point => Math.hypot(point.x - state.x, point.y - state.y) > .01))) {
        await route.fulfill({ status: 409, json: { detail: "Out of fuel. Call recovery." } });
        return;
      }
      state.elapsed += command.dt;
      state.x = command.x; state.y = command.y; state.speed = command.speed;
      if (exhaustFuel && command.speed > 0) {
        state.fuel = 0; state.speed = 0;
        exhausted = true;
      }
      if (expire) state.offers = [];
      if (state.boarding && state.elapsed >= state.boarding.ends) {
        if (!state.boarding.alighting) {
          state.phase = "onboard"; state.destination = "dest"; state.dialogue = "pickup";
        }
        state.boarding = null;
      }
    } else if (command.action === "accept") {
      const chosen = state.offers.find(item => item.id === command.order);
      state.offers = state.offers.filter(item => item.id !== command.order);
      state.accepted_orders.push(chosen);
      if (state.phase !== "onboard") {
        state.phase = "pickup"; state.order_source = "phone"; state.active_order = chosen.id;
        state.customer = [50, 7];
      }
    } else if (command.action === "service") {
      if (state.phase === "pickup") {
        state.phase = "boarding"; state.accepted_orders.shift(); state.dialogue = "boarding";
        state.boarding = { point: state.customer, starts: state.elapsed, ends: state.elapsed + 1.8 };
        state.customer = null;
      } else {
        state.phase = "complete"; state.trips += 1; state.money += 60;
        state.boarding = { point: [200, 7], starts: state.elapsed, ends: state.elapsed + 1.8, alighting: true };
      }
    } else if (command.action === "next") {
      state.phase = state.accepted_orders.length ? "pickup" : "available";
      state.active_order = state.accepted_orders[0]?.id ?? null;
    } else if (command.action === "door") {
      state.phase = "boarding"; state.order_source = "street"; state.active_order = "street";
      state.boarding = { point: [55, 6], starts: state.elapsed, ends: state.elapsed + 1.8 };
      state.destination = ""; state.citizens = []; state.dialogue = "boarding";
    } else throw new Error(`Unexpected command ${command.action}`);
    state.can_accept = !["pickup", "boarding"].includes(state.phase) && !state.accepted_orders.length;
    if (command.action === "move" && moveDelay) await new Promise(resolve => setTimeout(resolve, moveDelay));
    await route.fulfill({ json: state });
  });
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await page.locator("#start").click();
  await expect(page.locator("#welcome")).not.toBeVisible();
  return { commands, get state() { return state; }, expireOffers() { expire = true; } };
}

test("fuel exhaustion during an onboard trip discards buffered movement without a crash", async ({ page }) => {
  const fixture = await dispatchFixture(page, 400, true);
  fixture.state.phase = "onboard";
  fixture.state.service_ready = false;
  fixture.state.order_source = "phone";
  fixture.state.active_order = "passenger";
  await page.keyboard.down("w");
  await expect(page.locator("#fuel")).toHaveText("0%");
  await expect.poll(() => fixture.commands.filter(command => command.action === "move").length).toBeGreaterThan(4);
  await page.keyboard.up("w");
  await expect(page.locator("#error-dialog")).not.toBeVisible();
  await expect(page.locator("#speed")).toHaveText("0");
  expect(fixture.state.phase).toBe("onboard");
  expect(fixture.state.active_order).toBe("passenger");
  const moves = fixture.commands.filter(command => command.action === "move");
  const exhausted = moves.findIndex(command => command.speed > 0);
  expect(exhausted).toBeGreaterThanOrEqual(0);
  for (const command of moves.slice(exhausted + 1)) {
    expect(command.x).toBe(moves[exhausted].x);
    expect(command.y).toBe(moves[exhausted].y);
    expect(command.speed).toBe(0);
  }
});

test("phone slides from the edge, counts uncapped offers, keeps keyboard focus, and hides expired offers", async ({ page }) => {
  const fixture = await dispatchFixture(page);
  const toggle = page.locator("#phone-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#phone-count")).toHaveText("8");
  const rect = await toggle.boundingBox();
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".order-card")).toHaveCount(8);
  await expect(page.locator("#available-orders")).not.toContainText(/seconds|expires|remaining/i);
  const accept = page.locator(".order-accept").first();
  await accept.focus();
  await page.waitForTimeout(650);
  await expect(accept).toBeFocused();
  await page.locator("#accepted-tab").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("#available-tab")).toBeFocused();
  fixture.expireOffers();
  await expect(page.locator("#phone-count")).toHaveText("0");
  await expect(page.locator("#no-offers")).toBeVisible();
  await page.locator("#phone-close").click();
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(fixture.state.elapsed).toBeGreaterThan(0);
  expect(fixture.commands.filter(command => command.action === "pause" && command.paused)).toHaveLength(0);
});

test("phone pickups are automatic and one waiting order is stored on Accepted", async ({ page }) => {
  const fixture = await dispatchFixture(page);
  await page.locator("#phone-toggle").click();
  await page.locator(".order-accept").first().click();
  await expect.poll(() => fixture.state.phase).toBe("boarding");
  await expect(page.locator("#boarding-status")).toBeVisible();
  await expect.poll(() => fixture.state.phase).toBe("onboard");
  await expect(page.locator("#accepted-tab")).toHaveAttribute("aria-selected", "true");
  expect(fixture.commands.some(command => command.action === "service")).toBe(true);
  expect(fixture.commands.some(command => command.action === "door")).toBe(false);
  await page.locator("#available-tab").click();
  await page.locator("#available-orders .order-accept").first().click();
  await expect(page.locator("#accepted-orders .order-card")).toHaveCount(1);
  await page.locator("#available-tab").click();
  await expect(page.locator("#available-orders .order-accept").first()).toBeDisabled();
});

test("E drops off the passenger at the destination", async ({ page }) => {
  const fixture = await dispatchFixture(page);
  await page.locator("#phone-toggle").click();
  await page.locator(".order-accept").first().click();
  await expect.poll(() => fixture.state.phase).toBe("onboard");
  await expect(page.locator("#street-dropoff")).toBeEnabled();
  await page.keyboard.press("e");
  await expect.poll(() => fixture.state.phase).toBe("complete");
  expect(fixture.state.trips).toBe(1);
  expect(fixture.state.boarding?.alighting).toBe(true);
  await expect.poll(() => fixture.state.boarding).toBeNull();
});

test("Tab toggles the phone while Shift+Tab keeps focus navigation", async ({ page }) => {
  await dispatchFixture(page);
  const toggle = page.locator("#phone-toggle");
  await page.keyboard.press("Tab");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#available-tab")).toHaveAttribute("aria-selected", "true");
  await page.locator("#accepted-tab").click();
  await page.keyboard.press("Tab");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Tab");
  await expect(page.locator("#available-tab")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#phone-available")).toBeVisible();
  await expect(page.locator("#phone-accepted")).toBeHidden();
  await page.locator("#accepted-tab").click();
  await page.locator("#phone-close").click();
  await toggle.click();
  await expect(page.locator("#available-tab")).toHaveAttribute("aria-selected", "true");
  await page.locator("#phone-close").click();
  await page.keyboard.press("Shift+Tab");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("only normal empty-taxi 3D view reports visible walkers for hailing", async ({ page }) => {
  const fixture = await dispatchFixture(page);
  fixture.state.citizens = [{
    id: "visible-walker", point: [65, 7], edge: "road", hailing: false, ready: false,
    motion: { points: [[65, 7], [70, 7]], distance: 0, direction: 1, speed: 1, seeking_curb: false },
  }];
  fixture.state.citizens_at = 0;
  await expect.poll(() => fixture.commands.filter(command => command.action === "move").length).toBeGreaterThan(1);
  expect(fixture.commands.filter(command => command.action === "move")
    .every(command => command.visible_citizens.length === 0)).toBe(true);
  await toggleDrivingView(page);
  await expect(page.locator("#map-3d")).toBeVisible();
  await expect.poll(() => fixture.commands.some(command =>
    command.visible_citizens?.includes("visible-walker"))).toBe(true);
  await page.locator("#overview").click();
  fixture.commands.length = 0;
  await expect.poll(() => fixture.commands.filter(command => command.action === "move").length).toBeGreaterThan(1);
  expect(fixture.commands.filter(command => command.action === "move")
    .every(command => command.visible_citizens.length === 0)).toBe(true);
});

test("passenger animation never rewinds while movement acknowledgements are delayed", async ({ page }) => {
  const fixture = await dispatchFixture(page, 350);
  await page.evaluate(async () => {
    const { MapView } = await import("/map.mjs?v=parabolic-steering-1");
    const render = MapView.prototype.render;
    window.passengerTimes = [];
    MapView.prototype.render = function (car, state, ...rest) {
      if (state.boarding) window.passengerTimes.push(state.elapsed);
      return render.call(this, car, state, ...rest);
    };
  });
  await page.waitForRequest(request => request.url().endsWith("/commands")
    && request.postDataJSON()?.command?.action === "move");
  await page.locator("#door").click();
  await expect.poll(() => fixture.state.phase).toBe("onboard");
  expect(fixture.commands.filter(command => command.action === "door")).toHaveLength(1);
  const times = await page.evaluate(() => window.passengerTimes);
  expect(times.length).toBeGreaterThan(30);
  for (let i = 1; i < times.length; i++) {
    expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(0);
    expect(times[i] - times[i - 1]).toBeLessThan(.15);
  }
});

for (const mode of ["2D", "3D"]) {
  test(`street door boards visibly in ${mode}, hides destination, and freezes driving`, async ({ page }) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const fixture = await dispatchFixture(page);
    if (mode === "3D") {
      await toggleDrivingView(page);
      await expect(page.locator("#map-3d")).toBeVisible();
    }
    const path = mode === "3D" ? "map3d.mjs" : "map.mjs";
    await page.evaluate(async path => {
      const module = await import(`/${path}?v=parabolic-steering-1`);
      const View = module.Map3DView ?? module.MapView;
      const render = View.prototype.render;
      View.prototype.render = function (car, state, ...rest) {
        if (state.boarding) window.boardingFrames = (window.boardingFrames ?? 0) + 1;
        return render.call(this, car, state, ...rest);
      };
    }, path);
    await expect(page.locator("#door")).toBeEnabled();
    await page.locator("#door").click();
    await expect(page.locator("#boarding-status")).toBeVisible();
    await page.locator("#phone-toggle").click();
    await page.locator("#accepted-tab").click();
    await expect(page.locator("#destination-name")).toHaveText("Revealed after boarding");
    const origin = fixture.state.x;
    await page.keyboard.down("w");
    await page.waitForTimeout(350);
    await page.keyboard.up("w");
    expect(fixture.state.x).toBe(origin);
    await expect.poll(() => fixture.state.phase).toBe("onboard");
    await expect(page.locator("#boarding-status")).toBeHidden();
    await expect(page.locator("#destination-name")).toHaveText("Test Street destination");
    expect(await page.evaluate(() => window.boardingFrames)).toBeGreaterThan(1);
    expect(fixture.commands.filter(command => command.action === "door")).toHaveLength(1);
    expect(errors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath(`street-${mode}.png`) });
  });
}

test("touch swipe opens and closes the phone without triggering an order", async ({ page }) => {
  const fixture = await dispatchFixture(page);
  const cdp = await page.context().newCDPSession(page);
  const swipe = async (selector, direction) => {
    const box = await page.locator(selector).boundingBox();
    const x = box.x + box.width / 2, y = box.y + Math.min(box.height / 2, 20);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let step = 1; step <= 4; step++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove",
        touchPoints: [{ x: x + direction * step * 25, y }] });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  await swipe("#phone-toggle", -1);
  await expect(page.locator("#phone-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#phone")).toHaveCSS("transform", "matrix(1, 0, 0, 1, -12, 0)");
  await swipe(".phone-speaker", 1);
  await expect(page.locator("#phone-toggle")).toHaveAttribute("aria-expanded", "false");
  expect(fixture.commands.some(command => command.action === "accept")).toBe(false);
  await cdp.detach();
});
