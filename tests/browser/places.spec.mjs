import { test, expect } from "@playwright/test";
import { useLegacyInitialView } from "./driving-view.mjs";

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
