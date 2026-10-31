export const SETTINGS_KEY = "night-shift-hk.settings.v1";

export const DEFAULT_SETTINGS = Object.freeze({
  language: "en",
  defaultView: "2d",
  graphics: "auto",
  cameraSmoothness: 60,
  cameraRotationSpeed: 90,
  chaseDistance: 100,
  reducedMotion: false,
  steeringSensitivity: 300,
  junctionGrace: 150,
  minimapVisible: true,
  minimapSize: "medium",
  minimapZoom: 90,
  minimapRefreshRate: 60,
  junctionHudOpacity: 70,
  shortcutHints: true,
  junctionSelector: true,
});

export const SETTINGS_CATEGORIES = Object.freeze({
  display: Object.freeze(["defaultView", "graphics"]),
  camera: Object.freeze(["cameraSmoothness", "cameraRotationSpeed", "chaseDistance", "reducedMotion"]),
  controls: Object.freeze(["steeringSensitivity", "junctionGrace"]),
  interface: Object.freeze(["minimapVisible", "minimapSize", "minimapZoom", "minimapRefreshRate", "junctionHudOpacity", "shortcutHints", "junctionSelector"]),
  language: Object.freeze(["language"]),
});

const enums = {
  language: ["en", "zh"],
  defaultView: ["2d", "3d"],
  graphics: ["auto", "quality", "performance"],
  minimapSize: ["small", "medium", "large"],
  minimapRefreshRate: [30, 60],
};

const ranges = {
  cameraSmoothness: [0, 100],
  cameraRotationSpeed: [20, 200],
  chaseDistance: [70, 150],
  steeringSensitivity: [75, 600],
  junctionGrace: [0, 500],
  minimapZoom: [50, 200],
  junctionHudOpacity: [40, 100],
};

const steps = {
  cameraSmoothness: 5,
  cameraRotationSpeed: 10,
  chaseDistance: 5,
  steeringSensitivity: 25,
  junctionGrace: 25,
  minimapZoom: 5,
  junctionHudOpacity: 5,
};

const booleanKeys = ["reducedMotion", "minimapVisible", "shortcutHints", "junctionSelector"];

export function normalizeSettings(value) {
  const settings = { ...DEFAULT_SETTINGS };
  const issues = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { settings, issues: ["settings"] };
  }
  for (const [key, choices] of Object.entries(enums)) {
    if (!(key in value)) continue;
    if (choices.includes(value[key])) settings[key] = value[key];
    else issues.push(key);
  }
  for (const key of booleanKeys) {
    if (!(key in value)) continue;
    if (typeof value[key] === "boolean") settings[key] = value[key];
    else issues.push(key);
  }
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (!(key in value)) continue;
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
      issues.push(key);
      continue;
    }
    const bounded = Math.max(min, Math.min(max, value[key]));
    settings[key] = min + Math.round((bounded - min) / steps[key]) * steps[key];
    if (settings[key] !== value[key]) issues.push(key);
  }
  return { settings, issues };
}

export function loadSettings(storage) {
  try {
    const target = storage ?? globalThis.localStorage;
    const serialized = target.getItem(SETTINGS_KEY);
    if (serialized === null) return { settings: { ...DEFAULT_SETTINGS }, error: null };
    let value;
    try { value = JSON.parse(serialized); }
    catch { return { settings: { ...DEFAULT_SETTINGS }, error: "invalid" }; }
    const result = normalizeSettings(value);
    return { settings: result.settings, error: result.issues.length ? "invalid" : null };
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, error: "read" };
  }
}

export function saveSettings(settings, storage) {
  try {
    const target = storage ?? globalThis.localStorage;
    const normalized = normalizeSettings(settings).settings;
    target.setItem(SETTINGS_KEY, JSON.stringify(normalized));
    return true;
  } catch {
    return false;
  }
}

export function resetSettingsCategory(settings, category) {
  const keys = SETTINGS_CATEGORIES[category];
  if (!keys) return { ...settings };
  const next = { ...settings };
  for (const key of keys) next[key] = DEFAULT_SETTINGS[key];
  return next;
}
