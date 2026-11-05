import { RoadNetwork, project } from "./physics.mjs?v=local-map-popup-1";
import { surfacePose, surfaceSegments } from "./elevation.mjs";
import { straightJoin } from "./straight-lines.mjs";

const mapLines = new WeakMap();
export const COLLISION_LINE_WIDTH = .25;
const pointAt = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

function rectangleInterval(a, b, bounds) {
  let low = 0, high = 1;
  for (let axis = 0; axis < 2; axis++) {
    const delta = b[axis] - a[axis];
    if (Math.abs(delta) < 1e-10) {
      if (a[axis] < bounds[axis] || a[axis] > bounds[axis + 2]) return [];
    } else {
      const first = (bounds[axis] - a[axis]) / delta, last = (bounds[axis + 2] - a[axis]) / delta;
      low = Math.max(low, Math.min(first, last));
      high = Math.min(high, Math.max(first, last));
    }
  }
  return high > low ? [[low, high]] : [];
}

function capsuleIntervals(a, b, roads, edge, inset = 0) {
  const start = roads.nodes[edge.a], end = roads.nodes[edge.b], radius = roads.radius(edge) - inset;
  const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
  const ux = (end[0] - start[0]) / length, uy = (end[1] - start[1]) / length;
  const local = p => [(p[0] - start[0]) * ux + (p[1] - start[1]) * uy,
    -(p[0] - start[0]) * uy + (p[1] - start[1]) * ux];
  const intervals = rectangleInterval(local(a), local(b), [0, -radius, length, radius]);
  const dx = b[0] - a[0], dy = b[1] - a[1], aa = dx * dx + dy * dy;
  for (const centre of [start, end]) {
    const x = a[0] - centre[0], y = a[1] - centre[1];
    const bb = 2 * (x * dx + y * dy), cc = x * x + y * y - radius * radius;
    const discriminant = bb * bb - 4 * aa * cc;
    if (discriminant < 0 || aa === 0) continue;
    const root = Math.sqrt(discriminant);
    const low = Math.max(0, (-bb - root) / (2 * aa)), high = Math.min(1, (-bb + root) / (2 * aa));
    if (high > low) intervals.push([low, high]);
  }
  return intervals;
}

function subtract(intervals, cuts) {
  for (const [low, high] of cuts) {
    intervals = intervals.flatMap(([a, b]) => high <= a || low >= b ? [[a, b]]
      : [...(low > a ? [[a, low]] : []), ...(high < b ? [[high, b]] : [])]);
  }
  return intervals;
}

const physicalKey = edge => `${edge.width ?? edge.kind}:${[edge.a, edge.b].sort().join(":")}`;

export class CollisionLines {
  constructor(data) {
    this.roads = new RoadNetwork(data);
  }
  all() {
    if (this.lines) return this.lines;
    const roads = this.roads;
    const edges = new Map([...roads.edges.values()].map(edge => [physicalKey(edge), edge]));
    const [left, top, right, bottom] = roads.bounds;
    const bounds = roads.bounds;
    const lines = [];
    const add = (a, b, edge, border = false) => {
      const clipped = rectangleInterval(a, b, bounds);
      if (!clipped.length) return;
      const originalA = a, originalB = b;
      a = pointAt(originalA, originalB, clipped[0][0]);
      b = pointAt(originalA, originalB, clipped[0][1]);
      const firstLine = lines.length;
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const profile = roads.elevation?.road_profiles?.[edge.id];
      const grade = roads.elevation
        ? (roads.elevation.node_heights[edge.b] - roads.elevation.node_heights[edge.a])
          / Math.hypot(roads.nodes[edge.b][0] - roads.nodes[edge.a][0],
            roads.nodes[edge.b][1] - roads.nodes[edge.a][1]) : 0;
      const curved = profile && profile.some(value => Math.abs(value - grade) > 1e-9);
      const steps = Math.max(1, Math.ceil(length / 2), curved ? surfaceSegments(roads, edge, a, b).length : 1);
      for (let i = 0; i < steps; i++) {
        const start = pointAt(a, b, i / steps), end = pointAt(a, b, (i + 1) / steps);
        let intervals = rectangleInterval(start, end, bounds);
        if (!intervals.length) continue;
        if (border) intervals = intervals.flatMap(([low, high]) =>
          capsuleIntervals(start, end, roads, edge).map(([a, b]) => [Math.max(low, a), Math.min(high, b)])
            .filter(([a, b]) => b > a));
        else {
          const middle = pointAt(start, end, .5), point = { x: middle[0], y: middle[1] };
          const height = surfacePose(roads, edge, point, 0).height;
          // Use the physics candidate set at the boundary, not a district-wide
          // road union: disconnected overlaps must not erase a blocking edge.
          for (const next of roads.candidates(point, edge)) {
            if (physicalKey(next) === physicalKey(edge)) continue;
            const joinedSurface = [edge.a, edge.b].some(node => node === next.a || node === next.b)
              && ["layer", "bridge", "tunnel"].every(tag => edge[tag] === next[tag]);
            if (!joinedSurface && roads.elevation
                && Math.abs(surfacePose(roads, next, point, 0).height - height) > .35) continue;
            // Coincident outer edges are still walls, not junction openings.
            intervals = subtract(intervals, capsuleIntervals(start, end, roads, next, .01));
          }
        }
        for (const [low, high] of intervals) {
          const first = pointAt(start, end, low), last = pointAt(start, end, high);
          if (Math.hypot(last[0] - first[0], last[1] - first[1]) > .01) {
            const previous = lines.length > firstLine ? lines[lines.length - 1] : null;
            if (previous && !curved
                && Math.hypot(previous.b[0] - first[0], previous.b[1] - first[1]) < 1e-7)
              previous.b = last;
            else lines.push({ a: first, b: last, edge });
          }
        }
      }
    };
    for (const edge of edges.values()) {
      const a = roads.nodes[edge.a], b = roads.nodes[edge.b], r = roads.radius(edge);
      const arcSteps = Math.max(8, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - .01 / r))));
      const angle = roads.angle(edge), ring = [];
      for (const [centre, start] of [[b, angle - Math.PI / 2], [a, angle + Math.PI / 2]]) {
        for (let i = 0; i <= arcSteps; i++) {
          const theta = start + i * Math.PI / arcSteps;
          ring.push([centre[0] + r * Math.cos(theta), centre[1] + r * Math.sin(theta)]);
        }
      }
      ring.push(ring[0]);
      for (let i = 1; i < ring.length; i++) add(ring[i - 1], ring[i], edge);
      for (const [start, end] of [
        [[left, top], [right, top]], [[right, top], [right, bottom]],
        [[right, bottom], [left, bottom]], [[left, bottom], [left, top]],
      ]) {
        if (Math.max(a[0], b[0]) + r < Math.min(start[0], end[0])
            || Math.min(a[0], b[0]) - r > Math.max(start[0], end[0])
            || Math.max(a[1], b[1]) + r < Math.min(start[1], end[1])
            || Math.min(a[1], b[1]) - r > Math.max(start[1], end[1])) continue;
        const clipped = rectangleInterval(start, end, bounds);
        for (const [low, high] of clipped) add(pointAt(start, end, low), pointAt(start, end, high), edge, true);
      }
    }
    const endpoint = p => p.map(value => Math.round(value * 1e6)).join(",");
    const starts = new Map();
    for (const line of lines) {
      const key = endpoint(line.a);
      if (!starts.has(key)) starts.set(key, []);
      starts.get(key).push(line);
    }
    const removed = new Set();
    for (const line of lines) {
      if (removed.has(line)) continue;
      const points = [line.a, line.b];
      const samples = [];
      while (true) {
        const next = (starts.get(endpoint(line.b)) ?? []).filter(candidate =>
          candidate !== line && !removed.has(candidate) && candidate.edge.way === line.edge.way
          && roads.radius(candidate.edge) === roads.radius(line.edge)
          && ["layer", "bridge", "tunnel"].every(tag => candidate.edge[tag] === line.edge[tag])
          && straightJoin(points, candidate.b));
        if (next.length !== 1) break;
        const candidate = next[0];
        const height = (edge, p) => surfacePose(roads, edge, { x: p[0], y: p[1] }, 0).height;
        const h0 = line.heights?.[0] ?? height(line.edge, line.a);
        const h1 = line.heights?.[1] ?? height(line.edge, line.b);
        const h2 = height(candidate.edge, candidate.b);
        const length = Math.hypot(candidate.b[0] - line.a[0], candidate.b[1] - line.a[1]);
        const fraction = Math.hypot(line.b[0] - line.a[0], line.b[1] - line.a[1]) / length;
        if (!samples.length) samples.push([line.a, h0], [pointAt(line.a, line.b, .5),
          height(line.edge, pointAt(line.a, line.b, .5))], [line.b, h1]);
        if (Math.abs(h1 - height(candidate.edge, candidate.a)) > .001
            || Math.abs(h1 - (h0 + (h2 - h0) * fraction)) > .001
            || samples.some(([p, h]) => Math.abs(h - (h0 + (h2 - h0)
              * project({ x: p[0], y: p[1] }, line.a, candidate.b).t)) > .001)
            || Math.abs(height(candidate.edge, pointAt(candidate.a, candidate.b, .5))
              - (h1 + h2) / 2) > .001) break;
        line.b = candidate.b;
        line.heights = [h0, h2];
        points.push(candidate.b);
        samples.push([candidate.b, h2]);
        removed.add(candidate);
      }
    }
    this.lines = lines.filter(line => !removed.has(line));
    return this.lines;
  }
}

export function staticCollisionLines(data) {
  if (!mapLines.has(data)) mapLines.set(data, new CollisionLines(data));
  return mapLines.get(data);
}
