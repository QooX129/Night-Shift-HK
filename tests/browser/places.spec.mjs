import { test, expect } from "@playwright/test";
import { useLegacyInitialView } from "./driving-view.mjs";

test("the map renders estate, car park, hotel and close-up block labels", async ({ page }) => {
  await page.goto("/");
  const { map_labels: packagedLabels } = await (await page.request.get("/api/places")).json();
  for (const [kind, name] of [
    ["estate", "Sorrento"], ["carpark", "Olympian City 2 Car Park"],
    ["hotel", "Prudential Hotel"], ["block", "Tower 1"],
  ]) {
    expect(packagedLabels.some(label => label.kind === kind && label.name === name)).toBe(true);
  }
  const result = await page.evaluate(async () => {
    const { MapView } = await import("/map.mjs?v=subroad-area-labels-1");
    const labels = [
      { kind: "estate", name: "Sorrento", zh: "擎天半島", point: [0, 0] },
      { kind: "carpark", name: "Car Park", zh: "停車場", point: [100, 0] },
      { kind: "hotel", name: "Hotel", zh: "酒店", point: [200, 0] },
      { kind: "block", name: "Tower 1", zh: "1座", point: [300, 0] },
    ];
    const canvas = document.createElement("canvas"), context = canvas.getContext("2d");
    const texts = [], original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
      texts.push(text);
      return original.call(this, text, ...args);
    };
    try {
      const view = Object.assign(Object.create(MapView.prototype), {
        ratio: 1, compact: false, interactive: false, lang: "en",
        mapLabelIndex: { query: () => labels },
      });
      view.drawMapLabels(context, [-20, -20, 340, 20], 2);
      const closeUp = [...texts];
      texts.length = 0;
      view.lang = "zh";
      view.drawMapLabels(context, [-20, -20, 340, 20], 1);
      return { closeUp, zoomedOut: [...texts] };
    } finally {
      CanvasRenderingContext2D.prototype.fillText = original;
    }
  });
  expect(result.closeUp).toEqual(expect.arrayContaining(["Sorrento", "Car Park", "Hotel", "Tower 1"]));
  expect(result.zoomedOut).toEqual(expect.arrayContaining(["擎天半島", "停車場", "酒店"]));
  expect(result.zoomedOut).not.toContain("1座");
});

test("a real named destination appears in the dispatch phone in both languages", async ({ page }) => {
  await useLegacyInitialView(page);
  const stops = await (await page.request.get("/api/stops")).json();
  const place = stops.find(stop => stop.id.startsWith("osm-") && stop.name.includes("Langham Place"));
  expect(place).toBeTruthy();
  const setDestination = async route => {
    const response = await route.fetch();
    const state = await response.json();
    state.destination = place.id;
    for (const offer of state.offers ?? []) offer.destination = place.id;
    await route.fulfill({ response, json: state });
  };
  await page.route("**/api/sessions", setDestination);
  await page.route("**/api/sessions/*/commands", setDestination);
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await page.locator("#start").click();
  await page.locator("#phone-toggle").click();
  await expect(page.locator(".order-destination").first()).toContainText(place.name);
  await page.locator("#language").click();
  await expect(page.locator(".order-destination").first()).toContainText(place.zh);
});
