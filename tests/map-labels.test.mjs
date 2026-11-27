import assert from "node:assert/strict";
import test from "node:test";
import { roadAreaLabel } from "../web/map.mjs";

test("unnamed local roads show only a named area or building they overlap", () => {
  const labels = [
    { kind: "estate", name: "Sorrento", zh: "擎天半島", point: [5, 5],
      polygon: [[0, 0], [10, 0], [10, 10], [0, 10]] },
    { kind: "block", name: "Tower 1", zh: "1座", point: [25, 5],
      polygon: [[20, 0], [30, 0], [30, 10], [20, 10]] },
  ];
  const edge = { name: "Local road", zh: "支路" };
  assert.equal(roadAreaLabel(edge, [[2, 5], [8, 5]], labels, "en"), "Sorrento");
  assert.equal(roadAreaLabel(edge, [[-5, 5], [15, 5]], labels, "en"), "Sorrento");
  assert.equal(roadAreaLabel(edge, [[22, 5], [28, 5]], labels, "zh"), "1座");
  assert.equal(roadAreaLabel(edge, [[12, 5], [18, 5]], labels, "en"), "Local road");
  assert.equal(roadAreaLabel({ name: "Nathan Road", zh: "彌敦道" },
    [[2, 5], [8, 5]], labels, "en"), "Nathan Road");
});
