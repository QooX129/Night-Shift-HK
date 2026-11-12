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

async function dispatchFixture(page, moveDelay = 0, exhaustFuel = false, guideRoute = false) {
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
  if (guideRoute) {
    map.nodes.c = [600, 0];
    map.edges.push({ ...edge, id: "next", a: "b", b: "c", way: 2 },
      { ...edge, id: "~next", a: "c", b: "b", way: 2 });
    stops[1].edge = "next";
    stops[1].point = [350, 0];
  }
  const order = id => ({ id, pickup: "pickup", destination: "dest", passenger, fare: 60,
    source: "phone", distance: 0 });
  let state = {
    id: "orders", version: "orders", seq: 0, x: 50, y: 0, heading: 0, edge: "road", speed: 0,
    paused: true, elapsed: 0, fuel: 100, money: 120, trips: 0, upgrades: [], phase: "available",
    pickup: "pickup", destination: "dest", fare: 60, meter: null, passenger, dialogue: "offer",
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
    state.route = ["pickup", "onboard"].includes(state.phase) ? (guideRoute ? ["road", "next"] : ["road"]) : null;
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

test("dashboard shows the live meter, speed, wallet and garage icon on desktop and phone", async ({ page }, testInfo) => {
  const fixture = await dispatchFixture(page);
  await expect(page.locator("#meter-status")).toHaveText("VACANT");
  await page.locator("#phone-toggle").click();
  await expect(page.locator(".order-fare").first()).toHaveText("Estimated fare · HK$ 60.0");
  await page.locator("#phone-close").click();
  await expect(page.locator("#phone-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => page.locator("#game").evaluate(game => game.scrollLeft)).toBe(0);
  fixture.state.phase = "onboard";
  fixture.state.meter = 29;
  fixture.state.fare = 34;
  fixture.state.order_source = "phone";
  fixture.state.active_order = "passenger";
  fixture.state.service_ready = false;
  await page.keyboard.down("w");
  await expect(page.locator("#meter-digits")).toHaveAttribute("aria-label", "TAXI METER HK$ 29.0");
  await expect(page.locator("#meter-status")).toHaveText("HIRED");
  fixture.state.meter = 31.1;
  fixture.state.fare = 36.1;
  fixture.state.money = 120.1;
  await expect(page.locator("#meter-digits")).toHaveAttribute("aria-label", "TAXI METER HK$ 31.1");
  await expect(page.locator("#money")).toHaveText("$120.1");
  await expect(page.locator("#garage")).toHaveAttribute("aria-label", "Rest stop / garage");
  await page.locator("#phone-toggle").click();
  await page.locator("#accepted-tab").click();
  await expect(page.locator("#fare")).toHaveText("HK$ 36.1");
  await expect(page.locator("#fare-label")).toHaveText("Includes $5 phone booking");
  await page.locator("#phone-close").click();
  await expect.poll(async () => page.locator("#speed-needle").getAttribute("transform"))
    .not.toBe("rotate(-90 60 60)");
  await page.keyboard.up("w");
  await page.screenshot({ path: testInfo.outputPath("dashboard-desktop.png") });
  fixture.state.meter = 102.5;
  await expect(page.locator("#meter-digits")).toHaveAttribute("aria-label", "TAXI METER HK$ 102.5");
  await page.setViewportSize({ width: 320, height: 720 });
  const boxes = await page.locator(".dashboard").evaluate(dashboard => {
    const box = element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    };
    return [dashboard, ...[...dashboard.children].filter(child => !child.matches(".pickup-controls"))].map(box);
  });
  for (const box of boxes.slice(1)) {
    expect(box.left).toBeGreaterThanOrEqual(boxes[0].left);
    expect(box.right).toBeLessThanOrEqual(boxes[0].right);
  }
  const meterBounds = await page.locator(".taxi-meter").evaluate(meter => ({
    right: meter.getBoundingClientRect().right,
    digitsRight: meter.querySelector("#meter-digits").getBoundingClientRect().right,
  }));
  expect(meterBounds.digitsRight).toBeLessThanOrEqual(meterBounds.right);
  const controls = await page.locator(".pickup-controls").boundingBox();
  expect(controls.y + controls.height).toBeLessThanOrEqual(boxes[0].top);
  await expect(page.locator("#clock")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("dashboard-phone.png") });
  fixture.state.phase = "complete";
  await expect(page.locator("#meter-status")).toHaveText("PAID");
  await page.locator("#phone-toggle").click();
  await page.locator("#accepted-tab").click();
  await expect(page.locator("#fare-label")).toHaveText("Final fare · Includes $5 phone booking");
});

test("speed reading and pickup controls stay aligned with the dashboard", async ({ page }) => {
  await dispatchFixture(page);
  for (const size of [
    { width: 1280, height: 720 },
    { width: 800, height: 720 },
    { width: 390, height: 844 },
    { width: 320, height: 720 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(size);
    for (const language of ["en", "zh"]) {
      if (language === "zh") await page.locator("#language").click();
      const positions = await page.locator(".dashboard").evaluate(dashboard => {
        const speed = dashboard.querySelector("#speed");
        const previousSpeed = speed.textContent;
        speed.textContent = "160";
        const rect = selector => dashboard.querySelector(selector).getBoundingClientRect().toJSON();
        const positions = { dashboard: dashboard.getBoundingClientRect().toJSON(),
          dial: rect(".speed-dial"), reading: rect(".speed-reading"), door: rect("#door") };
        speed.textContent = previousSpeed;
        return positions;
      });
      expect(positions.door.bottom).toBeLessThanOrEqual(positions.dashboard.top - 8);
      expect(positions.door.right).toBeLessThanOrEqual(positions.dashboard.right);
      expect(positions.reading.left).toBeGreaterThanOrEqual(positions.dial.right);
      expect(positions.reading.right).toBeLessThanOrEqual(positions.dashboard.right);
      expect(Math.abs((positions.dashboard.left + positions.dashboard.right) / 2 - size.width / 2)).toBeLessThanOrEqual(1);
      if (size.width === 1280) expect(positions.dial.width).toBeGreaterThan(112);
      if (size.width === 320) expect(positions.dial.width).toBeGreaterThan(78);
    }
    await page.locator("#language").click();
  }
  await toggleDrivingView(page);
  await expect(page.locator("#view-status")).toBeHidden();
  const dashboard = await page.locator(".dashboard").boundingBox();
  const door = await page.locator("#door").boundingBox();
  expect(door.y + door.height).toBeLessThanOrEqual(dashboard.y - 8);
  await page.setViewportSize({ width: 320, height: 720 });
  const mobileDoor = await page.locator("#door").boundingBox();
  const minimap = await page.locator("#minimap-panel").boundingBox();
  expect(minimap.y + minimap.height).toBeLessThanOrEqual(mobileDoor.y);
});

test("speed dial stays still and the reading aligns with its bottom as speed changes", async ({ page }) => {
  await page.goto("/");
  for (const size of [{ width: 1280, height: 720 }, { width: 390, height: 844 }, { width: 320, height: 720 }]) {
    await page.setViewportSize(size);
    const measurements = await page.locator(".speed-display").evaluate(display => {
      const dial = display.querySelector(".speed-dial");
      const reading = display.querySelector(".speed-reading");
      const speed = display.querySelector("#speed");
      return ["0", "1", "8", "99", "100", "160"].map(value => {
        speed.textContent = value;
        const displayRect = display.getBoundingClientRect();
        const dialRect = dial.getBoundingClientRect();
        const readingRect = reading.getBoundingClientRect();
        return { value, left: dialRect.left, width: dialRect.width,
          displayLeft: displayRect.left, dialBottom: dialRect.bottom, readingBottom: readingRect.bottom,
          readingRight: readingRect.right, speedRight: speed.getBoundingClientRect().right };
      });
    });
    for (const measurement of measurements) {
      expect(measurement.left, measurement.value).toBeCloseTo(measurements[0].left, 2);
      expect(measurement.left, measurement.value).toBeCloseTo(measurement.displayLeft, 2);
      expect(measurement.width, measurement.value).toBeCloseTo(measurements[0].width, 2);
      expect(measurement.readingBottom, measurement.value).toBeCloseTo(measurement.dialBottom, 2);
      expect(measurement.speedRight, measurement.value).toBeLessThanOrEqual(measurement.readingRight);
    }
  }
});

test("reverse and fuel are centered below the dial, not the speed reading", async ({ page }) => {
  await page.goto("/");
  for (const size of [{ width: 1280, height: 720 }, { width: 390, height: 844 }, { width: 320, height: 720 }]) {
    await page.setViewportSize(size);
    for (const [text, fuelLabel] of [["REVERSE", "FUEL"], ["倒車", "油量"]]) {
      const positions = await page.locator(".speed").evaluate((container, [text, fuelLabel]) => {
        const indicator = container.querySelector("#drive-mode");
        indicator.textContent = text;
        indicator.hidden = false;
        const fuel = container.querySelector(".fuel-stat");
        fuel.firstElementChild.textContent = fuelLabel;
        return ["0", "160"].flatMap(speed => ["0%", "100%"].map(amount => {
          container.querySelector("#speed").textContent = speed;
          fuel.lastElementChild.textContent = amount;
          const dial = container.querySelector(".speed-dial").getBoundingClientRect();
          const reverse = indicator.getBoundingClientRect();
          const first = fuel.firstElementChild.getBoundingClientRect();
          const last = fuel.lastElementChild.getBoundingClientRect();
          return { dial: (dial.left + dial.right) / 2, reverse: (reverse.left + reverse.right) / 2,
            fuel: (first.left + last.right) / 2, dialLeft: dial.left, dialRight: dial.right,
            fuelLeft: first.left, fuelRight: last.right };
        }));
      }, [text, fuelLabel]);
      for (const position of positions) {
        expect(position.reverse, text).toBeCloseTo(position.dial, 1);
        expect(position.fuel, text).toBeCloseTo(position.dial, 1);
        expect(position.fuelLeft, text).toBeGreaterThanOrEqual(position.dialLeft - 1);
        expect(position.fuelRight, text).toBeLessThanOrEqual(position.dialRight + 1);
      }
    }
  }
});

test("reverse indicator does not move the dashboard or speedometer", async ({ page }) => {
  await page.goto("/");
  for (const size of [
    { width: 1280, height: 720 }, { width: 390, height: 844 },
    { width: 320, height: 720 }, { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(size);
    for (const text of ["REVERSE", "倒車"]) {
      const positions = await page.locator(".dashboard").evaluate((dashboard, text) => {
        const indicator = dashboard.querySelector("#drive-mode");
        indicator.textContent = text;
        const measure = () => [dashboard, dashboard.querySelector(".speed-dial"),
          dashboard.querySelector(".fuel-stat")].map(element => {
          const rect = element.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom, height: rect.height };
        });
        indicator.hidden = true;
        const before = measure();
        indicator.hidden = false;
        const visible = measure();
        indicator.hidden = true;
        return { before, visible, after: measure() };
      }, text);
      expect(positions.visible).toEqual(positions.before);
      expect(positions.after).toEqual(positions.before);
    }
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await dispatchFixture(page);
  const dashboardBefore = await page.locator(".dashboard").boundingBox();
  await expect(page.locator("#drive-mode")).toBeHidden();
  await page.keyboard.down("s");
  await expect(page.locator("#drive-mode")).toBeVisible();
  await expect(page.locator("#drive-mode")).toHaveText("REVERSE");
  expect(await page.locator(".dashboard").boundingBox()).toEqual(dashboardBefore);
  await page.keyboard.up("s");
});

test("3D dashboard and minimap fit without overlapping", async ({ page }) => {
  await dispatchFixture(page);
  await toggleDrivingView(page);
  await expect(page.locator("#map-3d")).toBeVisible();
  for (const width of [801, 900, 1199, 1200, 1280, 1600]) {
    await page.setViewportSize({ width, height: 720 });
    const positions = await page.evaluate(() => {
      const bounds = selector => {
        const { left, right, top, bottom } = document.querySelector(selector).getBoundingClientRect();
        return { left, right, top, bottom };
      };
      const notice = document.querySelector("#notice");
      const wasHidden = notice.hidden;
      notice.hidden = false;
      const result = {
        minimap: bounds("#minimap-panel"),
        dashboard: bounds(".dashboard"),
        meter: bounds(".taxi-meter"),
        digits: bounds("#meter-digits"),
        speed: bounds(".speed-display"),
        touchButtons: [...document.querySelectorAll(".touch-controls button")]
          .filter(button => button.getClientRects().length)
          .map(button => {
            const { left, right, top, bottom } = button.getBoundingClientRect();
            return { left, right, top, bottom };
          }),
        roadLabel: bounds(".road-label"),
        notice: bounds("#notice"),
      };
      notice.hidden = wasHidden;
      return result;
    });
    expect(positions.minimap.left).toBe(30);
    expect(positions.minimap.bottom).toBe(688);
    expect(Math.abs((positions.dashboard.left + positions.dashboard.right) / 2 - width / 2)).toBeLessThanOrEqual(1);
    expect(positions.digits.right).toBeLessThanOrEqual(positions.meter.right);
    expect(positions.speed.right).toBeLessThanOrEqual(positions.dashboard.right);
    for (const button of positions.touchButtons) {
      expect(button.bottom).toBeLessThanOrEqual(positions.minimap.top);
    }
    if (width >= 1200) {
      expect(positions.dashboard.left).toBeGreaterThanOrEqual(positions.minimap.right);
    } else {
      expect(positions.dashboard.bottom).toBeLessThanOrEqual(positions.minimap.top);
    }
    expect(Math.abs((positions.roadLabel.left + positions.roadLabel.right) / 2 - width / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs((positions.notice.left + positions.notice.right) / 2 - width / 2)).toBeLessThanOrEqual(1);
  }
  await page.setViewportSize({ width: 844, height: 390 });
  const shortMinimap = await page.locator("#minimap-panel").boundingBox();
  const shortDashboard = await page.locator(".dashboard").boundingBox();
  const shortDoor = await page.locator("#door").boundingBox();
  expect(shortMinimap.x).toBe(30);
  expect(shortMinimap.y + shortMinimap.height).toBe(358);
  expect(Math.abs(shortDashboard.x + shortDashboard.width / 2 - 422)).toBeLessThanOrEqual(1);
  expect(shortDashboard.x).toBeGreaterThanOrEqual(shortMinimap.x + shortMinimap.width);
  expect(shortDoor.y).toBeGreaterThanOrEqual(0);
  await page.setViewportSize({ width: 320, height: 720 });
  const mobileDashboard = await page.locator(".dashboard").boundingBox();
  const minimap = await page.locator("#minimap-panel").boundingBox();
  expect(minimap.y + minimap.height).toBeLessThanOrEqual(mobileDashboard.y);
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

test("all views receive only the upcoming GPS segments without changing the route", async ({ page }) => {
  await page.addInitScript(() => { window.routeGuides = []; });
  await page.route(/\/app\.mjs\?/, async route => {
    const response = await route.fetch();
    const source = await response.text();
    let instrumented = source;
    for (const [renderer, mode] of [["view", 'view === map3d ? "3d" : "2d"'],
      ["popupMap", '"popup"'], ["minimap", '"minimap"']]) {
      const render = `${renderer}.render(visualCar, visualState, lang, approach, preview);`;
      expect(instrumented).toContain(render);
      instrumented = instrumented.replace(render, `{
        if (state.phase === "onboard" && state.route?.length) {
          window.routeGuides.push({ current: car.edge, route: state.route,
            visible: visualState.route, mode: ${mode} });
        }
        ${render}
      }`);
    }
    await route.fulfill({ response, body: instrumented });
  });
  const fixture = await dispatchFixture(page, 0, false, true);
  fixture.state.phase = "onboard";
  fixture.state.active_order = "passenger";
  await expect.poll(() => page.evaluate(() => window.routeGuides.some(sample =>
    sample.mode === "2d" && sample.visible?.length))).toBe(true);
  await toggleDrivingView(page);
  await expect(page.locator("#map-3d")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.routeGuides.some(sample =>
    sample.mode === "3d" && sample.visible?.length))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.routeGuides.some(sample =>
    sample.mode === "minimap" && sample.visible?.length))).toBe(true);
  await page.locator("#view-mode").click();
  await expect.poll(() => page.evaluate(() => window.routeGuides.some(sample =>
    sample.mode === "popup" && sample.visible?.length))).toBe(true);
  const samples = await page.evaluate(() => window.routeGuides.filter(sample => sample.visible?.length));
  for (const sample of samples) {
    expect(sample.current).toBe("road");
    expect(sample.route).toEqual(["road", "next"]);
    expect(sample.visible).toEqual(["next"]);
  }
});

test("trip panel shows the pickup, then the destination, and closes after drop-off", async ({ page }) => {
  const fixture = await dispatchFixture(page);
  fixture.state.service_ready = false;
  await expect(page.locator("#trip-toggle")).toBeHidden();
  await page.locator("#phone-toggle").click();
  await page.locator(".order-accept").first().click();
  await page.locator("#phone-close").click();
  const panel = page.locator("#trip-panel"), toggle = page.locator("#trip-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#trip-label")).toHaveText("PICKUP");
  await expect(page.locator("#trip-name")).toHaveText("Test Street pickup");
  await expect(page.locator("#trip-distance")).toHaveText("Route distance · 0 m");
  const positions = await page.evaluate(() => ({
    panel: document.querySelector("#trip-details").getBoundingClientRect().toJSON(),
    tools: document.querySelector(".map-tools").getBoundingClientRect().toJSON(),
  }));
  expect(positions.panel.bottom).toBeLessThanOrEqual(positions.tools.top + 1);
  await expect(page.locator("#trip-details")).not.toContainText("Mei");
  await page.locator("#view-mode").click();
  await expect(page.locator("#map-popup")).toBeVisible();
  await page.locator("#map-close").click();
  await page.locator("#phone-toggle").click();
  await expect(page.locator("#phone-screen")).toHaveAttribute("aria-hidden", "false");
  await expect.poll(() => page.evaluate(() => {
    const header = document.querySelector(".phone-header"), rect = header.getBoundingClientRect();
    return document.querySelector("#phone").contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })).toBe(true);
  await page.locator("#phone-close").click();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  fixture.state.service_ready = true;
  await expect.poll(() => fixture.state.phase).toBe("onboard");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#trip-label")).toHaveText("DROP-OFF");
  await expect(page.locator("#trip-name")).toHaveText("Test Street destination");
  await expect(page.locator("#trip-distance")).toHaveText("Route distance · 150 m");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await page.locator("#language").click();
  await expect(page.locator("#trip-name")).toHaveText("測試街落車");
  await expect(page.locator("#trip-distance")).toHaveText("路線距離 · 150 m");
  await expect(toggle).toHaveAttribute("aria-label", "隱藏行程目的地");
  await page.keyboard.down("w");
  await expect.poll(() => fixture.state.x).toBeGreaterThan(51);
  await page.keyboard.up("w");
  await expect.poll(async () => Number((await page.locator("#trip-distance").textContent()).match(/(\d+) m/)[1])).toBeLessThan(150);
  await page.keyboard.press("e");
  await expect.poll(() => fixture.state.phase).toBe("complete");
  await expect(toggle).toBeHidden();
  await expect(panel).not.toHaveClass(/open/);
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
    const { MapView } = await import("/map.mjs?v=tunnel-clearance-1");
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
      const module = await import(`/${path}?v=${path === "map3d.mjs" ? "route-guide-1" : "tunnel-clearance-1"}`);
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
    await expect(page.locator("#trip-toggle")).toBeHidden();
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
    await expect(page.locator("#trip-name")).toHaveText("Test Street destination");
    await expect(page.locator("#trip-toggle")).toHaveAttribute("aria-expanded", "true");
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
