export function terrainHeight(data, x, y) {
  const grid = data?.terrain;
  if (!grid) return 0;
  const u = Math.max(0, Math.min(grid.width - 1, (x - grid.origin[0]) / grid.spacing));
  const v = Math.max(0, Math.min(grid.height - 1, (y - grid.origin[1]) / grid.spacing));
  const i = Math.min(Math.floor(u), grid.width - 2), j = Math.min(Math.floor(v), grid.height - 2);
  const a = j * grid.width + i, b = a + grid.width, dx = u - i, dy = v - j;
  return ((1 - dx) * grid.values[a] + dx * grid.values[a + 1]) * (1 - dy)
    + ((1 - dx) * grid.values[b] + dx * grid.values[b + 1]) * dy;
}

export function surfacePose(roads, edge, point, heading) {
  const a = roads.nodes[edge.a], b = roads.nodes[edge.b];
  const heights = roads.elevation?.node_heights;
  if (!heights) return { height: 0, grade: 0, pitch: 0 };
  const za = heights[edge.a], zb = heights[edge.b];
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((point.x - a[0]) * dx + (point.y - a[1]) * dy) / (dx * dx + dy * dy)));
  const length = Math.hypot(dx, dy), profile = roads.elevation?.road_profiles?.[edge.id];
  let height = za + (zb - za) * t, grade = (zb - za) / length;
  if (profile) {
    const m0 = profile[0] * length, m1 = profile[1] * length, delta = zb - za;
    height = za + m0 * t + (3 * delta - 2 * m0 - m1) * t * t + (m0 + m1 - 2 * delta) * t * t * t;
    grade = (m0 + 2 * (3 * delta - 2 * m0 - m1) * t + 3 * (m0 + m1 - 2 * delta) * t * t) / length;
  }
  grade *= Math.cos(heading - Math.atan2(dy, dx));
  return { height, grade, pitch: Math.atan(grade) };
}

export function surfaceSegments(roads, edge, a = roads.nodes[edge.a], b = roads.nodes[edge.b]) {
  const profile = roads.elevation?.road_profiles?.[edge.id];
  const start = roads.nodes[edge.a], end = roads.nodes[edge.b];
  const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
  const delta = roads.elevation
    ? roads.elevation.node_heights[edge.b] - roads.elevation.node_heights[edge.a] : 0;
  let steps = 1;
  if (profile && profile.some(value => Math.abs(value - delta / length) > 1e-9)) {
    const m0 = profile[0] * length, m1 = profile[1] * length;
    const curvature = Math.max(Math.abs(6 * delta - 4 * m0 - 2 * m1), Math.abs(-6 * delta + 2 * m0 + 4 * m1));
    const span = Math.hypot(b[0] - a[0], b[1] - a[1]);
    // Linear interpolation error is at most max(|h''|) * step² / 8.
    steps = Math.max(1, Math.ceil(span / 2), Math.ceil(Math.sqrt(curvature / .04) * span / length));
  }
  return Array.from({ length: steps }, (_, i) => [i / steps, (i + 1) / steps].map(t =>
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]));
}

export function slopeSpeedLimit(maximum, grade) {
  return maximum * (1 - 2 * Math.min(.12, Math.abs(grade)));
}
