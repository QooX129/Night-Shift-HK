import { stepCar, RoadNetwork } from "./physics.mjs";
import { MapView } from "./map.mjs";
import { en, zh } from "./i18n.mjs";

const $ = id => document.getElementById(id);
let lang = "en", state = null, view = null, mapData, stops;
let car = { x: 0, y: 0, speed: 0, heading: 0, edge: null }, roads;
let paused = true, busy = false, moving = false, pending = null, elapsed = 0, trail = [];
let junctionLatch = null, boundary = false, closureWarning = false, lastFrame = 0, stepBank = 0;
const controls = { gas: false, brake: false, handbrake: false, left: false, right: false };
const t = key => (lang === "zh" ? zh : en)[key] || key;
const dialogs = ["welcome", "junction", "pause-dialog", "garage-dialog", "error-dialog"];

function resetControls() {
  for (const key of Object.keys(controls)) controls[key] = false;
  document.querySelectorAll("[data-control]").forEach(b => b.classList.remove("pressed"));
}
function openDialog(id) {
  for (const other of dialogs) if (other !== id) $(other).close();
  if (!$(id).open) $(id).showModal();
  resetControls();
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
    paused = false; lastFrame = performance.now(); stepBank = 0; resetControls();
  });
}
function localMatch() {
  if (!state || !view) return null;
  return { edge: roads.edges.get(car.edge) };
}
function nearJunction() {
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
  $("exits").replaceChildren();
  const index = state.route?.indexOf(state.edge) ?? -1;
  const suggested = index >= 0 ? state.route[index + 1] : null;
  for (const option of state.options) {
    const degrees = option.angle * 180 / Math.PI;
    const direction = Math.abs(degrees) > 150 ? "uturn" : Math.abs(degrees) < 35 ? "straight" : degrees < 0 ? "left" : "right";
    const button = document.createElement("button");
    button.className = `exit-option ${option.edge === suggested ? "recommended" : ""}`;
    const arrow = document.createElement("span"); arrow.className = "arrow";
    arrow.textContent = { left: "↰", right: "↱", straight: "↑", uturn: "↶" }[direction];
    const text = document.createElement("span");
    text.textContent = `${t(direction)} · ${lang === "zh" ? option.zh : option.name}`;
    const small = document.createElement("small");
    small.textContent = option.edge === suggested ? t("suggested") : lang === "zh" ? option.name : option.zh;
    if (option.restricted) small.textContent += ` · ${t("restricted")}`;
    text.append(small); button.append(arrow, text);
    button.addEventListener("click", () => perform(async () => {
      await send("select_road", { incoming: state.edge, exit: option.edge });
      junctionLatch = state.selected_junction;
      $("junction").close(); paused = false; resetControls();
    }));
    $("exits").append(button);
  }
}
function updateUI() {
  document.documentElement.lang = lang === "zh" ? "zh-Hant" : "en";
  document.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
  $("language").textContent = lang === "en" ? "繁中" : "EN";
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
function frame(timestamp) {
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
        traffic: factor,
        fuel: state.fuel, roads, closed: new Set(state.closed),
        selectedExit: state.selected_exit, selectedJunction: state.selected_junction,
      });
      boundary = result.blocked && !result.closed;
      closureWarning = result.closed;
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
  if (view && state) view.render(car, state, lang, roads.preview(car, new Set(state.closed)));
  $("speed").textContent = Math.round(Math.abs(car.speed) * 3.6);
  $("drive-mode").textContent = t(car.speed < -0.05 ? "reverse" : "manual");
  requestAnimationFrame(frame);
}

$("language").addEventListener("click", () => { lang = lang === "en" ? "zh" : "en"; updateUI(); });
$("start").addEventListener("click", resume);
$("resume").addEventListener("click", resume);
$("garage-close").addEventListener("click", resume);
$("pause").addEventListener("click", () => { if (!paused) pauseTo("pause-dialog"); else if ($("pause-dialog").open) resume(); });
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
  if (bindings[key] && !paused) { controls[bindings[key]] = true; event.preventDefault(); }
  if (event.code === "Space" && !paused) {
    controls.handbrake = true;
    event.preventDefault();
  }
  if (event.key === "Escape" && !event.repeat) {
    event.preventDefault();
    if ($("junction").open) return;
    if (dialogs.some(id => $(id).open)) return;
    if (!paused) pauseTo("pause-dialog");
  }
});
window.addEventListener("keyup", event => {
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
document.addEventListener("visibilitychange", () => { if (document.hidden && !paused) pauseTo("pause-dialog"); });
window.addEventListener("blur", () => { resetControls(); if (!paused) pauseTo("pause-dialog"); });

openDialog("welcome");
requestAnimationFrame(frame);
try {
  [mapData, stops] = await Promise.all([fetchJSON("/api/map"), fetchJSON("/api/stops")]);
  roads = new RoadNetwork(mapData);
  view = new MapView($("map"), mapData, stops);
  applyState(await fetchJSON("/api/sessions", { method: "POST" }), true);
  view.camera = { x: car.x, y: car.y };
} catch (error) { showError(new Error(`${t("loadFailed")} (${error.message})`), false); }
