import { stepCar, RoadNetwork } from "./physics.mjs?v=tunnel-clearance-1";
import { MapView } from "./map.mjs?v=tunnel-clearance-1";
import { en, zh } from "./i18n.mjs?v=pedal-icons-1";
import { JunctionInput, junctionDirection, junctionShortcuts } from "./junction-input.mjs?v=junction-hud-1";
import { SETTINGS_CATEGORIES, loadSettings, normalizeSettings, resetSettingsCategory, saveSettings } from "./settings.mjs?v=parabolic-steering-1";
import { visualStream, VISUAL_STREAM_RADIUS } from "./map-stream.mjs";
import { interpolateCar } from "./visual-motion.mjs";
import { routeDistance } from "./route-distance.mjs";
import { upcomingRoute } from "./route-guide.mjs";

const $ = id => document.getElementById(id);
const loadedPreferences = loadSettings();
let preferences = loadedPreferences.settings;
let lang = preferences.language, state = null, view = null, mapData, stops;
let map2d = null, map3d = null, changingView = false, viewError = null;
let popupMap = null, mapDrag = null;
let mapStream = null, mapStreamFailure = null;
let minimap = null, lastMinimapFrame = -Infinity;
let car = { x: 0, y: 0, speed: 0, heading: 0, edge: null }, roads;
let previousCar = null;
let paused = true, busy = false, moving = false, pending = null, elapsed = 0, trail = [];
let inFlightElapsed = 0;
let visualElapsed = 0;
let junctionLatch = null, boundary = false, closureWarning = false, lastFrame = 0, stepBank = 0;
let previewExit = null;
let movementRecoveryUntil = 0;
let phoneTab = "available";
let tripPanelPhase = null, tripPanelOrder = null;
let settingsMessage = loadedPreferences.error === "read" ? "settingsLoadError"
  : loadedPreferences.error === "invalid" ? "settingsInvalidError" : null;
let settingsOrigin = "welcome", settingsCategory = "display", preferredViewRequest = null;
const junctionInput = new JunctionInput({ releaseGrace: preferences.junctionGrace });
const controls = { gas: false, brake: false, handbrake: false, left: false, right: false };
const t = key => (lang === "zh" ? zh : en)[key] || key;
const dialogs = ["welcome", "junction", "pause-dialog", "garage-dialog", "error-dialog", "settings-dialog"];

function resetControls() {
  car.steeringInput = 0;
  car.steeringTarget = 0;
  junctionInput.reset();
  if ($("junction").open) setExitPreview(null);
  for (const key of Object.keys(controls)) controls[key] = false;
  document.querySelectorAll("[data-control]").forEach(b => b.classList.remove("pressed"));
}
function setExitPreview(edge) {
  previewExit = edge;
  for (const button of $("exits").children) {
    const active = button.dataset.edge === edge;
    button.classList.toggle("previewed", active);
  }
}
function openDialog(id) {
  setMapOpen(false);
  for (const other of dialogs) if (other !== id) $(other).close();
  if (!$(id).open) $(id).showModal();
  resetControls();
  updateSettingsMessage();
}
function applyState(next, resetPosition = false) {
  if (mapData && next.version !== mapData.version) throw new Error("Map version changed. Reload to start a new shift.");
  state = next;
  if (resetPosition) {
    car = { x: next.x, y: next.y, speed: next.speed, heading: next.heading, edge: next.edge };
    previousCar = null;
    elapsed = 0; trail = [];
    inFlightElapsed = 0;
    visualElapsed = next.elapsed;
  } else if (next.fuel <= 0) {
    // Discard motion predicted while the fuel-exhausting request was in flight.
    car = { x: next.x, y: next.y, speed: 0, heading: next.heading, edge: next.edge };
    previousCar = null;
    trail = [];
  }
  updateUI();
}
function showError(error, retryable) {
  paused = true; car.speed = 0; resetControls();
  $("error-message").textContent = error.message;
  $("retry").hidden = !retryable;
  $("error-close").hidden = retryable || !state;
  openDialog("error-dialog");
}
async function fetchJSON(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
  const data = await response.json();
  if (!response.ok) {
    const message = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
    const error = new Error(message);
    error.status = response.status;
    error.code = data.code;
    error.state = data.state;
    error.diagnostic = data.diagnostic;
    throw error;
  }
  return data;
}
async function send(action, fields = {}) {
  const request = { seq: state.seq + 1, command: { action, ...fields } };
  pending = request;
  try {
    const next = await fetchJSON(`/api/sessions/${state.id}/commands`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
    });
    pending = null;
    if (action === "move") inFlightElapsed = 0;
    applyState(next);
    return next;
  } catch (error) {
    if (action === "move" && error.status === 409 && error.code === "movement_boundary" && error.state) {
      console.warn("movement_boundary: restored last confirmed position", error.diagnostic);
      pending = null;
      applyState(error.state, true);
      car.speed = 0;
      stepBank = 0;
      boundary = true;
      closureWarning = false;
      movementRecoveryUntil = performance.now() + 4000;
      updateUI();
      return null;
    }
    if (error.status && error.status < 500) {
      pending = null;
      car = { x: state.x, y: state.y, speed: 0, heading: state.heading, edge: state.edge };
      previousCar = null;
      elapsed = 0; trail = [];
      inFlightElapsed = 0;
      visualElapsed = state.elapsed;
    } else error.message = `${t("retryNetwork")} (${error.message})`;
    showError(error, Boolean(pending));
    throw error;
  }
}
async function flush() {
  while (moving) await new Promise(resolve => setTimeout(resolve, 10));
  if (!state || (elapsed < 0.001 && Math.hypot(car.x - state.x, car.y - state.y) < 0.05)) return;
  const dt = elapsed, samples = trail; elapsed = 0; trail = [];
  inFlightElapsed = dt;
  moving = true;
  try {
    const visible_citizens = view === map3d && map3d
      ? map3d.visibleCitizens({ ...state, elapsed: visualElapsed }, car) : [];
    const next = await send("move", { x: car.x, y: car.y, speed: car.speed, heading: car.heading, dt, trail: samples,
      visible_citizens });
    if (!next) return;
    if (!busy && !paused && !state.boarding && state.phase === "pickup" && state.service_ready && Math.abs(car.speed) <= 0.6) {
      await send("service");
    }
  }
  finally { moving = false; }
}
async function perform(task) {
  if (busy || (pending && !moving)) return;
  busy = true; updateUI();
  try {
    while (moving) await new Promise(resolve => setTimeout(resolve, 10));
    if (pending || $("error-dialog").open) return;
    await task();
  }
  catch (error) {
    if (!$("error-dialog").open) showError(error, false);
  } finally {
    busy = false; updateUI();
    if (document.hidden && !paused) pauseTo("pause-dialog");
  }
}
async function pauseTo(id) {
  if (!state || busy || $("error-dialog").open) return;
  await perform(async () => {
    paused = true;
    await flush(); car.speed = 0;
    await send("pause", { paused: true });
    openDialog(id);
  });
}
async function resume() {
  await perform(async () => {
    await send("pause", { paused: false });
    dialogs.forEach(id => $(id).close());
    updateSettingsMessage();
    paused = false; lastFrame = performance.now(); stepBank = 0; previousCar = null; resetControls();
  });
}
function localMatch() {
  if (!state || !view) return null;
  return { edge: roads.edges.get(car.edge) };
}
function nearJunction() {
  if (!preferences.junctionSelector) return false;
  const approach = roads.approach(car, new Set(state.closed));
  return approach && (approach.stacked || approach.options.length > 2)
    && junctionLatch !== approach.node;
}
async function promptJunction() {
  paused = true;
  while (moving) await new Promise(resolve => setTimeout(resolve, 10));
  if ($("error-dialog").open) return;
  await perform(async () => {
    await flush();
    await send("pause", { paused: true, preserve_speed: true });
    if (!state.junction_choice) {
      await send("pause", { paused: false }); paused = false;
      return;
    }
    renderExits(); openDialog("junction");
  });
}
function renderExits() {
  junctionInput.reset();
  previewExit = null;
  $("exits").replaceChildren();
  const index = state.route?.indexOf(state.edge) ?? -1;
  const suggested = index >= 0 ? state.route[index + 1] : null;
  const options = state.options.map(option => ({ ...option, direction: junctionDirection(option.angle) }))
    .sort((a, b) => a.angle - b.angle);
  const shortcuts = junctionShortcuts(options);
  for (const option of options) {
    const { direction } = option;
    const button = document.createElement("button");
    button.className = `exit-option ${option.edge === suggested ? "recommended" : ""}`;
    button.dataset.edge = option.edge;
    button.dataset.direction = direction;
    button.dataset.angle = String(option.angle);
    const arrow = document.createElement("span"); arrow.className = "arrow";
    arrow.textContent = { left: "↰", right: "↱", straight: "↑", uturn: "↶" }[direction];
    const text = document.createElement("span");
    text.textContent = `${t(direction)} · ${lang === "zh" ? option.zh : option.name}`;
    const small = document.createElement("small");
    small.textContent = option.edge === suggested ? t("suggested") : lang === "zh" ? option.name : option.zh;
    if (option.restricted) small.textContent += ` · ${t("restricted")}`;
    text.append(small); button.append(arrow, text);
    const shortcut = document.createElement("kbd");
    shortcut.className = "exit-shortcut";
    shortcut.textContent = shortcuts.get(option.edge);
    button.append(shortcut);
    for (const event of ["pointerenter", "focus"]) {
      button.addEventListener(event, () => { if (!junctionInput.keys.size) setExitPreview(option.edge); });
    }
    for (const event of ["pointerleave", "blur"]) {
      button.addEventListener(event, () => {
        if (!junctionInput.keys.size && previewExit === option.edge) setExitPreview(null);
      });
    }
    button.addEventListener("click", () => perform(async () => {
      await send("select_road", { incoming: state.edge, exit: option.edge });
      applyState(state, true);
      junctionLatch = state.selected_junction;
      lastFrame = performance.now(); stepBank = 0;
      $("junction").close(); paused = false; resetControls();
    }));
    $("exits").append(button);
  }
}
function updateSettingsMessage() {
  const message = settingsMessage ? t(settingsMessage) : "";
  const isError = Boolean(settingsMessage && settingsMessage !== "resetDone");
  const inside = $("settings-message");
  const welcome = $("welcome-settings-message");
  inside.hidden = !message;
  inside.textContent = message;
  inside.setAttribute("role", isError ? "alert" : "status");
  inside.setAttribute("aria-live", isError ? "assertive" : "polite");
  welcome.hidden = !message || !$("welcome").open || $("settings-dialog").open;
  welcome.textContent = message;
  welcome.setAttribute("role", isError ? "alert" : "status");
  welcome.setAttribute("aria-live", isError ? "assertive" : "polite");
  const notice = $("settings-notice");
  notice.hidden = !message || dialogs.some(id => $(id).open);
  notice.textContent = message;
  notice.setAttribute("role", isError ? "alert" : "status");
  notice.setAttribute("aria-live", isError ? "assertive" : "polite");
}
function formatSettingValue(key, value) {
  if (key === "cameraSmoothness" || key === "chaseDistance" || key === "minimapZoom"
      || key === "junctionHudOpacity") return `${value}%`;
  if (key === "cameraRotationSpeed") return `${(value / 100).toFixed(1)} rad/s`;
  if (key === "steeringSensitivity") return `${(value / 100).toFixed(2)}×`;
  if (key === "junctionGrace") return `${value} ms`;
  return String(value);
}
function updateSettingsControls() {
  if (!$("settings-dialog").open) {
    updateSettingsMessage();
    return;
  }
  document.querySelectorAll("[data-setting]").forEach(input => {
    const value = preferences[input.dataset.setting];
    if (input.type === "checkbox") input.checked = value;
    else input.value = String(value);
    if (input.type === "range") input.parentElement.querySelector("output").textContent =
      formatSettingValue(input.dataset.setting, value);
  });
  document.querySelectorAll("[data-category]").forEach(button => {
    const selected = button.dataset.category === settingsCategory;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  document.querySelectorAll("[data-panel]").forEach(panel => {
    panel.hidden = panel.dataset.panel !== settingsCategory;
  });
  $("settings-reset").textContent = t("settingsReset");
  updateSettingsMessage();
}
function selectSettingsCategory(category, focus = false) {
  if (!Object.hasOwn(SETTINGS_CATEGORIES, category)) return;
  settingsCategory = category;
  updateSettingsControls();
  if (focus) document.querySelector(`[data-category="${category}"]`).focus();
}
function updateMinimapLayout() {
  const mobile = innerWidth <= 800;
  const sizes = mobile
    ? { small: [136, 97], medium: [168, 120], large: [210, 150] }
    : { small: [200, 140], medium: [240, 168], large: [300, 210] };
  const [width, height] = sizes[preferences.minimapSize];
  document.documentElement.style.setProperty("--minimap-width", `${width}px`);
  document.documentElement.style.setProperty("--minimap-height", `${height}px`);
}
function applyPreferenceEffects() {
  lang = preferences.language;
  junctionInput.releaseGrace = preferences.junctionGrace;
  document.documentElement.classList.toggle("reduce-motion", preferences.reducedMotion);
  document.documentElement.classList.toggle("hide-shortcut-hints", !preferences.shortcutHints);
  document.documentElement.style.setProperty("--junction-hud-opacity", String(preferences.junctionHudOpacity / 100));
  updateMinimapLayout();
  if (minimap) minimap.zoom = preferences.minimapZoom / 100;
  if ($("minimap-panel")) $("minimap-panel").hidden = !map3d || view !== map3d || !preferences.minimapVisible;
  map3d?.applyPreferences(preferences);
  updateSettingsControls();
}
function commitPreferences(next, message = null) {
  const previousView = preferences.defaultView;
  preferences = normalizeSettings(next).settings;
  applyPreferenceEffects();
  updateUI();
  if (saveSettings(preferences)) settingsMessage = message;
  else settingsMessage = "settingsSaveError";
  updateSettingsMessage();
  if (preferences.defaultView !== previousView) {
    if (preferences.defaultView === "3d" && view !== map3d) {
      preferredViewRequest = "3d";
      toggleView();
    } else if (preferences.defaultView === "2d") {
      if (changingView) preferredViewRequest = "2d";
      else if (view === map3d) activateView(map2d);
    }
  }
}
function openSettings(origin) {
  settingsOrigin = origin;
  $(origin).close();
  openDialog("settings-dialog");
  updateSettingsControls();
}
function closeSettings() {
  $("settings-dialog").close();
  openDialog(settingsOrigin);
  $(`${settingsOrigin === "welcome" ? "welcome" : "pause"}-settings`).focus();
}
function setPhoneOpen(open) {
  if (open && !$("phone").classList.contains("open")) selectPhoneTab("available");
  $("phone").classList.toggle("open", open);
  $("phone-toggle").setAttribute("aria-expanded", String(open));
  if (!open && $("phone-screen").contains(document.activeElement)) $("phone-toggle").focus();
  $("phone-screen").inert = !open;
  $("phone-screen").setAttribute("aria-hidden", String(!open));
}
function selectPhoneTab(tab, focus = false) {
  phoneTab = tab;
  for (const name of ["available", "accepted"]) {
    const active = name === tab;
    $(`${name}-tab`).setAttribute("aria-selected", String(active));
    $(`${name}-tab`).tabIndex = active ? 0 : -1;
    $(`phone-${name}`).hidden = !active;
  }
  if (focus) $(`${tab}-tab`).focus();
}
function renderOrders(id, orders, accepted = false) {
  const list = $(id);
  const ids = new Set(orders.map(order => order.id));
  for (const card of [...list.children]) {
    if (ids.has(card.dataset.order)) continue;
    if (card.contains(document.activeElement)) $(`${phoneTab}-tab`).focus();
    card.remove();
  }
  for (const order of orders) {
    let card = [...list.children].find(item => item.dataset.order === order.id);
    if (!card) {
      card = $("order-card-template").content.firstElementChild.cloneNode(true);
      card.dataset.order = order.id;
      card.querySelector(".order-accept").addEventListener("click", () => perform(async () => {
        const wasPaused = paused; paused = true; await flush();
        await send("accept", { order: order.id });
        paused = wasPaused;
        selectPhoneTab("accepted");
      }));
      list.append(card);
    }
    const text = (selector, value) => { card.querySelector(selector).textContent = value; };
    const name = key => {
      const stop = stops.find(s => s.id === key);
      return stop?.[lang === "zh" ? "zh" : "name"] ?? "—";
    };
    text(".order-customer", order.passenger[lang === "zh" ? "zh" : "name"]);
    text(".order-role", order.passenger[lang === "zh" ? "role_zh" : "role"]);
    text(".order-pickup", `${t("pickup")}: ${name(order.pickup)}`);
    text(".order-destination", `${t("destination")}: ${name(order.destination)}`);
    text(".order-fare", `HK$ ${order.fare}`);
    text(".order-distance", `${order.distance} m · ${t("toPickup")}`);
    const accept = card.querySelector(".order-accept");
    accept.textContent = t("accept");
    accept.hidden = accepted;
    accept.disabled = busy || !state.can_accept;
  }
}
function setTripPanelOpen(open) {
  $("trip-panel").classList.toggle("open", open);
  $("trip-toggle").setAttribute("aria-expanded", String(open));
  $("trip-toggle").setAttribute("aria-label", t(open ? "tripHide" : "tripShow"));
  $("trip-details").inert = !open;
  $("trip-details").setAttribute("aria-hidden", String(!open));
}
function updateTripPanel() {
  const pickup = state.phase === "pickup" || (state.phase === "boarding" && state.order_source === "phone");
  const active = pickup || state.phase === "onboard";
  if (active && (tripPanelOrder !== state.active_order || !tripPanelPhase
      || (state.phase === "onboard" && tripPanelPhase !== "onboard"))) setTripPanelOpen(true);
  if (!active) {
    if (!$("trip-toggle").hidden && document.activeElement === $("trip-toggle")) $("phone-toggle").focus();
    setTripPanelOpen(false);
  }
  $("trip-toggle").hidden = !active;
  $("trip-toggle").setAttribute("aria-label", t($("trip-panel").classList.contains("open") ? "tripHide" : "tripShow"));
  tripPanelPhase = active ? state.phase : null;
  tripPanelOrder = active ? state.active_order : null;
  if (!active) return;
  const stop = stops.find(item => item.id === (pickup ? state.pickup : state.destination));
  $("trip-label").textContent = t(pickup ? "pickup" : "destination");
  $("trip-name").textContent = stop ? stop[lang === "zh" ? "zh" : "name"] : t("destinationHidden");
  const distance = routeDistance(state.route, roads, { x: state.x, y: state.y }, stop);
  $("trip-distance").textContent = distance === null ? t("routeDistanceUnavailable")
    : `${t("routeDistance")} · ${distance < 1000 ? `${Math.round(distance)} m` : `${(distance / 1000).toFixed(1)} km`}`;
}
function updateUI() {
  updateViewUI();
  document.documentElement.lang = lang === "zh" ? "zh-Hant" : "en";
  document.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-aria]").forEach(el => el.setAttribute("aria-label", t(el.dataset.i18nAria)));
  $("language").textContent = lang === "en" ? "繁中" : "EN";
  updateSettingsControls();
  if (!state) return;
  updateTripPanel();
  $("start").disabled = busy; $("start").textContent = t("start");
  const passenger = state.passenger;
  $("passenger-name").textContent = lang === "zh" ? passenger.zh : passenger.name;
  $("passenger-role").textContent = lang === "zh" ? passenger.role_zh : passenger.role;
  $("avatar").textContent = lang === "zh" ? passenger.zh.slice(-1) : passenger.name[0];
  for (const [element, key] of [["pickup-name", state.pickup], ["destination-name", state.destination]]) {
    const stop = stops.find(s => s.id === key);
    $(element).textContent = stop ? (lang === "zh" ? stop.zh : stop.name) : t("destinationHidden");
  }
  $("fare").textContent = state.phase === "boarding" ? "—" : `HK$ ${state.fare}`;
  $("status").textContent = t({ available: "available", pickup: "pickupStatus", boarding: "boarding", onboard: "onboard", complete: "complete" }[state.phase]);
  let dialogue;
  if (state.dialogue === "pickup" || state.dialogue === "arrival") dialogue = passenger[state.dialogue + (lang === "zh" ? "_zh" : "")];
  else dialogue = t({ refuel: "refuelDone", upgrade: "upgradeDone" }[state.dialogue] || state.dialogue);
  $("dialogue").textContent = `“${dialogue}”`;
  const jobAction = { available: "accept", pickup: "collect", boarding: "wait", onboard: "dropoff", complete: "next" }[state.phase];
  $("job-action").textContent = t(jobAction);
  $("job-action").disabled = busy || (["pickup", "onboard"].includes(state.phase) && !state.service_ready);
  $("cancel-job").hidden = !["pickup", "onboard"].includes(state.phase);
  $("cancel-job").disabled = busy;
  $("active-trip").hidden = state.phase === "available";
  $("job-action").hidden = state.phase === "boarding" || state.phase === "pickup";
  renderOrders("available-orders", state.offers ?? []);
  const waiting = (state.accepted_orders ?? []).filter(order => order.id !== state.active_order);
  renderOrders("accepted-orders", waiting, true);
  $("pending-title").hidden = !waiting.length;
  $("phone-count").textContent = String(state.offers?.length ?? 0);
  $("phone-toggle").setAttribute("aria-label", `${t("phoneToggle")} · ${state.offers?.length ?? 0} ${t("availableTab")}`);
  $("no-offers").hidden = Boolean(state.offers?.length);
  $("no-accepted").hidden = state.phase !== "available" || Boolean(state.accepted_orders?.length);
  $("order-notice").textContent = state.cancelled_orders
    ? `${t("waitingCancelled")} (${state.cancelled_orders})` : t("queueHelp");
  $("door").disabled = busy || paused || !state.citizens?.some(citizen => citizen.ready);
  $("door").hidden = state.phase === "onboard" || state.phase === "boarding";
  $("boarding-status").hidden = state.phase !== "boarding";
  $("street-dropoff").hidden = state.phase !== "onboard";
  $("street-dropoff").disabled = busy || paused || !state.service_ready;
  $("money").textContent = `$${state.money}`;
  $("trips").textContent = `${state.trips} ${t("trips")}`;
  $("fuel").textContent = `${Math.ceil(state.fuel)}%`;
  $("fuel-bar").style.width = `${state.fuel}%`;
  $("fuel-bar").style.background = state.fuel < 20 ? "#f07869" : "#92d7b6";
  $("clock").textContent = `${String(Math.floor(state.elapsed / 60)).padStart(2, "0")}:${String(Math.floor(state.elapsed % 60)).padStart(2, "0")}`;
  $("refuel").disabled = busy || !state.depot_ready || state.fuel >= 100 || state.money < Math.ceil((100 - state.fuel) * 0.5);
  for (const kind of ["efficiency", "engine"]) {
    $(kind).disabled = busy || !state.depot_ready || state.upgrades.includes(kind) || state.money < (kind === "efficiency" ? 100 : 160);
    if (state.upgrades.includes(kind)) $(kind).textContent += ` · ${t("installed")}`;
  }
  let notice = performance.now() < movementRecoveryUntil ? "movementRecovered"
    : boundary ? "boundary" : closureWarning ? "closed" : state.fuel <= 0 ? "empty" : state.warning || (state.no_route ? "noRoute" : "");
  $("notice").hidden = !notice;
  $("notice").textContent = notice ? t(notice) : "";
  if ($("junction").open) renderExits();
}
function updateViewUI() {
  const active = Boolean(map3d && view === map3d);
  $("view-mode").disabled = !state || changingView;
  $("view-mode").textContent = "M";
  $("view-mode").setAttribute("aria-label", t("mapTitle"));
  $("view-mode").setAttribute("aria-expanded", String(!$("map-popup").hidden));
  $("minimap").setAttribute("aria-label", t("minimap"));
  $("view-status").hidden = !active && !changingView;
  $("view-status").textContent = t(changingView ? "loading3d" : "preview3d");
  $("view-error").hidden = !viewError;
  $("view-error").textContent = viewError ? `${t(viewError.key)} ${viewError.detail}` : "";
  $("map-stream-error").hidden = !mapStreamFailure;
  $("map-stream-error").textContent = mapStreamFailure ? `${t("mapStreamError")} ${mapStreamFailure.message}` : "";
}
function setMapOpen(open) {
  const popup = $("map-popup");
  if (!popup || (open && (!state || dialogs.some(id => $(id).open)))) return;
  popup.hidden = !open;
  mapDrag = null;
  if (open) {
    if (!popupMap) popupMap = new MapView($("popup-map"), mapData, stops, { compact: true, interactive: true });
    popupMap.resize();
    popupMap.camera = { x: car.x, y: car.y };
    if (!popupMap.opened) {
      const [left, top, right, bottom] = mapData.bounds;
      popupMap.zoom = Math.max(.1, Math.min(popupMap.width / (right - left), popupMap.height / (bottom - top)) * .9);
      popupMap.opened = true;
    }
  }
  $("view-mode").setAttribute("aria-expanded", String(open));
}
function activateView(next) {
  next.zoom = view.zoom;
  next.overview = view.overview;
  next.camera = { x: car.x, y: car.y };
  view = next;
  $("map").hidden = view !== map2d;
  $("map-3d").hidden = view !== map3d;
  $("game").classList.toggle("view-3d", view === map3d);
  $("minimap-panel").hidden = view !== map3d || !preferences.minimapVisible;
  if (view === map3d) {
    if (!minimap) {
      minimap = new MapView($("minimap"), mapData, stops, { compact: true });
    }
    minimap.zoom = preferences.minimapZoom / 100;
    minimap.resize();
    lastMinimapFrame = -Infinity;
  }
  if (map3d) {
    map3d.label.hidden = view !== map3d;
    map3d.roadLabel.hidden = view !== map3d;
  }
  resetControls();
  updateViewUI();
}
async function toggleView() {
  if (!state || changingView) return;
  if (view === map3d) { activateView(map2d); return; }
  const requestAtStart = preferredViewRequest;
  changingView = true; viewError = null; updateViewUI();
  await new Promise(resolve => requestAnimationFrame(resolve));
  try {
    if (!map3d) {
      const { Map3DView } = await import("./map3d.mjs?v=route-guide-1");
      map3d = new Map3DView($("map-3d"), mapData, stops);
      map3d.applyPreferences(preferences);
    }
    if (preferredViewRequest === "2d") return;
    map3d.cameraReady = false;
    activateView(map3d);
  } catch (error) {
    viewError = { key: "failed3d", detail: error.message };
    console.error("3D renderer initialization failed", error);
  } finally {
    changingView = false;
    updateViewUI();
    if (preferredViewRequest === "3d" && requestAtStart !== "3d" && view !== map3d) {
      preferredViewRequest = null;
      toggleView();
    } else preferredViewRequest = null;
  }
}
function frame(timestamp) {
  if ($("junction").open && junctionInput.releaseDeadline !== null) {
    junctionInput.advance(timestamp);
    setExitPreview(junctionInput.preview);
  }
  const delta = Math.min((timestamp - (lastFrame || timestamp)) / 1000, 0.1); lastFrame = timestamp;
  if (state && !paused && (!moving || elapsed < 1.2)) {
    stepBank += delta;
    while (stepBank >= 1 / 60) {
      const dt = 1 / 60;
      stepBank -= dt;
      previousCar = { ...car };
      const match = localMatch();
      const factor = state.traffic[match.edge.way] || 1;
      if (state.boarding) car.speed = 0;
      const result = state.boarding ? { blocked: false, contact: false, closed: false } : stepCar(car, controls, dt, {
        acceleration: state.upgrades.includes("engine") ? roads.driving.upgraded_acceleration : roads.driving.acceleration,
        steeringSensitivity: preferences.steeringSensitivity / 100,
        traffic: factor,
        fuel: state.fuel, roads, closed: new Set(state.closed),
        selectedExit: state.selected_exit, selectedJunction: state.selected_junction,
      });
      boundary = (result.blocked || result.contact) && !result.closed;
      closureWarning = result.closed;
      if (result.junctionPoint) trail.push(result.junctionPoint);
      trail.push({ x: car.x, y: car.y, heading: car.heading });
      elapsed += dt;
      if (paused) break;
    }
    if (elapsed >= 0.3 && !moving && !busy && !pending) {
      // Boundary rejections recover in send(); other movement failures require attention.
      flush().catch(error => { if (!$("error-dialog").open) showError(error, false); });
    }
    if (!busy && nearJunction()) promptJunction();
    if (junctionLatch) {
      const node = mapData.nodes[junctionLatch];
      if (Math.hypot(car.x - node[0], car.y - node[1]) > 60) junctionLatch = null;
    }
  } else {
    stepBank = 0;
    previousCar = null;
    if (state && !paused && moving) {
      $("notice").hidden = false;
      $("notice").textContent = t("wait");
    }
  }
  if (view && state) {
    if (paused) previousCar = null;
    if (mapStream) {
      const ahead = Math.min(160, Math.abs(car.speed) * 3);
      const direction = car.speed < 0 ? -1 : 1;
      const x = car.x + Math.cos(car.heading) * ahead * direction;
      const y = car.y + Math.sin(car.heading) * ahead * direction;
      mapStream.interest("player", [Math.min(car.x, x) - VISUAL_STREAM_RADIUS,
        Math.min(car.y, y) - VISUAL_STREAM_RADIUS, Math.max(car.x, x) + VISUAL_STREAM_RADIUS,
        Math.max(car.y, y) + VISUAL_STREAM_RADIUS]);
    }
    const approach = roads.preview(car, new Set(state.closed));
    const preview = $("junction").open ? previewExit : null;
    visualElapsed = Math.max(visualElapsed, state.elapsed + inFlightElapsed + elapsed);
    const visualState = { ...state, elapsed: visualElapsed,
      route: upcomingRoute(state.route, roads.edges, car.edge) };
    const visualCar = interpolateCar(previousCar, car, stepBank * 60);
    view.render(visualCar, visualState, lang, approach, preview);
    if (popupMap && !$("map-popup").hidden) popupMap.render(visualCar, visualState, lang, approach, preview);
    if (view === map3d && minimap && preferences.minimapVisible
        && timestamp - lastMinimapFrame >= 1000 / preferences.minimapRefreshRate - 0.5) {
      minimap.render(visualCar, visualState, lang, approach, preview);
      lastMinimapFrame = timestamp;
    }
  }
  $("speed").textContent = Math.round(Math.abs(car.speed) * 3.6);
  $("drive-mode").textContent = t(car.speed < -0.05 ? "reverse" : "manual");
  requestAnimationFrame(frame);
}

$("language").addEventListener("click", () => commitPreferences({ ...preferences, language: lang === "en" ? "zh" : "en" }));
$("trip-toggle").addEventListener("click", () => setTripPanelOpen(!$("trip-panel").classList.contains("open")));
$("phone-toggle").addEventListener("click", () => setPhoneOpen(!$("phone").classList.contains("open")));
$("phone-close").addEventListener("click", () => setPhoneOpen(false));
for (const tab of ["available", "accepted"]) {
  $(`${tab}-tab`).addEventListener("click", () => selectPhoneTab(tab));
  $(`${tab}-tab`).addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    selectPhoneTab(event.key === "Home" ? "available" : event.key === "End" ? "accepted"
      : tab === "available" ? "accepted" : "available", true);
  });
}
let phoneSwipe = null;
let phoneSwipedAt = -Infinity;
$("phone").addEventListener("click", event => {
  if (performance.now() - phoneSwipedAt < 400) {
    event.preventDefault(); event.stopPropagation();
  }
}, true);
$("phone").addEventListener("pointerdown", event => {
  if (event.pointerType === "touch") phoneSwipe = { x: event.clientX, y: event.clientY };
});
window.addEventListener("pointerup", event => {
  if (!phoneSwipe) return;
  const dx = event.clientX - phoneSwipe.x, dy = event.clientY - phoneSwipe.y;
  phoneSwipe = null;
  if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    phoneSwipedAt = performance.now();
    setPhoneOpen(dx < 0);
  }
});
window.addEventListener("pointercancel", () => { phoneSwipe = null; });
$("door").addEventListener("click", () => perform(async () => {
  const wasPaused = paused; paused = true; await flush();
  const citizen = state.citizens?.find(item => item.ready);
  if (!citizen) throw new Error(t("stopFirst"));
  await send("door", { citizen: citizen.id });
  car.speed = 0; resetControls(); paused = wasPaused;
}));
$("street-dropoff").addEventListener("click", () => $("job-action").click());
$("view-mode").addEventListener("click", () => setMapOpen($("map-popup").hidden));
$("map-close").addEventListener("click", () => setMapOpen(false));
function zoomPopup(factor, x = popupMap?.width / 2, y = popupMap?.height / 2) {
  if (!popupMap) return;
  const old = popupMap.zoom;
  const zoom = Math.max(.1, Math.min(3.5, old * factor));
  popupMap.camera.x += (x - popupMap.width / 2) * (1 / old - 1 / zoom);
  popupMap.camera.y += (y - popupMap.height / 2) * (1 / old - 1 / zoom);
  popupMap.zoom = zoom;
}
$("popup-map").addEventListener("wheel", event => {
  event.preventDefault();
  const bounds = event.currentTarget.getBoundingClientRect();
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1);
  zoomPopup(Math.exp(-Math.max(-200, Math.min(200, delta)) * .002), event.clientX - bounds.left, event.clientY - bounds.top);
}, { passive: false });
$("popup-map").addEventListener("pointerdown", event => {
  if (event.button !== 0 || !popupMap) return;
  event.preventDefault();
  event.currentTarget.setPointerCapture(event.pointerId);
  mapDrag = { id: event.pointerId, x: event.clientX, y: event.clientY };
});
$("popup-map").addEventListener("pointermove", event => {
  if (!mapDrag || event.pointerId !== mapDrag.id) return;
  popupMap.camera.x -= (event.clientX - mapDrag.x) / popupMap.zoom;
  popupMap.camera.y -= (event.clientY - mapDrag.y) / popupMap.zoom;
  mapDrag.x = event.clientX; mapDrag.y = event.clientY;
});
for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
  $("popup-map").addEventListener(type, () => { mapDrag = null; });
}
$("map-3d").addEventListener("webglcontextlost", event => {
  event.preventDefault();
  if (map3d) {
    if (view === map3d) activateView(map2d);
    map3d.dispose(); map3d = null;
  }
  viewError = { key: "lost3d", detail: "" };
  updateViewUI();
});
$("map-3d").addEventListener("renderererror", event => {
  if (view === map3d) activateView(map2d);
  map3d?.dispose(); map3d = null;
  viewError = { key: "failed3d", detail: event.detail };
  updateViewUI();
});
$("start").addEventListener("click", resume);
$("resume").addEventListener("click", resume);
$("garage-close").addEventListener("click", resume);
$("pause").addEventListener("click", () => { if (!paused) pauseTo("pause-dialog"); else if ($("pause-dialog").open) resume(); });
$("welcome-settings").addEventListener("click", () => openSettings("welcome"));
$("pause-settings").addEventListener("click", () => openSettings("pause-dialog"));
$("settings-close").addEventListener("click", closeSettings);
$("settings-reset").addEventListener("click", () => {
  commitPreferences(resetSettingsCategory(preferences, settingsCategory), "resetDone");
});
for (const tab of document.querySelectorAll("[data-category]")) {
  tab.addEventListener("click", () => selectSettingsCategory(tab.dataset.category));
  tab.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll("[data-category]")];
    const index = tabs.indexOf(tab);
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : (index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
    selectSettingsCategory(tabs[next].dataset.category, true);
  });
}
for (const input of document.querySelectorAll("[data-setting]")) {
  const updatePreference = () => {
    const key = input.dataset.setting;
    const value = input.type === "checkbox" ? input.checked
      : typeof preferences[key] === "number" ? Number(input.value)
        : input.value;
    commitPreferences({ ...preferences, [key]: value });
  };
  input.addEventListener(input.tagName === "SELECT" ? "change" : "input", updatePreference);
}
$("settings-dialog").addEventListener("cancel", event => {
  event.preventDefault();
  closeSettings();
});
$("garage").addEventListener("click", () => pauseTo("garage-dialog"));
$("overview").addEventListener("click", () => {
  if (!$("map-popup").hidden && popupMap) {
    const [left, top, right, bottom] = mapData.bounds;
    popupMap.camera = { x: (left + right) / 2, y: (top + bottom) / 2 };
    popupMap.zoom = Math.max(.1, Math.min(popupMap.width / (right - left), popupMap.height / (bottom - top)) * .9);
  } else if (view) view.overview = !view.overview;
});
$("zoom-in").addEventListener("click", () => {
  if (!$("map-popup").hidden) zoomPopup(1.25);
  else if (view) { view.overview = false; view.zoom = Math.min(3.5, view.zoom * 1.25); }
});
$("zoom-out").addEventListener("click", () => {
  if (!$("map-popup").hidden) zoomPopup(1 / 1.25);
  else if (view) { view.overview = false; view.zoom = Math.max(0.35, view.zoom / 1.25); }
});
$("job-action").addEventListener("click", () => perform(async () => {
  const wasPaused = paused; paused = true; await flush();
  await send(({ available: "accept", pickup: "service", onboard: "service", complete: "next" })[state.phase]);
  if (state.phase === "complete" && state.accepted_orders?.length) await send("next");
  paused = wasPaused;
}));
$("cancel-job").addEventListener("click", () => perform(async () => {
  const wasPaused = paused; paused = true; await flush(); await send("next"); paused = wasPaused;
}));
for (const id of ["recover", "recover-pause"]) $(id).addEventListener("click", () => perform(async () => {
  await send("recover"); applyState(state, true); junctionLatch = null; openDialog("garage-dialog");
}));
$("refuel").addEventListener("click", () => perform(() => send("refuel")));
for (const kind of ["engine", "efficiency"]) $(kind).addEventListener("click", () => perform(() => send("upgrade", { kind })));
$("restart").addEventListener("click", () => location.reload());
$("error-close").addEventListener("click", () => {
  $("error-dialog").close();
  pauseTo("pause-dialog");
});
$("retry").addEventListener("click", async () => {
  if (!pending || busy) return;
  busy = true; $("retry").disabled = true;
  try {
    const next = await fetchJSON(`/api/sessions/${state.id}/commands`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pending),
    });
    pending = null; applyState(next, true);
    await send("pause", { paused: true });
    openDialog("pause-dialog");
  } catch (error) { showError(error, Boolean(pending)); }
  finally { busy = false; $("retry").disabled = false; updateUI(); }
});
for (const id of dialogs) $(id).addEventListener("cancel", event => {
  event.preventDefault();
  if (id === "pause-dialog" || id === "garage-dialog") resume();
});
const bindings = {
  w: "gas", arrowup: "gas", s: "brake", arrowdown: "brake",
  a: "left", arrowleft: "left", d: "right", arrowright: "right",
};
window.addEventListener("keydown", event => {
  const key = event.key.toLowerCase();
  if (key === "m" && !event.ctrlKey && !event.metaKey && !event.altKey
      && !["INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName)
      && !event.target.isContentEditable
      && !dialogs.some(id => $(id).open)) {
    event.preventDefault();
    if (!event.repeat) setMapOpen($("map-popup").hidden);
    return;
  }
  if (key === "e" && !event.repeat && !paused && !dialogs.some(id => $(id).open)) {
    $(state.phase === "onboard" ? "street-dropoff" : "door").click();
  }
  // Plain Tab toggles the phone; Shift+Tab keeps normal focus navigation.
  if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.altKey
      && !dialogs.some(id => $(id).open) && !$("junction").open) {
    event.preventDefault();
    if (!event.repeat) setPhoneOpen(!$("phone").classList.contains("open"));
    return;
  }
  if ($("junction").open && bindings[key]) {
    event.preventDefault();
    if (busy || event.repeat) return;
    const options = [...$("exits").children].map(button => ({
      edge: button.dataset.edge, direction: button.dataset.direction, angle: Number(button.dataset.angle),
    }));
    setExitPreview(junctionInput.press(key, bindings[key], options));
    return;
  }
  if (bindings[key] && !paused) { controls[bindings[key]] = true; event.preventDefault(); }
  if (event.code === "Space" && !paused) {
    controls.handbrake = true;
    event.preventDefault();
  }
  if (event.key === "Escape" && !event.repeat) {
    event.preventDefault();
    if (!$("map-popup").hidden) { setMapOpen(false); return; }
    if ($("settings-dialog").open) { closeSettings(); return; }
    if ($("pause-dialog").open) { resume(); return; }
    if ($("junction").open) return;
    if (dialogs.some(id => $(id).open)) return;
    if (!paused) pauseTo("pause-dialog");
  }
});
window.addEventListener("keyup", event => {
  const key = event.key.toLowerCase();
  if ($("junction").open && bindings[key]) {
    event.preventDefault();
    const selected = junctionInput.release(key);
    setExitPreview(junctionInput.preview);
    const button = [...$("exits").children].find(button => button.dataset.edge === selected);
    if (button && !busy) button.click();
  }
  if (bindings[event.key.toLowerCase()]) controls[bindings[event.key.toLowerCase()]] = false;
  if (event.code === "Space") controls.handbrake = false;
});
for (const button of document.querySelectorAll("[data-control]")) {
  button.addEventListener("pointerdown", event => {
    event.preventDefault(); button.setPointerCapture(event.pointerId);
    if (!paused) { controls[button.dataset.control] = true; button.classList.add("pressed"); }
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) button.addEventListener(type, () => {
    controls[button.dataset.control] = false; button.classList.remove("pressed");
  });
}
document.addEventListener("visibilitychange", () => { if (document.hidden) resetControls(); });
window.addEventListener("blur", resetControls);
window.addEventListener("resize", updateMinimapLayout);

applyPreferenceEffects();
openDialog("welcome");
requestAnimationFrame(frame);
try {
  [mapData, stops] = await Promise.all([fetchJSON("/api/map?stream=true"), fetchJSON("/api/stops")]);
  mapStream = visualStream(mapData, {
    onError: error => {
      console.error("Visual map streaming failed", error);
      mapStreamFailure = error;
      updateViewUI();
    },
    onRecovery: () => { if (mapStreamFailure) { mapStreamFailure = null; updateViewUI(); } },
  });
  roads = new RoadNetwork(mapData);
  map2d = new MapView($("map"), mapData, stops);
  view = map2d;
  applyState(await fetchJSON("/api/sessions", { method: "POST" }), true);
  view.camera = { x: car.x, y: car.y };
  if (preferences.defaultView === "3d") await toggleView();
} catch (error) { showError(new Error(`${t("loadFailed")} (${error.message})`), false); }
