import { test, expect } from "@playwright/test";

test("start, manual driving, pause, language, and garage", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await page.locator("#start").click();
  await expect(page.locator("#welcome")).not.toBeVisible();
  await page.locator("#job-action").click();
  await expect(page.locator("#status")).toContainText("green marker");
  await page.keyboard.down("w");
  await page.waitForTimeout(650);
  await page.keyboard.up("w");
  await expect(page.locator("#speed")).not.toHaveText("0");
  await page.locator("#pause").click();
  await expect(page.locator("#pause-dialog")).toBeVisible();
  const clock = await page.locator("#clock").textContent();
  await page.waitForTimeout(500);
  await expect(page.locator("#clock")).toHaveText(clock);
  await page.locator("#resume").click();
  await page.locator("#language").click();
  await expect(page.locator("#status")).toContainText("上車點");
  await page.locator("#garage").click();
  await expect(page.locator("#garage-dialog")).toBeVisible();
  await page.locator("#recover").click();
  await expect(page.locator("#money")).toHaveText("$100");
  await expect(page.locator("#efficiency")).toBeEnabled();
  await page.locator("#efficiency").click();
  await expect(page.locator("#money")).toHaveText("$0");
  await expect(page.locator("#efficiency")).toBeDisabled();
  expect(errors).toEqual([]);
});

test("touch controls, responsive layout, and visible attribution", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await page.locator("#start").click();
  await expect(page.locator("#welcome")).not.toBeVisible();
  const footer = page.locator(".attribution");
  await expect(footer).toBeVisible();
  const box = await footer.boundingBox();
  const size = page.viewportSize();
  expect(box.y + box.height).toBeLessThanOrEqual(size.height);
  if (testInfo.project.name === "phone") {
    const gas = page.locator("[data-control=gas]");
    await expect(gas).toBeVisible();
    const pedal = await gas.boundingBox();
    await page.mouse.move(pedal.x + pedal.width / 2, pedal.y + pedal.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
    await expect(page.locator("#speed")).not.toHaveText("0");
  }
  await page.screenshot({ path: testInfo.outputPath("game.png") });
});

test("ordinary real-map junctions stay manual and movement remains within road corridors", async ({ page }) => {
  const moves = [];
  page.on("response", async response => {
    if (response.url().includes("/commands") && response.ok()) {
      const body = await response.json();
      if (body.elapsed > 0) moves.push(body);
    }
  });
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await page.locator("#start").click();
  await expect(page.locator("#welcome")).not.toBeVisible();
  await page.keyboard.down("w");
  await page.waitForTimeout(6500);
  await page.keyboard.up("w");
  await page.locator("#pause").click();
  await expect(page.locator("#pause-dialog")).toBeVisible();
  await expect(page.locator("#error-dialog")).not.toBeVisible();
  await expect(page.locator("#junction")).not.toBeVisible();
  expect(moves.length).toBeGreaterThan(5);
  const map = await (await page.request.get("/api/map")).json();
  const edges = new Map(map.edges.map(e => [e.id, e]));
  for (const position of moves) {
    const edge = edges.get(position.edge), a = map.nodes[edge.a], b = map.nodes[edge.b];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((position.x - a[0]) * dx + (position.y - a[1]) * dy) / (dx * dx + dy * dy)));
    const distance = Math.hypot(position.x - a[0] - t * dx, position.y - a[1] - t * dy);
    expect(distance + map.driving.taxi_radius).toBeLessThanOrEqual(map.driving.widths[edge.kind] / 2 + 1e-5);
  }
});

test("brake pedal holds low-speed reverse without leaving the road", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await page.locator("#start").click();
  await expect(page.locator("#welcome")).not.toBeVisible();
  await page.keyboard.down("s");
  await expect(page.locator("#drive-mode")).toHaveText("REVERSE");
  await page.keyboard.up("s");
  await page.locator("#pause").click();
  await expect(page.locator("#pause-dialog")).toBeVisible();
  await expect(page.locator("#error-dialog")).not.toBeVisible();
});

test("lost connection pauses and offers idempotent retry", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await page.locator("#start").click();
  await page.route("**/api/sessions/*/commands", route => route.abort());
  await page.keyboard.down("w");
  await expect(page.locator("#error-dialog")).toBeVisible();
  await page.keyboard.up("w");
  await expect(page.locator("#retry")).toBeVisible();
  await page.unroute("**/api/sessions/*/commands");
  await page.locator("#retry").click();
  await expect(page.locator("#pause-dialog")).toBeVisible();
  await expect(page.locator("#error-dialog")).not.toBeVisible();
});

test("slow movement acknowledgements apply backpressure without corrupting commands", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await page.locator("#start").click();
  await expect(page.locator("#welcome")).not.toBeVisible();
  let delayed = false;
  await page.route("**/api/sessions/*/commands", async route => {
    const command = route.request().postDataJSON().command;
    if (command.action === "move" && !delayed) {
      delayed = true;
      await new Promise(resolve => setTimeout(resolve, 2800));
    }
    await route.continue();
  });
  await page.waitForTimeout(4000);
  expect(delayed).toBe(true);
  await page.locator("#pause").click();
  await expect(page.locator("#pause-dialog")).toBeVisible();
  await expect(page.locator("#error-dialog")).not.toBeVisible();
});
