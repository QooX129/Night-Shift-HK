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

function surface(roads, start, end, point, profile) {
  const a = roads.nodes[start], b = roads.nodes[end];
  const heights = roads.elevation.node_heights;
  const za = heights[start], zb = heights[end];
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const projection = ((point.x - a[0]) * dx + (point.y - a[1]) * dy) / (dx * dx + dy * dy);
  const t = Math.max(0, Math.min(1, projection));
  const length = Math.hypot(dx, dy);
  let height = za + (zb - za) * t, grade = (zb - za) / length;
  if (profile) {
    const m0 = profile[0] * length, m1 = profile[1] * length, delta = zb - za;
    height = za + m0 * t + (3 * delta - 2 * m0 - m1) * t * t + (m0 + m1 - 2 * delta) * t * t * t;
    grade = (m0 + 2 * (3 * delta - 2 * m0 - m1) * t + 3 * (m0 + m1 - 2 * delta) * t * t) / length;
  }
  if (projection < 0 || projection > 1) grade = 0;
  return { height, gx: grade * dx / length, gy: grade * dy / length };
}

function blendedSurface(roads, id, start, end, point, profile) {
  let { height, gx, gy } = surface(roads, start, end, point, profile);
  const ownersByPriority = new Map();
  for (const owner of roads.elevation.road_junctions?.[id] ?? []) {
    const a = roads.nodes[owner.a], b = roads.nodes[owner.b];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((point.x - a[0]) * dx + (point.y - a[1]) * dy) / (dx * dx + dy * dy)));
    const ox = point.x - a[0] - t * dx, oy = point.y - a[1] - t * dy;
    const distance = Math.hypot(ox, oy), gap = Math.max(0, distance - owner.radius - .2);
    const closest = ownersByPriority.get(owner.priority);
    if (!closest || distance - owner.radius < closest.distance - closest.owner.radius
        || (distance - owner.radius === closest.distance - closest.owner.radius && owner.id < closest.owner.id))
      ownersByPriority.set(owner.priority, { gap, distance, ox, oy, owner });
  }
  for (const priority of [...ownersByPriority.keys()].sort((a, b) => b - a)) {
    const closest = ownersByPriority.get(priority);
    if (closest.gap >= 8) continue;
    const { gap, distance, ox, oy, owner } = closest;
    const main = surface(roads, owner.a, owner.b, point, owner.profile);
    const t = gap / 8, weight = 1 - t * t * (3 - 2 * t), derivative = -6 * t * (1 - t) / 8;
    const wx = distance ? derivative * ox / distance : 0, wy = distance ? derivative * oy / distance : 0;
    gx = gx * (1 - weight) + main.gx * weight + (main.height - height) * wx;
    gy = gy * (1 - weight) + main.gy * weight + (main.height - height) * wy;
    height += (main.height - height) * weight;
  }
  return { height, gx, gy };
}

export function surfacePose(roads, edge, point, heading) {
  if (!roads.elevation?.node_heights) return { height: 0, grade: 0, pitch: 0 };
  const { height, gx, gy } = blendedSurface(roads, edge.id, edge.a, edge.b, point,
    roads.elevation.road_profiles?.[edge.id]);
  const grade = gx * Math.cos(heading) + gy * Math.sin(heading);
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
  const segments = Array.from({ length: steps }, (_, i) => [i / steps, (i + 1) / steps].map(t =>
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]));
  if (!roads.elevation?.road_junctions?.[edge.id]) return segments;
  const radius = (edge.width ?? roads.data?.driving?.widths?.[edge.kind] ?? 10) / 2;
  const nx = -(end[1] - start[1]) / length, ny = (end[0] - start[0]) / length;
  const refined = [];
  const split = (a, b, depth) => {
    const at = (p, side) => surfacePose(roads, edge, { x: p[0] + nx * radius * side,
      y: p[1] + ny * radius * side }, 0).height;
    const inaccurate = [-1, 0, 1].some(side => {
      const za = at(a, side), zb = at(b, side);
      return [.25, .5, .75].some(t => {
        const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        return Math.abs(at(p, side) - za * (1 - t) - zb * t) > .002;
      });
    });
    if (depth < 14 && (Math.hypot(b[0] - a[0], b[1] - a[1]) > 2 || inaccurate)) {
      const middle = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      split(a, middle, depth + 1); split(middle, b, depth + 1);
    } else refined.push([a, b]);
  };
  for (const [a, b] of segments) split(a, b, 0);
  return refined;
}

export function slopeSpeedLimit(maximum, grade) {
  return maximum * (1 - 2 * Math.min(.12, Math.abs(grade)));
}
