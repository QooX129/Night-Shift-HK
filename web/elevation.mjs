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
  const grade = (zb - za) / Math.hypot(b[0] - a[0], b[1] - a[1])
    * Math.cos(heading - Math.atan2(b[1] - a[1], b[0] - a[0]));
  return { height: za + (zb - za) * t, grade, pitch: Math.atan(grade) };
}

export function slopeSpeedLimit(maximum, grade) {
  return maximum * (1 - 2 * Math.min(.12, Math.abs(grade)));
}
