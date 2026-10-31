import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  loadSettings,
  normalizeSettings,
  resetSettingsCategory,
  saveSettings,
} from "../web/settings.mjs";

function storage(initial = null) {
  let value = initial;
  return {
    getItem: key => key === SETTINGS_KEY ? value : null,
    setItem: (key, next) => { if (key === SETTINGS_KEY) value = next; },
    get value() { return value; },
  };
}

test("settings load with validated defaults and persist independently of a shift", () => {
  const store = storage();
  const loaded = loadSettings(store);
  assert.deepEqual(loaded, { settings: { ...DEFAULT_SETTINGS }, error: null });
  const changed = { ...loaded.settings, language: "zh", steeringSensitivity: 475 };
  assert.equal(saveSettings(changed, store), true);
  assert.deepEqual(loadSettings(store), { settings: changed, error: null });
});

test("invalid saved values use defaults or safe bounds and report a load warning", () => {
  const store = storage(JSON.stringify({
    language: "fr", defaultView: "3d", minimapVisible: "yes",
    steeringSensitivity: 900, junctionGrace: -12, extra: "ignored",
  }));
  const result = loadSettings(store);
  assert.equal(result.error, "invalid");
  assert.equal(result.settings.language, DEFAULT_SETTINGS.language);
  assert.equal(result.settings.defaultView, "3d");
  assert.equal(result.settings.minimapVisible, DEFAULT_SETTINGS.minimapVisible);
  assert.equal(result.settings.steeringSensitivity, 600);
  assert.equal(result.settings.junctionGrace, 0);
});

test("malformed data and storage exceptions fall back with visible error states", () => {
  assert.equal(loadSettings(storage("{")).error, "invalid");
  const denied = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
  };
  assert.deepEqual(loadSettings(denied), { settings: { ...DEFAULT_SETTINGS }, error: "read" });
  assert.equal(saveSettings(DEFAULT_SETTINGS, denied), false);
});

test("category reset changes only that category", () => {
  const changed = { ...DEFAULT_SETTINGS, language: "zh", cameraSmoothness: 20, minimapSize: "large" };
  const reset = resetSettingsCategory(changed, "camera");
  assert.equal(reset.cameraSmoothness, DEFAULT_SETTINGS.cameraSmoothness);
  assert.equal(reset.language, "zh");
  assert.equal(reset.minimapSize, "large");
  assert.deepEqual(normalizeSettings(reset).settings, reset);
});

test("junction selector defaults on for old preferences and persists/reset as a boolean", () => {
  assert.equal(normalizeSettings({ language: "en" }).settings.junctionSelector, true);
  const store = storage();
  const settings = { ...DEFAULT_SETTINGS, junctionSelector: false };
  saveSettings(settings, store);
  assert.equal(loadSettings(store).settings.junctionSelector, false);
  assert.equal(resetSettingsCategory(settings, "interface").junctionSelector, true);
  assert.equal(normalizeSettings({ junctionSelector: "false" }).issues.includes("junctionSelector"), true);
});
