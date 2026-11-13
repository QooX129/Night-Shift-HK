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

test("3D accessories persist through boarding and pooled citizens reset their seated pose", async ({ page }, testInfo) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=passenger-extras-2");
    const THREE = await import("/vendor/three/three.module.min.js");
    const view = Object.assign(Object.create(Map3DView.prototype), {
      data: { driving: { taxi_width: 1.7 } },
      scene: new THREE.Scene(), taxi: new THREE.Group(), resources: [],
    });
    view.buildCitizens();
    try {
      const car = { x: 0, y: 0, heading: 0 };
      const traits = { luggage: 2, bag: "backpack", animal: "bird", wheelchair: true };
      const citizen = { id: "rider", point: [3, 4], walking: true, traits };
      view.updateCitizens({ citizens: [citizen], elapsed: 0 }, car);
      const item = view.people[0], accessories = item.accessories.group;
      const luggage = accessories.children.filter(mesh => mesh.material === view.propMaterials.luggage);
      const single = view.citizenAccessories({ luggage: 1 }).group.children
        .filter(mesh => mesh.material === view.propMaterials.luggage);
      const first = { props: accessories.children.length, wheels: item.accessories.wheels.length,
        luggage: luggage.map(mesh => mesh.position.toArray()),
        single: single.map(mesh => mesh.position.toArray()),
        wheelSides: item.accessories.wheels.map(wheel => Math.sign(wheel.position.z)),
        seated: item.legs.every(leg => leg.rotation.z === Math.PI / 2) };
      view.updateCitizens({ citizens: [citizen], elapsed: .1 }, car);
      const rolling = item.accessories.wheels.every(wheel => wheel.rotation.z !== 0);
      view.updateCitizens({ elapsed: .5, traits,
        boarding: { point: [3, 4], starts: 0, ends: 2, traits } }, car);
      const preserved = item.accessories.group === accessories && item.legs[0].rotation.z === Math.PI / 2;
      view.updateCitizens({ elapsed: .6, citizens: [{ id: "plain", point: [3, 4], walking: false }] }, car);
      const reset = item.accessories.group.children.length === 0
        && item.legs.every(leg => leg.rotation.z === 0 && leg.position.x === 0)
        && item.head.position.y === 1.65;
      const animals = ["dog", "cat"].map(animal => {
        view.updateCitizens({ elapsed: .7, citizens: [{ ...citizen, traits: { animal } }] }, car);
        return { legs: item.accessories.animalLegs.length, props: item.accessories.group.children.length };
      });
      view.updateCitizens({ elapsed: 0, citizens: [
        { id: "luggage", point: [-3.5, 0], traits: { luggage: 2, bag: "handbag" } },
        { id: "dog", point: [-1.2, 0], traits: { animal: "dog", bag: "backpack" } },
        { id: "cat", point: [1, 0], traits: { animal: "cat" } },
        { id: "wheelchair", point: [3.3, 0], traits: { wheelchair: true, animal: "bird" } },
      ] }, car);
      view.scene.background = new THREE.Color("#172b34");
      view.scene.add(new THREE.HemisphereLight("#ffffff", "#64727c", 3));
      const camera = new THREE.PerspectiveCamera(42, 900 / 420, .1, 100);
      camera.position.set(3, 4, 12); camera.lookAt(0, .75, 0);
      const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      renderer.setSize(900, 420);
      document.body.replaceChildren(renderer.domElement);
      renderer.domElement.id = "citizen-preview";
      renderer.render(view.scene, camera);
      renderer.dispose();
      return { first, rolling, preserved, reset, animals };
    } finally {
      for (const resource of view.resources) resource.dispose();
      view.door.geometry.dispose(); view.door.material.dispose();
    }
  });
  expect(result.first.props).toBeGreaterThan(10);
  expect(result.first.wheels).toBe(8);
  expect(result.first.luggage).toHaveLength(2);
  const [left, right] = result.first.luggage;
  expect(left[2]).toBeLessThan(0);
  expect(right[2]).toBe(-left[2]);
  expect(right.slice(0, 2)).toEqual(left.slice(0, 2));
  expect(result.first.single).toEqual([left]);
  expect(result.first.wheelSides.filter(side => side < 0)).toHaveLength(4);
  expect(result.first.wheelSides.filter(side => side > 0)).toHaveLength(4);
  expect(result.first.seated).toBe(true);
  expect(result.rolling).toBe(true);
  expect(result.preserved).toBe(true);
  expect(result.reset).toBe(true);
  for (const animal of result.animals) {
    expect(animal.legs).toBe(4);
    expect(animal.props).toBeGreaterThanOrEqual(2);
  }
  await page.locator("#citizen-preview").screenshot({ path: testInfo.outputPath("citizen-accessories.png") });
});

async function dispatchFixture(page, moveDelay = 0, exhaustFuel = false, guideRoute = false, pickupDetour = false) {
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
  if (pickupDetour) {
    map.nodes.c = [300, 600]; map.nodes.d = [0, 600];
    map.edges.push({ ...edge, id: "north", a: "b", b: "c", way: 2, length: 600 },
      { ...edge, id: "west", a: "c", b: "d", way: 3 });
    map.bounds[3] = 750;
    stops[0].edge = "west"; stops[0].point = [50, 600];
  }
  const pickupRoute = pickupDetour ? ["road", "north", "west"] : ["road"];
  const traits = { luggage: 0, bag: "", animal: "", wheelchair: false };
  const fare_breakdown = { luggage: 0, animal: 0, booking: 5 };
  const order = id => ({ id, pickup: "pickup", destination: "dest", passenger, fare: 60,
    traits, fare_breakdown, extra_fare: 5,
    source: "phone", distance: pickupDetour ? 600 : 0, pickup_route: pickupRoute,
    pickup_point: stops[0].point });
  let state = {
    id: "orders", version: "orders", seq: 0, x: 50, y: 0, heading: 0, edge: "road", speed: 0,
    paused: true, elapsed: 0, fuel: 100, money: 120, trips: 0, upgrades: [], phase: "available",
    pickup: "pickup", destination: "dest", fare: 60, meter: null, passenger, dialogue: "offer",
    traits, fare_breakdown, extra_fare: 5,
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
    delete state.command_error;
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
      if (state.rejectPickup) {
        state.command_error = "pickup_unreachable";
        await route.fulfill({ json: state });
        return;
      }
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
    state.route = state.phase === "pickup" ? pickupRoute
      : state.phase === "onboard" ? (guideRoute ? ["road", "next"] : ["road"]) : null;
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

test("phone pickup route distance matches the trip panel before and after accepting", async ({ page }) => {
  const fixture = await dispatchFixture(page, 0, false, false, true);
  fixture.state.service_ready = false;
  fixture.state.pickup_point = [50, 600];
  await page.locator("#phone-toggle").click();
  await expect(page.locator(".order-distance").first()).toHaveText("1.1 km · to pickup");
  fixture.state.offers[0].pickup_route = null;
  await expect(page.locator(".order-distance").first()).toHaveText("Route distance unavailable · to pickup");
  fixture.state.offers[0].pickup_route = ["road", "north", "west"];
  await expect(page.locator(".order-distance").first()).toHaveText("1.1 km · to pickup");
  await page.locator(".order-accept").first().click();
  await expect(page.locator("#trip-distance")).toHaveText("Route distance · 1.1 km");
  await expect(page.locator("#accepted-tab")).toHaveAttribute("aria-selected", "true");
});

test("fuel exhaustion during an onboard trip discards buffered movement without a crash", async ({ page }) => {
  const fixture = await dispatchFixture(page, 400, true);
  fixture.state.phase = "onboard";
  fixture.state.service_ready = false;
  fixture.state.order_source = "phone";
  fixture.state.extra_fare = 5;
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
  await expect(page.locator("#fare")).toHaveText("HK$ 31.1");
  await expect(page.locator("#fare-label")).toHaveText("Meter fare");
  await expect(page.locator("#meter-extra")).toHaveAttribute("aria-label", "EXTRAS HK$ 5.0");
  await expect(page.locator("#fare-breakdown")).toHaveText("Phone booking · HK$ 5 · Final fare · HK$ 36.1");
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
  await expect(page.locator("#fare-label")).toHaveText("Meter fare");
});

test("itemized extras stay to the right of the meter on narrow screens and switch language", async ({ page }) => {
  const fixture = await dispatchFixture(page);
  fixture.state.phase = "onboard";
  fixture.state.meter = 29;
  fixture.state.fare = 51;
  fixture.state.extra_fare = 22;
  fixture.state.traits = { luggage: 2, bag: "backpack", animal: "bird", wheelchair: true };
  fixture.state.fare_breakdown = { luggage: 12, animal: 5, booking: 5 };
  fixture.state.order_source = "phone";
  fixture.state.active_order = "rider";
  fixture.state.service_ready = false;
  await expect(page.locator("#meter-extra")).toHaveAttribute("aria-label", "EXTRAS HK$ 22.0");
  await page.locator("#phone-toggle").click();
  await page.locator("#accepted-tab").click();
  await expect(page.locator("#fare")).toHaveText("HK$ 29.0");
  await expect(page.locator("#passenger-traits")).toContainText("Large luggage ×2");
  await expect(page.locator("#passenger-traits")).toContainText("Wheelchair (free)");
  await expect(page.locator("#fare-breakdown")).toContainText("Caged bird ×1 · HK$ 5");
  await expect(page.locator("#fare-breakdown")).toContainText("Final fare · HK$ 51.0");
  await page.locator("#phone-close").click();
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 720 });
    const bounds = await page.evaluate(() => {
      const box = id => {
        const { left, right, width, height } = document.getElementById(id).getBoundingClientRect();
        return { left, right, width, height };
      };
      const meter = document.querySelector(".taxi-meter").getBoundingClientRect();
      const fareDigit = document.querySelector("#meter-digits .meter-digit").getBoundingClientRect();
      const extraDigit = document.querySelector("#meter-extra .meter-digit").getBoundingClientRect();
      const fuel = document.querySelector(".fuel-track").getBoundingClientRect();
      return { main: box("meter-digits"), extra: box("meter-extra"), right: meter.right,
        heightDifference: fareDigit.height - extraDigit.height,
        baselineAligned: fareDigit.bottom === extraDigit.bottom,
        fuelWidth: fuel.width, fuelHeight: fuel.height };
    });
    expect(bounds.extra.left).toBeGreaterThanOrEqual(bounds.main.right);
    expect(bounds.extra.right).toBeLessThanOrEqual(bounds.right);
    expect(bounds.heightDifference).toBe(4);
    expect(bounds.baselineAligned).toBe(true);
    expect(bounds.fuelWidth).toBe(width > 800 ? 66 : 35);
    expect(bounds.fuelHeight).toBe(3);
  }
  await page.locator("#language").click();
  await expect(page.locator("#meter-extra")).toHaveAttribute("aria-label", "附加費 HK$ 22.0");
  await page.locator("#phone-toggle").click();
  await page.locator("#accepted-tab").click();
  await expect(page.locator("#passenger-traits")).toContainText("大型行李 ×2");
  await expect(page.locator("#fare-breakdown")).toContainText("電召費 · HK$ 5");
});

test("bordered counters reserve dim digit slots and retain their layout as fares grow", async ({ page }) => {
  const fixture = await dispatchFixture(page);
  for (const [id, slots] of [["meter-digits", 4], ["meter-extra", 3]]) {
    await expect(page.locator(`#${id} .meter-digit`)).toHaveCount(slots);
    await expect(page.locator(`#${id} .meter-digit.dim`)).toHaveCount(slots);
    await expect(page.locator(`#${id} i.on`)).toHaveCount(0);
    await expect(page.locator(`#${id}`)).toHaveAttribute("aria-label", "VACANT");
  }
  fixture.state.phase = "onboard";
  fixture.state.meter = 29;
  fixture.state.extra_fare = 0;
  fixture.state.fare = 29;
  fixture.state.active_order = "rider";
  fixture.state.service_ready = false;
  await expect(page.locator("#meter-digits")).toHaveAttribute("aria-label", "TAXI METER HK$ 29.0");
  await expect(page.locator("#meter-extra")).toHaveAttribute("aria-label", "EXTRAS HK$ 0.0");
  await expect(page.locator("#meter-digits .meter-digit.dim")).toHaveCount(1);
  await expect(page.locator("#meter-extra .meter-digit.dim")).toHaveCount(1);
  await expect(page.locator("#meter-digits .meter-digit.dim i.on")).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 720 });
  const before = await page.locator(".taxi-meter").boundingBox();
  fixture.state.meter = 102.5;
  fixture.state.extra_fare = 22;
  fixture.state.fare = 124.5;
  await expect(page.locator("#meter-digits")).toHaveAttribute("aria-label", "TAXI METER HK$ 102.5");
  await expect(page.locator("#meter-digits .meter-digit.dim")).toHaveCount(0);
  await expect(page.locator("#meter-extra .meter-digit.dim")).toHaveCount(0);
  await expect(page.locator("#meter-extra .meter-digit")).toHaveCount(3);
  expect(await page.locator(".taxi-meter").boundingBox()).toEqual(before);
  const panels = await page.locator(".meter-amount").evaluateAll(elements => elements.map(element => {
    const panel = element.getBoundingClientRect();
    const digits = [...element.querySelectorAll(".meter-digit, .meter-decimal")].map(digit => digit.getBoundingClientRect());
    const style = getComputedStyle(element);
    return { fits: digits.every(digit => digit.left >= panel.left && digit.right <= panel.right),
      divider: style.borderLeftWidth };
  }));
  expect(panels.every(panel => panel.fits)).toBe(true);
  expect(panels[1].divider).toBe("1px");
  fixture.state.meter = 1000;
  await expect(page.locator("#meter-digits")).toHaveAttribute("aria-label", "TAXI METER HK$ 1000.0");
  await expect(page.locator("#meter-digits .meter-digit")).toHaveCount(5);
  fixture.state.extra_fare = 100;
  await expect(page.locator("#meter-extra")).toHaveAttribute("aria-label", "EXTRAS HK$ 100.0");
  await expect(page.locator("#meter-extra .meter-digit")).toHaveCount(4);
});

test("speed reading and pickup controls stay aligned with the dashboard", async ({ page }) => {
  await dispatchFixture(page);
  for (const size of [
    { width: 1280, height: 720 },
    { width: 800, height: 720 },
    { width: 390, height: 844 },
    { width: 390, height: 664 },
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
          dial: rect(".speed-dial"), reading: rect(".speed-reading"), door: rect("#door"),
          overview: document.getElementById("overview").getBoundingClientRect().toJSON() };
        speed.textContent = previousSpeed;
        return positions;
      });
      expect(positions.door.bottom).toBeLessThanOrEqual(positions.dashboard.top - 8);
      expect(positions.door.right).toBeLessThanOrEqual(positions.dashboard.right);
      expect(positions.reading.left).toBeGreaterThanOrEqual(positions.dial.right);
      expect(positions.reading.right).toBeLessThanOrEqual(positions.dashboard.right);
      expect(positions.overview.bottom <= positions.dashboard.top
        || positions.overview.right <= positions.dashboard.left
        || positions.overview.left >= positions.dashboard.right
        || positions.overview.top >= positions.dashboard.bottom).toBe(true);
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

test("unreachable phone pickup is declined without interrupting the current trip", async ({ page }) => {
  const fixture = await dispatchFixture(page);
  fixture.state.phase = "onboard";
  fixture.state.order_source = "phone";
  fixture.state.active_order = "current";
  fixture.state.rejectPickup = true;
  await page.locator("#phone-toggle").click();
  await page.locator(".order-accept").first().click();
  await expect(page.locator("#order-notice")).toContainText("order was not accepted");
  await expect(page.locator("#error-dialog")).not.toBeVisible();
  await expect(page.locator("#available-tab")).toHaveAttribute("aria-selected", "true");
  expect(fixture.state.phase).toBe("onboard");
  expect(fixture.state.active_order).toBe("current");
  expect(fixture.state.offers).toHaveLength(8);
  expect(fixture.state.accepted_orders).toHaveLength(0);
});

test("randomized order points drive the trip distance and 3D marker", async ({ page }) => {
  const fixture = await dispatchFixture(page);
  fixture.state.pickup_point = [75, 0];
  fixture.state.offers[0].pickup_point = [75, 0];
  fixture.state.destination_point = [230, 0];
  await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=passenger-extras-2");
    const render = Map3DView.prototype.render;
    Map3DView.prototype.render = function (...args) {
      window.randomPointView = this;
      return render.apply(this, args);
    };
  });
  await page.locator("#phone-toggle").click();
  await expect(page.locator(".order-distance").first()).toHaveText("25 m · to pickup");
  await page.locator(".order-accept").first().click();
  await expect(page.locator("#trip-distance")).toContainText("25 m");
  await toggleDrivingView(page);
  await expect.poll(() => page.evaluate(() => {
    const marker = window.randomPointView?.markers.find(item => item.dynamic && item.marker.visible);
    return marker && [marker.marker.position.x, marker.marker.position.z];
  })).toEqual([75, 0]);

  fixture.state.phase = "onboard";
  await page.locator("#pause").click();
  await expect.poll(() => page.evaluate(() => {
    const marker = window.randomPointView?.markers.find(item => item.dynamic && item.marker.visible);
    return marker && [marker.marker.position.x, marker.marker.position.z];
  })).toEqual([230, 0]);
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
    const { MapView } = await import("/map.mjs?v=passenger-extras-2");
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
      const module = await import(`/${path}?v=passenger-extras-2`);
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
