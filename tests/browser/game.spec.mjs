import { test, expect } from "@playwright/test";

test("junction direction keys preview while held, cancel on blur, and select on release", async ({ page }) => {
  const selections = [];
  page.on("request", request => {
    if (request.url().includes("/commands")) {
      const command = request.postDataJSON()?.command;
      if (command?.action === "select_road") selections.push(command);
    }
  });
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await page.locator("#start").click();
  await expect(page.locator("#welcome")).not.toBeVisible();
  await page.keyboard.down("w");
  await expect(page.locator("#junction")).toBeVisible({ timeout: 20000 });
  await page.keyboard.up("w");
  expect(selections).toEqual([]);
  const option = page.locator("#exits .exit-option").first();
  const direction = await option.getAttribute("data-direction");
  const edge = await option.getAttribute("data-edge");
  const key = { straight: "ArrowUp", left: "ArrowLeft", right: "ArrowRight", uturn: "ArrowDown" }[direction];
  await page.keyboard.down(key);
  await expect(option).toHaveClass(/previewed/);
  await page.waitForTimeout(150);
  expect(selections).toEqual([]);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(option).not.toHaveClass(/previewed/);
  await page.keyboard.up(key);
  expect(selections).toEqual([]);
  await expect(page.locator("#junction")).toBeVisible();
  await page.keyboard.down(key);
  await expect(option).toHaveClass(/previewed/);
  await page.keyboard.up(key);
  await expect.poll(() => selections.length).toBe(1);
  expect(selections[0].exit).toBe(edge);
  await expect(page.locator("#junction")).not.toBeVisible();
  await expect(page.locator("#error-dialog")).not.toBeVisible();
});

test("Waterloo sub-road mode stays locked until its main key is released", async ({ page }) => {
  const selections = [];
  page.on("request", request => {
    if (request.url().includes("/commands")) {
      const command = request.postDataJSON()?.command;
      if (command?.action === "select_road") selections.push(command);
    }
  });
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await page.locator("#start").click();
  await expect(page.locator("#welcome")).not.toBeVisible();
  await page.keyboard.down("w");
  await expect(page.locator("#junction")).toBeVisible({ timeout: 20000 });
  await page.keyboard.up("w");
  // Reproduce the reported Waterloo/Ferry angles on three real, connected exits.
  await page.locator("#exits .exit-option").evaluateAll(buttons => {
    if (buttons.length !== 3) throw new Error("Expected three real junction exits");
    buttons.forEach((button, i) => {
      button.dataset.direction = i === 0 ? "left" : "straight";
      button.dataset.angle = String([-0.7612558769673607, -0.36676369551951105, 0.22857796116330523][i]);
    });
  });
  const buttons = page.locator("#exits .exit-option");
  await page.keyboard.down("a");
  await expect(buttons.nth(0)).toHaveClass(/previewed/);
  await page.keyboard.down("w");
  await expect(buttons.nth(2)).toHaveClass(/previewed/);
  await page.keyboard.up("a");
  await page.keyboard.down("a");
  await expect(buttons.nth(1)).toHaveClass(/previewed/);
  await page.keyboard.up("a");
  await expect(buttons.nth(2)).toHaveClass(/previewed/);
  expect(selections).toEqual([]);
  await page.keyboard.down("a");
  await expect(buttons.nth(1)).toHaveClass(/previewed/);
  await page.keyboard.up("w");
  await expect(buttons.nth(1)).toHaveClass(/previewed/);
  await page.waitForTimeout(200);
  await expect(buttons.nth(0)).toHaveClass(/previewed/);
  expect(selections).toEqual([]);
  await page.keyboard.down("w");
  await page.keyboard.up("a");
  await page.keyboard.down("a");
  await expect(buttons.nth(1)).toHaveClass(/previewed/);
  const edge = await buttons.nth(1).getAttribute("data-edge");
  // Dispatch both releases in one browser turn to stay within the real grace window.
  await page.evaluate(() => {
    for (const key of ["w", "a"]) window.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
  });
  await page.keyboard.up("w");
  await page.keyboard.up("a");
  await expect.poll(() => selections.length).toBe(1);
  expect(selections[0].exit).toBe(edge);
  await expect(page.locator("#junction")).not.toBeVisible();
  await expect(page.locator("#error-dialog")).not.toBeVisible();
});

test("losing focus clears controls without opening pause and explicit pause still works", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await page.locator("#start").click();
  await expect(page.locator("#welcome")).not.toBeVisible();
  await page.locator("#job-action").click();
  await expect(page.locator("#status")).toContainText("green marker");
  await page.keyboard.down("w");
  await expect(page.locator("#speed")).not.toHaveText("0");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  const speed = Number(await page.locator("#speed").textContent());
  await expect.poll(async () => Number(await page.locator("#speed").textContent())).toBeLessThan(speed);
  await expect(page.locator("#pause-dialog")).not.toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    delete document.hidden;
  });
  await expect(page.locator("#pause-dialog")).not.toBeVisible();
  await page.keyboard.up("w");
  await page.locator("#pause").click();
  await expect(page.locator("#pause-dialog")).toBeVisible();
  await page.locator("#resume").click();
  await page.keyboard.press("Escape");
  await expect(page.locator("#pause-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#pause-dialog")).not.toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#pause-dialog")).toBeVisible();
});

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

test("space handbrake slows without reversing and Escape opens pause menu", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await page.locator("#start").click();
  await page.keyboard.down("w");
  await page.waitForTimeout(1200);
  await page.keyboard.up("w");
  const before = Number(await page.locator("#speed").textContent());
  expect(before).toBeGreaterThan(0);

  await page.keyboard.down("Space");
  await page.waitForTimeout(1000);
  await page.keyboard.up("Space");
  const after = Number(await page.locator("#speed").textContent());
  expect(after).toBeLessThan(before);
  await expect(page.locator("#drive-mode")).not.toHaveText("REVERSE");

  await page.keyboard.press("Escape");
  await expect(page.locator("#pause-dialog")).toBeVisible();
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
