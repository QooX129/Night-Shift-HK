export function angleDifference(a, b) {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}
export const STEERING_SENSITIVITY = 3;
export const BOUNDARY_DRAG = 1;
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
    return (this.driving.widths[edge.kind] ?? 10) / 2
      - (this.driving.taxi_length ? 0 : this.driving.taxi_radius);
  }
  bodyFits(point, heading, previous, padding = 0, allowance = 0) {
    if (!this.driving.taxi_length) return true;
    const halfLength = this.driving.taxi_length / 2 + padding, halfWidth = this.driving.taxi_width / 2 + padding;
    const cos = Math.cos(heading), sin = Math.sin(heading);
    const edges = this.candidates(point, previous);
    const [left, top, right, bottom] = this.bounds;
    const world = (x, y) => ({ x: point.x + x * cos - y * sin, y: point.y + x * sin + y * cos });
    const inside = (p, edge) => project(p, this.nodes[edge.a], this.nodes[edge.b]).distance <= this.radius(edge) + allowance + 1e-6;
    const covered = (x0, y0, x1, y1, depth) => {
      const corners = [world(x0, y0), world(x1, y0), world(x1, y1), world(x0, y1)];
      if (corners.some(p => p.x < left - allowance || p.x > right + allowance
          || p.y < top - allowance || p.y > bottom + allowance)) return false;
      // A road capsule is convex: covering all four corners covers the whole cell.
      if (edges.some(edge => corners.every(p => inside(p, edge)))) return true;
      if (depth === 0 || corners.some(p => !edges.some(edge => inside(p, edge)))) return false;
      const x = (x0 + x1) / 2, y = (y0 + y1) / 2;
      return covered(x0, y0, x, y, depth - 1) && covered(x, y0, x1, y, depth - 1)
        && covered(x0, y, x, y1, depth - 1) && covered(x, y, x1, y1, depth - 1);
    };
    return covered(-halfLength, -halfWidth, halfLength, halfWidth, 6);
  }
  penetration(point, heading, previous) {
    if (this.bodyFits(point, heading, previous)) return 0;
    let low = 0, high = Math.hypot(this.driving.taxi_length, this.driving.taxi_width);
    for (let i = 0; i < 32; i++) {
      const middle = (low + high) / 2;
      if (this.bodyFits(point, heading, previous, 0, middle)) high = middle;
      else low = middle;
    }
    return high;
  }
  rotationFits(point, from, to, previous) {
    const angle = angleDifference(to, from), steps = Math.max(1, Math.ceil(Math.abs(angle) / 0.02));
    if (angle === 0) return this.bodyFits(point, from, previous);
    // Enclose the angular sweep between samples, not only the endpoint poses.
    const padding = Math.hypot(this.driving.taxi_length || 0, this.driving.taxi_width || 0)
      * Math.abs(angle) / (4 * steps);
    for (let i = 1; i <= steps; i++) {
      if (!this.bodyFits(point, from + angle * (i - 0.5) / steps, previous, padding)) return false;
    }
    return true;
  }
  candidates(point, previous, selectedExit = null, selectedJunction = null) {
    const found = new Map([[previous.id, previous]]), stack = [previous];
    while (stack.length) {
      const edge = stack.pop();
      for (const node of [edge.a, edge.b]) {
        const [x, y] = this.nodes[node];
        const reach = this.driving.taxi_length
          ? Math.hypot(this.driving.taxi_length, this.driving.taxi_width) / 2 : 1;
        if (Math.hypot(point.x - x, point.y - y) > this.radius(edge) + reach) continue;
        for (const next of this.outgoing.get(node) || []) {
          if (node === selectedJunction && next.id !== selectedExit) continue;
          if (!found.has(next.id)) { found.set(next.id, next); stack.push(next); }
        }
      }
    }
    for (const edge of this.outgoing.get(previous.b) || []) {
      if (edge.a === selectedJunction && edge.id !== selectedExit) continue;
      if (edge.b === previous.a && edge.way === previous.way) found.set(edge.id, edge);
    }
    return [...found.values()];
  }
  match(point, heading, previous, selectedExit = null, selectedJunction = null, allowance = 0) {
    if (!this.bodyFits(point, heading, previous, 0, allowance)) return null;
    let best = null;
    for (const edge of this.candidates(point, previous, selectedExit, selectedJunction)) {
      if (selectedJunction != null && edge.a === selectedJunction && edge.id !== selectedExit) continue;
      const projection = project(point, this.nodes[edge.a], this.nodes[edge.b]);
      if (projection.distance > this.radius(edge) + 1e-6) continue;
      const score = projection.distance + (1 - Math.cos(heading - this.angle(edge))) * 0.15;
      if (edge.id === previous.id && edge.b === selectedJunction && projection.t < 1
          && Math.cos(heading - this.angle(edge)) > 0.35) return { ...projection, edge, score };
      if (!best || score < best.score || (score === best.score && edge.id < best.edge.id)) best = { ...projection, edge, score };
    }
    return best;
  }
  constrain(old, desired, heading, previous, closed, selectedExit = null, selectedJunction = null) {
    const radius = this.driving.taxi_length ? 0 : this.driving.taxi_radius;
    const [left, top, right, bottom] = this.bounds;
    const inBounds = p => p.x >= left + radius && p.x <= right - radius && p.y >= top + radius && p.y <= bottom - radius;
    const approachingSelection = previous.b === selectedJunction
      && project(desired, this.nodes[previous.a], this.nodes[previous.b]).t < 1
      && Math.cos(heading - this.angle(previous)) > 0.35;
    const allowance = this.driving.taxi_length ? this.penetration(old, heading, previous) : 0;
    const desiredFits = this.driving.taxi_length && this.bodyFits(desired, heading, previous, 0, allowance);
    let best = null, sawClosed = false;
    for (const edge of this.candidates(desired, previous, selectedExit, selectedJunction)) {
      // Overlapping exit corridors must not bypass the full-width junction arrival.
      if (approachingSelection && edge.id !== previous.id) continue;
      if (selectedJunction != null && edge.a === selectedJunction && edge.id !== selectedExit) continue;
      if (closed.has(edge.way)) { sawClosed = true; continue; }
      const p = project(desired, this.nodes[edge.a], this.nodes[edge.b]);
      const relative = heading - this.angle(edge);
      const support = this.driving.taxi_length
        ? Math.abs(Math.sin(relative)) * this.driving.taxi_length / 2
          + Math.abs(Math.cos(relative)) * this.driving.taxi_width / 2 : 0;
      const limit = Math.max(0, this.radius(edge) - support + allowance);
      const scale = p.distance > limit ? limit / p.distance : 1;
      const point = desiredFits
        ? desired : { x: p.x + (desired.x - p.x) * scale, y: p.y + (desired.y - p.y) * scale };
      if (!inBounds(point)) continue;
      // Never use projection to jump onto a road beyond this frame's travel distance.
      if (Math.hypot(point.x - old.x, point.y - old.y) > Math.hypot(desired.x - old.x, desired.y - old.y) + 1e-6) continue;
      // Match the server's sampled path, not just endpoints across a concave road corner.
      const steps = Math.max(1, Math.ceil(Math.hypot(point.x - old.x, point.y - old.y) / 0.4));
      let current = previous, match = null;
      let cursor = old;
      for (let i = 1; i <= steps; i++) {
        const sample = { x: old.x + (point.x - old.x) * i / steps,
          y: old.y + (point.y - old.y) * i / steps };
        const tolerance = this.driving.taxi_length ? this.penetration(cursor, heading, current) : 0;
        match = this.match(sample, heading, current, selectedExit, selectedJunction, tolerance);
        if (!match || closed.has(match.edge.way)) { match = null; break; }
        current = match.edge;
        cursor = sample;
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
    const projection = project(car, this.nodes[edge.a], node);
    if (projection.distance > this.radius(edge) + 1e-6
        || (1 - projection.t) * edge.length > Math.min(60, edge.length * 0.8)) return null;
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
  traffic = 1, fuel = 100, closed = new Set(), selectedExit = null, selectedJunction = null,
} = {}) {
  const step = Math.min(Math.max(dt, 0), 1 / 30);
  if (input.handbrake) {
    car.speed = Math.sign(car.speed) * Math.max(0, Math.abs(car.speed) - 28 * step);
  } else if (input.brake) {
    car.speed = car.speed > 0 ? Math.max(0, car.speed - 19 * step) : fuel > 0 ? Math.max(-4 * traffic, car.speed - 3 * step) : 0;
  } else if (input.gas && fuel > 0) {
    car.speed = car.speed < 0 ? Math.min(0, car.speed + 19 * step) : Math.min(maxSpeed * traffic, car.speed + acceleration * step);
  } else {
    car.speed = Math.sign(car.speed) * Math.max(0, Math.abs(car.speed) - 2.8 * step);
  }
  car.speed = Math.max(-4 * traffic, Math.min(maxSpeed * traffic, car.speed));
  if (fuel <= 0) car.speed = 0;
  if (Math.abs(car.speed) > 0.05) {
    const manualSteering = ((input.right ? 1 : 0) - (input.left ? 1 : 0))
      * STEERING_SENSITIVITY
      * Math.max(-1, Math.min(1, car.speed / 3));
    car.heading += manualSteering * step;
  }
  const old = { x: car.x, y: car.y };
  const previous = roads?.edges.get(car.edge);
  const touching = roads?.driving.taxi_length && !roads.bodyFits(car, car.heading, previous, 0.02);
  if (touching) car.speed *= Math.exp(-BOUNDARY_DRAG * step);
  const desired = { x: car.x + Math.cos(car.heading) * car.speed * step, y: car.y + Math.sin(car.heading) * car.speed * step };
  const exit = roads?.edges.get(selectedExit);
  if (exit && previous.b === selectedJunction && exit.a === selectedJunction
      && car.speed > 0 && !closed.has(exit.way)) {
    const [x, y] = roads.nodes[selectedJunction];
    const incomingAngle = roads.angle(previous);
    const distance = (x - car.x) * Math.cos(incomingAngle) + (y - car.y) * Math.sin(incomingAngle);
    const travel = car.speed * step;
    const forwardTravel = (desired.x - car.x) * Math.cos(incomingAngle)
      + (desired.y - car.y) * Math.sin(incomingAngle);
    if (distance >= -1e-8 && distance <= forwardTravel + 1e-8 && forwardTravel > 0) {
      const arrival = roads.constrain(old, { x, y }, car.heading, previous, closed, selectedExit, selectedJunction);
      if (!arrival.blocked && roads.rotationFits({ x, y }, car.heading, roads.angle(exit), previous)) {
        const heading = roads.angle(exit);
        const remaining = Math.max(0, travel - distance);
        const departure = roads.constrain({ x, y }, {
          x: x + Math.cos(heading) * remaining, y: y + Math.sin(heading) * remaining,
        }, heading, exit, closed, selectedExit, selectedJunction);
        car.x = departure.x; car.y = departure.y;
        car.edge = departure.blocked ? departure.edge : exit.id;
        const junctionPoint = { x, y, heading: car.heading };
        car.heading = heading;
        return { ...departure, edge: car.edge, junctionPoint };
      }
    }
  }
  const constrained = roads
    ? roads.constrain(old, desired, car.heading, previous, closed, selectedExit, selectedJunction)
    : { ...desired, edge: car.edge, blocked: false, closed: false };
  car.x = constrained.x; car.y = constrained.y; car.edge = constrained.edge;
  const contact = touching || (roads?.driving.taxi_length
    && !roads.bodyFits(car, car.heading, roads.edges.get(car.edge), 0.02));
  if (roads?.driving.taxi_length && !touching && (contact || constrained.blocked) && !constrained.closed) {
    car.speed *= Math.exp(-BOUNDARY_DRAG * step);
  }
  if (constrained.blocked) {
    const travel = Math.hypot(car.x - old.x, car.y - old.y);
    if (travel < 1e-7 && (!roads?.driving.taxi_length || constrained.closed)) car.speed = 0;
  }
  return { ...constrained, contact: Boolean(contact) };
}
