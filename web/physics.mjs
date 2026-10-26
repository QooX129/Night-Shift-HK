export function angleDifference(a, b) {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}
export function project(point, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((point.x - a[0]) * dx + (point.y - a[1]) * dy) / (dx * dx + dy * dy)));
  const x = a[0] + dx * t, y = a[1] + dy * t;
  return { x, y, t, distance: Math.hypot(point.x - x, point.y - y) };
}

export class RoadNetwork {
  constructor(data) {
    this.nodes = data.nodes;
    this.edges = new Map(data.edges.map(e => [e.id, e]));
    this.driving = data.driving;
    this.bounds = data.bounds;
    this.branchLevels = data.branch_levels;
    this.outgoing = new Map();
    for (const edge of this.edges.values()) {
      if (!this.outgoing.has(edge.a)) this.outgoing.set(edge.a, []);
      this.outgoing.get(edge.a).push(edge);
    }
  }
  angle(edge) {
    const a = this.nodes[edge.a], b = this.nodes[edge.b];
    return Math.atan2(b[1] - a[1], b[0] - a[0]);
  }
  radius(edge) {
    return (this.driving.widths[edge.kind] ?? 10) / 2 - this.driving.taxi_radius;
  }
  candidates(point, previous) {
    const found = new Map([[previous.id, previous]]), stack = [previous];
    while (stack.length) {
      const edge = stack.pop();
      for (const node of [edge.a, edge.b]) {
        const [x, y] = this.nodes[node];
        if (Math.hypot(point.x - x, point.y - y) > this.radius(edge) + 1) continue;
        for (const next of this.outgoing.get(node) || []) {
          if (!found.has(next.id)) { found.set(next.id, next); stack.push(next); }
        }
      }
    }
    for (const edge of this.outgoing.get(previous.b) || []) {
      if (edge.b === previous.a && edge.way === previous.way) found.set(edge.id, edge);
    }
    return [...found.values()];
  }
  match(point, heading, previous) {
    let best = null;
    for (const edge of this.candidates(point, previous)) {
      const projection = project(point, this.nodes[edge.a], this.nodes[edge.b]);
      if (projection.distance > this.radius(edge) + 1e-6) continue;
      const score = projection.distance + (1 - Math.cos(heading - this.angle(edge))) * 0.15;
      if (!best || score < best.score || (score === best.score && edge.id < best.edge.id)) best = { ...projection, edge, score };
    }
    return best;
  }
  constrain(old, desired, heading, previous, closed) {
    const radius = this.driving.taxi_radius;
    const [left, top, right, bottom] = this.bounds;
    const inBounds = p => p.x >= left + radius && p.x <= right - radius && p.y >= top + radius && p.y <= bottom - radius;
    let best = null, sawClosed = false;
    for (const edge of this.candidates(desired, previous)) {
      if (closed.has(edge.way)) { sawClosed = true; continue; }
      const p = project(desired, this.nodes[edge.a], this.nodes[edge.b]);
      const limit = this.radius(edge);
      const scale = p.distance > limit ? limit / p.distance : 1;
      const point = { x: p.x + (desired.x - p.x) * scale, y: p.y + (desired.y - p.y) * scale };
      if (!inBounds(point)) continue;
      // Never use projection to jump onto a road beyond this frame's travel distance.
      if (Math.hypot(point.x - old.x, point.y - old.y) > Math.hypot(desired.x - old.x, desired.y - old.y) + 1e-6) continue;
      // Match the server's sampled path, not just endpoints across a concave road corner.
      const steps = Math.max(1, Math.ceil(Math.hypot(point.x - old.x, point.y - old.y) / 0.4));
      let current = previous, match = null;
      for (let i = 1; i <= steps; i++) {
        const sample = { x: old.x + (point.x - old.x) * i / steps,
          y: old.y + (point.y - old.y) * i / steps };
        match = this.match(sample, heading, current);
        if (!match || closed.has(match.edge.way)) { match = null; break; }
        current = match.edge;
      }
      if (!match) continue;
      const error = Math.hypot(desired.x - point.x, desired.y - point.y);
      if (!best || error < best.error - 1e-8 || (Math.abs(error - best.error) < 1e-8 && match.score < best.match.score)) best = { ...point, error, match };
    }
    if (!best) return { x: old.x, y: old.y, edge: previous.id, blocked: true, closed: sawClosed };
    return { x: best.x, y: best.y, edge: best.match.edge.id, blocked: best.error > 1e-6, closed: false };
  }
  approach(car, closed = new Set()) {
    const edge = this.edges.get(car.edge);
    if (!edge || car.speed <= 0.6 || Math.cos(car.heading - this.angle(edge)) <= 0.35) return null;
    const node = this.nodes[edge.b];
    if (Math.hypot(car.x - node[0], car.y - node[1]) > Math.min(32, edge.length * 0.4)) return null;
    const options = (this.outgoing.get(edge.b) || []).filter(e => e.b !== edge.a && !closed.has(e.way));
    if (options.length < 2) return null;
    const levels = new Set(options.map(e => JSON.stringify(this.branchLevels[e.id])));
    return { node: edge.b, incoming: edge.id, options, stacked: levels.size > 1 };
  }
  traceRoad(edge, start, closed, visited = new Set()) {
    const edges = [], seen = new Set(visited);
    seen.add(edge.a);
    let options = [];
    while (!closed.has(edge.way)) {
      edges.push(edge);
      if (seen.has(edge.b)) break;
      seen.add(edge.b);
      options = (this.outgoing.get(edge.b) || []).filter(e => e.b !== edge.a && !closed.has(e.way));
      if (options.length !== 1) break;
      edge = options[0];
      options = [];
    }
    return { start, edges, node: edge.b, incoming: edge.id, options };
  }
  preview(car, closed = new Set()) {
    const edge = this.edges.get(car.edge);
    if (!edge || closed.has(edge.way) || car.speed < 0 || Math.cos(car.heading - this.angle(edge)) <= 0.35) return null;
    const start = project(car, this.nodes[edge.a], this.nodes[edge.b]);
    const path = this.traceRoad(edge, start, closed);
    const visited = new Set(path.edges.flatMap(e => [e.a, e.b]));
    return {
      ...path,
      exits: path.options.map(edge => ({ edge, path: this.traceRoad(edge, null, closed, visited) })),
    };
  }
}

export function stepCar(car, input, dt, {
  roads, maxSpeed = roads.driving.max_speed, acceleration = roads.driving.acceleration,
  traffic = 1, fuel = 100, closed = new Set(),
} = {}) {
  const step = Math.min(Math.max(dt, 0), 1 / 30);
  if (input.brake) {
    car.speed = car.speed > 0 ? Math.max(0, car.speed - 19 * step) : fuel > 0 ? Math.max(-4 * traffic, car.speed - 3 * step) : 0;
  } else if (input.gas && fuel > 0) {
    car.speed = car.speed < 0 ? Math.min(0, car.speed + 19 * step) : Math.min(maxSpeed * traffic, car.speed + acceleration * step);
  } else {
    car.speed = Math.sign(car.speed) * Math.max(0, Math.abs(car.speed) - 2.8 * step);
  }
  car.speed = Math.max(-4 * traffic, Math.min(maxSpeed * traffic, car.speed));
  if (fuel <= 0) car.speed = 0;
  if (Math.abs(car.speed) > 0.05) car.heading += ((input.right ? 1 : 0) - (input.left ? 1 : 0)) * 1.8 * Math.max(-1, Math.min(1, car.speed / 3)) * step;
  const old = { x: car.x, y: car.y };
  const desired = { x: car.x + Math.cos(car.heading) * car.speed * step, y: car.y + Math.sin(car.heading) * car.speed * step };
  const constrained = roads ? roads.constrain(old, desired, car.heading, roads.edges.get(car.edge), closed) : { ...desired, edge: car.edge, blocked: false, closed: false };
  car.x = constrained.x; car.y = constrained.y; car.edge = constrained.edge;
  if (constrained.blocked) {
    const travel = Math.hypot(car.x - old.x, car.y - old.y);
    if (travel < 1e-7) car.speed = 0;
  }
  return constrained;
}
