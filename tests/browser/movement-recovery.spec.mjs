import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("night-shift-hk.settings.v1", JSON.stringify({
      defaultView: "2d", junctionSelector: false,
    }));
  });
});

test("boundary rejection restores confirmed position, keeps held controls and resumes without a dialog", async ({ page }) => {
  let rejected = false, restored = null;
  const after = [], warnings = [];
  page.on("console", message => {
    if (message.type() === "warning") warnings.push(message.text());
  });
  await page.route("**/api/sessions/*/commands", async route => {
    const request = route.request().postDataJSON();
    if (request.command.action !== "move") return route.continue();
    if (!rejected) {
      rejected = true;
      const bad = { ...request, command: { ...request.command, trail: [
        { x: request.command.x, y: request.command.y + 15, heading: request.command.heading },
      ] } };
      const response = await route.fetch({ postData: bad });
      expect(response.status()).toBe(409);
      const body = await response.json();
      expect(body.code).toBe("movement_boundary");
      restored = body.state;
      await route.fulfill({ response });
    } else {
      after.push(request);
      await route.continue();
    }
  });
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled({ timeout: 30000 });
  await page.locator("#start").click();
  await page.keyboard.down("w");
  await expect.poll(() => restored).not.toBeNull();
  await expect(page.locator("#notice")).toContainText("last confirmed position");
  await expect(page.locator("#error-dialog")).not.toBeVisible();
  await expect(page.locator("#pause-dialog")).not.toBeVisible();
  await expect.poll(() => after.some(request => request.command.speed > 0)).toBe(true);
  await page.keyboard.up("w");
  expect(after[0].seq).toBe(restored.seq + 1);
  expect(Math.hypot(after[0].command.trail[0].x - restored.x,
    after[0].command.trail[0].y - restored.y)).toBeLessThan(.01);
  expect(warnings.some(text => text.includes("movement_boundary"))).toBe(true);
});

test("unrelated 409 conflicts still stop driving and show their error", async ({ page }) => {
  await page.route("**/api/sessions/*/commands", async route => {
    if (route.request().postDataJSON().command.action !== "move") return route.continue();
    await route.fulfill({ status: 409, json: { detail: "Commands are out of sequence. Restart the shift." } });
  });
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled({ timeout: 30000 });
  await page.locator("#start").click();
  await page.keyboard.down("w");
  await expect(page.locator("#error-dialog")).toBeVisible();
  await page.keyboard.up("w");
  await expect(page.locator("#error-message")).toContainText("out of sequence");
});

test("alignment assistance works safely on the actual map's narrow roads in either direction", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled({ timeout: 30000 });
  const result = await page.evaluate(async () => {
    const { RoadNetwork, stepCar, angleDifference } = await import("/physics.mjs?v=narrow-assist-2");
    const data = await (await fetch("/api/map")).json();
    const roads = new RoadNetwork(data);
    const rotationFits = roads.rotationFits.bind(roads);
    let checked = 0, unsafe = 0, nearEnd = 0;
    for (const edge of roads.edges.values()) {
      if (edge.width > data.driving.taxi_width * 2) continue;
      const a = roads.nodes[edge.a], b = roads.nodes[edge.b];
      for (const facing of [roads.angle(edge), roads.angle(edge) + Math.PI]) {
        for (const speed of [3, -3]) {
          const car = { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2,
            heading: facing + .05, edge: edge.id, speed };
          const input = speed > 0 ? { left: true } : { right: true };
          const origin = { x: car.x, y: car.y };
          let assisted = false, attempted = false;
          roads.rotationFits = (...args) => {
            attempted = true;
            assisted = rotationFits(...args);
            return assisted;
          };
          stepCar(car, input, 1 / 60, { roads });
          if (Math.hypot(b[0] - a[0], b[1] - a[1]) / 2 <= data.driving.taxi_length) {
            if (attempted) throw new Error(`Assistance did not release near the end: ${edge.id}`);
            nearEnd++;
            continue;
          }
          if (!assisted) {
            if (rotationFits(origin, facing + .05, facing, edge))
              throw new Error(`Safe alignment did not gain assistance: ${edge.id}`);
            unsafe++;
            continue;
          }
          if (!rotationFits(origin, facing + .05, car.heading, edge))
            throw new Error(`Unsafe assisted angular sweep: ${edge.id}`);
          if (Math.abs(angleDifference(facing, car.heading)) >= .05)
            throw new Error(`Missing assistance: ${edge.id}, facing=${facing}, speed=${speed}`);
          if (!roads.bodyFits(car, car.heading, roads.edges.get(car.edge)))
            throw new Error(`Unsafe assisted footprint: ${edge.id}`);
          checked++;
        }
      }
    }
    return { checked, unsafe, nearEnd };
  });
  expect(result.checked).toBeGreaterThan(0);
  expect(result.unsafe).toBeGreaterThan(0);
  expect(result.nearEnd).toBeGreaterThan(0);
});
