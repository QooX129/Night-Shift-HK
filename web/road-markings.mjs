import { isElevatedRoad, isTunnelRoad, roadLayer, surfacePose } from "./elevation.mjs?v=tunnel-clearance-1";
import { subtractIntervals } from "./collision-lines.mjs?v=hk-streets-2";
import { roadWidth } from "./road-width.mjs";
import { SpatialGrid, pointBounds } from "./spatial-grid.mjs";

const caches = new WeakMap();

function clipSide(points, bound, direction) {
  const result = [];
  let previous = points.at(-1), previousDistance = direction * (previous[1] - bound);
  for (const point of points) {
    const distance = direction * (point[1] - bound);
    if ((previousDistance < 0 && distance > 0) || (previousDistance > 0 && distance < 0)) {
      const t = previousDistance / (previousDistance - distance);
      result.push([previous[0] + (point[0] - previous[0]) * t, bound]);
    }
    if (distance >= 0) result.push(point);
    previous = point; previousDistance = distance;
  }
  return result;
}

export function roadMarkingRanges(data, edge) {
  let cache = caches.get(data);
  if (!cache) {
    const unique = new Map(), nodes = new Map();
    for (const item of data.edges) {
      const key = `${item.way}:${[item.a, item.b].sort().join(":")}`;
      if (unique.has(key)) continue;
      unique.set(key, item);
      for (const node of [item.a, item.b]) {
        if (!nodes.has(node)) nodes.set(node, []);
        nodes.get(node).push(item);
      }
    }
    const index = new SpatialGrid([...unique.values()], item =>
      pointBounds([data.nodes[item.a], data.nodes[item.b]], roadWidth(data.driving, item) / 2), 64);
    cache = { nodes, index, ranges: new WeakMap() };
    caches.set(data, cache);
  }
  if (cache.ranges.has(edge)) return cache.ranges.get(edge);
  const a = data.nodes[edge.a], b = data.nodes[edge.b];
  const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
  if (!length) return [];
  const ux = dx / length, uy = dy / length, half = roadWidth(data.driving, edge) / 2;
  const local = point => [(point[0] - a[0]) * ux + (point[1] - a[1]) * uy,
    -(point[0] - a[0]) * uy + (point[1] - a[1]) * ux];
  let ranges = [[0, 1]];
  for (const other of cache.index.query(pointBounds([a, b], half))) {
    if (other.way === edge.way && [other.a, other.b].includes(edge.a)
        && [other.a, other.b].includes(edge.b)) continue;
    const shared = [edge.a, edge.b].find(node => node === other.a || node === other.b);
    const connected = shared !== undefined;
    if (edge.way === other.way && (!connected || cache.nodes.get(shared).length <= 2)) continue;
    if (!connected && (roadLayer(edge) !== roadLayer(other)
        || isElevatedRoad(edge) !== isElevatedRoad(other) || isTunnelRoad(edge) !== isTunnelRoad(other))) continue;
    const p = data.nodes[other.a], q = data.nodes[other.b];
    const ox = q[0] - p[0], oy = q[1] - p[1], otherLength = Math.hypot(ox, oy);
    if (!otherLength || Math.abs(ux * oy - uy * ox) / otherLength < .1) continue;
    const radius = roadWidth(data.driving, other) / 2, nx = -oy / otherLength * radius, ny = ox / otherLength * radius;
    let polygon = [[p[0] - nx, p[1] - ny], [p[0] + nx, p[1] + ny],
      [q[0] + nx, q[1] + ny], [q[0] - nx, q[1] - ny]].map(local);
    polygon = clipSide(polygon, -half, 1);
    if (!polygon.length) continue;
    polygon = clipSide(polygon, half, -1);
    if (!polygon.length) continue;
    const area = polygon.reduce((sum, point, i) => {
      const next = polygon[(i + 1) % polygon.length];
      return sum + point[0] * next[1] - next[0] * point[1];
    }, 0);
    if (Math.abs(area) < 1e-8) continue;
    // Remove the full-width section wherever the crossing touches the road.
    const low = Math.max(0, Math.min(...polygon.map(point => point[0])) / length);
    const high = Math.min(1, Math.max(...polygon.map(point => point[0])) / length);
    if (high - low < 1e-8) continue;
    if (data.elevation?.node_heights) {
      const distance = (low + high) * length / 2;
      const point = { x: a[0] + ux * distance, y: a[1] + uy * distance };
      if (Math.abs(surfacePose(data, edge, point, 0).height - surfacePose(data, other, point, 0).height) > .35) continue;
    }
    ranges = subtractIntervals(ranges, [[low, high]]);
    if (!ranges.length) break;
  }
  cache.ranges.set(edge, ranges);
  return ranges;
}
