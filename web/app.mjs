import { stepCar, RoadNetwork } from "./physics.mjs?v=settings-1";
import { MapView } from "./map.mjs?v=minimap-2";
import { en, zh } from "./i18n.mjs?v=junction-toggle-1";
import { JunctionInput, junctionDirection, junctionShortcuts } from "./junction-input.mjs?v=junction-hud-1";
import { SETTINGS_CATEGORIES, loadSettings, normalizeSettings, resetSettingsCategory, saveSettings } from "./settings.mjs?v=junction-toggle-1";

const $ = id => document.getElementById(id);
const loadedPreferences = loadSettings();
let preferences = loadedPreferences.settings;
let lang = preferences.language, state = null, view = null, mapData, stops;
let map2d = null, map3d = null, changingView = false, viewError = null;
let minimap = null, lastMinimapFrame = -Infinity;
let car = { x: 0, y: 0, speed: 0, heading: 0, edge: null }, roads;
let paused = true, busy = false, moving = false, pending = null, elapsed = 0, trail = [];
let junctionLatch = null, boundary = false, closureWarning = false, lastFrame = 0, stepBank = 0;
let previewExit = null;
let settingsMessage = loadedPreferences.error === "read" ? "settingsLoadError"
  : loadedPreferences.error === "invalid" ? "settingsInvalidError" : null;
let settingsOrigin = "welcome", settingsCategory = "display", preferredViewRequest = null;
const junctionInput = new JunctionInput({ releaseGrace: preferences.junctionGrace });
const controls = { gas: false, brake: false, handbrake: false, left: false, right: false };
const t = key => (lang === "zh" ? zh : en)[key] || key;
const dialogs = ["welcome", "junction", "pause-dialog", "garage-dialog", "error-dialog", "settings-dialog"];

function resetControls() {
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
    elapsed = 0; trail = [];
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
    applyState(next);
    return next;
  } catch (error) {
    if (error.status && error.status < 500) {
      pending = null;
      car = { x: state.x, y: state.y, speed: 0, heading: state.heading, edge: state.edge };
      elapsed = 0; trail = [];
    } else error.message = `${t("retryNetwork")} (${error.message})`;
    showError(error, Boolean(pending));
    throw error;
  }
}
async function flush() {
  while (moving) await new Promise(resolve => setTimeout(resolve, 10));
  if (!state || (elapsed < 0.001 && Math.hypot(car.x - state.x, car.y - state.y) < 0.05)) return;
  const dt = elapsed, samples = trail; elapsed = 0; trail = [];
  moving = true;
  try { await send("move", { x: car.x, y: car.y, speed: car.speed, heading: car.heading, dt, trail: samples }); }
  finally { moving = false; }
}
async function perform(task) {
  if (busy || pending) return;
  busy = true; updateUI();
  try { await task(); }
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
    paused = false; lastFrame = performance.now(); stepBank = 0; resetControls();
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
function updateUI() {
  updateViewUI();
  document.documentElement.lang = lang === "zh" ? "zh-Hant" : "en";
  document.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-aria]").forEach(el => el.setAttribute("aria-label", t(el.dataset.i18nAria)));
  $("language").textContent = lang === "en" ? "繁中" : "EN";
  updateSettingsControls();
  if (!state) return;
  $("start").disabled = busy; $("start").textContent = t("start");
  const passenger = state.passenger;
  $("passenger-name").textContent = lang === "zh" ? passenger.zh : passenger.name;
  $("passenger-role").textContent = lang === "zh" ? passenger.role_zh : passenger.role;
  $("avatar").textContent = lang === "zh" ? passenger.zh.slice(-1) : passenger.name[0];
  for (const [element, key] of [["pickup-name", state.pickup], ["destination-name", state.destination]]) {
    const stop = stops.find(s => s.id === key);
    $(element).textContent = lang === "zh" ? stop.zh : stop.name;
  }
  $("fare").textContent = `HK$ ${state.fare}`;
  $("status").textContent = t({ available: "available", pickup: "pickupStatus", onboard: "onboard", complete: "complete" }[state.phase]);
  let dialogue;
  if (state.dialogue === "pickup" || state.dialogue === "arrival") dialogue = passenger[state.dialogue + (lang === "zh" ? "_zh" : "")];
  else dialogue = t({ refuel: "refuelDone", upgrade: "upgradeDone" }[state.dialogue] || state.dialogue);
  $("dialogue").textContent = `“${dialogue}”`;
  const jobAction = { available: "accept", pickup: "collect", onboard: "dropoff", complete: "next" }[state.phase];
  $("job-action").textContent = t(jobAction);
  $("job-action").disabled = busy || (["pickup", "onboard"].includes(state.phase) && !state.service_ready);
  $("cancel-job").hidden = !["pickup", "onboard"].includes(state.phase);
  $("cancel-job").disabled = busy;
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
  let notice = boundary ? "boundary" : closureWarning ? "closed" : state.fuel <= 0 ? "empty" : state.warning || (state.no_route ? "noRoute" : "");
  $("notice").hidden = !notice;
  $("notice").textContent = notice ? t(notice) : "";
  if ($("junction").open) renderExits();
}
function updateViewUI() {
  const active = Boolean(map3d && view === map3d);
  $("view-mode").disabled = !state || changingView;
  $("view-mode").textContent = changingView ? "..." : active ? "2D" : "3D";
  $("view-mode").setAttribute("aria-label", t(active ? "view2d" : "view3d"));
  $("view-mode").setAttribute("aria-pressed", String(active));
  $("minimap").setAttribute("aria-label", t("minimap"));
  $("view-status").hidden = !active && !changingView;
  $("view-status").textContent = t(changingView ? "loading3d" : "preview3d");
  $("view-error").hidden = !viewError;
  $("view-error").textContent = viewError ? `${t(viewError.key)} ${viewError.detail}` : "";
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
      const { Map3DView } = await import("./map3d.mjs?v=settings-1");
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
      const match = localMatch();
      const factor = state.traffic[match.edge.way] || 1;
      const result = stepCar(car, controls, dt, {
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
      // Movement failures are displayed by send(); stop the simulation until resolved.
      flush().catch(error => { if (!$("error-dialog").open) showError(error, false); });
    }
    if (!busy && nearJunction()) promptJunction();
    if (junctionLatch) {
      const node = mapData.nodes[junctionLatch];
      if (Math.hypot(car.x - node[0], car.y - node[1]) > 60) junctionLatch = null;
    }
  } else {
    stepBank = 0;
    if (state && !paused && moving) {
      $("notice").hidden = false;
      $("notice").textContent = t("wait");
    }
  }
  if (view && state) {
    const approach = roads.preview(car, new Set(state.closed));
    const preview = $("junction").open ? previewExit : null;
    view.render(car, state, lang, approach, preview);
    if (view === map3d && minimap && preferences.minimapVisible
        && timestamp - lastMinimapFrame >= 1000 / preferences.minimapRefreshRate - 0.5) {
      minimap.render(car, state, lang, approach, preview);
      lastMinimapFrame = timestamp;
    }
  }
  $("speed").textContent = Math.round(Math.abs(car.speed) * 3.6);
  $("drive-mode").textContent = t(car.speed < -0.05 ? "reverse" : "manual");
  requestAnimationFrame(frame);
}

$("language").addEventListener("click", () => commitPreferences({ ...preferences, language: lang === "en" ? "zh" : "en" }));
$("view-mode").addEventListener("click", toggleView);
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
$("overview").addEventListener("click", () => { if (view) view.overview = !view.overview; });
$("zoom-in").addEventListener("click", () => { if (view) { view.overview = false; view.zoom = Math.min(3.5, view.zoom * 1.25); } });
$("zoom-out").addEventListener("click", () => { if (view) { view.overview = false; view.zoom = Math.max(0.35, view.zoom / 1.25); } });
$("job-action").addEventListener("click", () => perform(async () => {
  const wasPaused = paused; paused = true; await flush();
  await send(({ available: "accept", pickup: "service", onboard: "service", complete: "next" })[state.phase]);
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
  [mapData, stops] = await Promise.all([fetchJSON("/api/map"), fetchJSON("/api/stops")]);
  roads = new RoadNetwork(mapData);
  map2d = new MapView($("map"), mapData, stops);
  view = map2d;
  applyState(await fetchJSON("/api/sessions", { method: "POST" }), true);
  view.camera = { x: car.x, y: car.y };
  if (preferences.defaultView === "3d") await toggleView();
} catch (error) { showError(new Error(`${t("loadFailed")} (${error.message})`), false); }
