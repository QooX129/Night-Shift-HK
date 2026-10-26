import { test, expect } from "@playwright/test";

test("boundary sliding trails remain accepted by server movement validation", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  const result = await page.evaluate(async () => {
    const { RoadNetwork, stepCar } = await import("/physics.mjs");
    const map = await (await fetch("/api/map")).json();
    const roads = new RoadNetwork(map);
    let contacts = 0;
    for (let seed = 0; seed < 12; seed++) {
      let state = await (await fetch("/api/sessions", { method: "POST" })).json();
      const send = async command => {
        const response = await fetch(`/api/sessions/${state.id}/commands`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ seq: state.seq + 1, command }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(JSON.stringify({ seed, status: response.status, body, command, state }));
        state = body;
      };
      await send({ action: "pause", paused: false });
      const car = { x: state.x, y: state.y, heading: state.heading, edge: state.edge, speed: 0 };
      for (let batch = 0; batch < 24; batch++) {
        const trail = [];
        for (let frame = 0; frame < 18; frame++) {
          const index = batch * 18 + frame;
          const reverse = seed > 5 && index > 220;
          const result = stepCar(car, {
            gas: !reverse, brake: reverse,
            left: seed % 2 === 0 && index % (60 + seed * 7) < 45,
            right: seed % 2 === 1 && index % (60 + seed * 7) < 45,
          }, 1 / 60, { roads, closed: new Set(state.closed), fuel: state.fuel });
          if (result.blocked) contacts++;
          trail.push({ x: car.x, y: car.y, heading: car.heading });
        }
        await send({ action: "move", x: car.x, y: car.y, heading: car.heading, speed: car.speed, dt: 0.3, trail });
      }
    }
    return { contacts };
  });
  expect(result.contacts).toBeGreaterThan(100);
  await expect(page.locator("#error-dialog")).not.toBeVisible();
});
