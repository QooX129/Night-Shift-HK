export const TAU = Math.PI * 2;
export function angleDifference(a, b) {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}
export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
export function project(point, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((point.x - a[0]) * dx + (point.y - a[1]) * dy) / (dx * dx + dy * dy)));
  const x = a[0] + dx * t, y = a[1] + dy * t;
  return { x, y, t, distance: Math.hypot(point.x - x, point.y - y) };
}
export function stepCar(car, input, dt, { maxSpeed = 18, traffic = 1, fuel = 100, bounds } = {}) {
  const step = Math.min(Math.max(dt, 0), 1 / 30);
  const acceleration = input.gas && fuel > 0 ? 7 : -2.8;
  car.speed = Math.max(0, Math.min(maxSpeed * traffic, car.speed + (input.brake ? -19 : acceleration) * step));
  if (car.speed > 0.05) car.heading += ((input.right ? 1 : 0) - (input.left ? 1 : 0)) * 1.8 * Math.min(car.speed / 3, 1) * step;
  const x = car.x + Math.cos(car.heading) * car.speed * step;
  const y = car.y + Math.sin(car.heading) * car.speed * step;
  if (bounds && (x < bounds[0] || y < bounds[1] || x > bounds[2] || y > bounds[3])) {
    car.speed = 0;
    return false;
  }
  car.x = x; car.y = y;
  return true;
}

export function makeAssist(car, edgeIds, edges, nodes) {
  const incoming = edges.get(edgeIds[0]);
  const approach = project(car, nodes[incoming.a], nodes[incoming.b]);
  const points = [[approach.x, approach.y], nodes[incoming.b]];
  for (let i = 1; i < edgeIds.length; i++) {
    const edge = edges.get(edgeIds[i]);
    const a = nodes[edge.a], b = nodes[edge.b];
    if (i === edgeIds.length - 1) {
      const t = Math.min(0.8, 20 / edge.length);
      points.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    } else points.push(b);
  }
  return { points, index: 0, exit: edgeIds.at(-1) };
}

export function stepAssist(car, assist, dt, traffic, fuel, brake = false) {
  if (fuel <= 0 || brake) { car.speed = 0; return false; }
  let remaining = 5 * traffic * dt;
  car.speed = 5 * traffic;
  while (assist.index < assist.points.length) {
    const [x, y] = assist.points[assist.index];
    const dx = x - car.x, dy = y - car.y, length = Math.hypot(dx, dy);
    if (length > 0.1) car.heading = Math.atan2(dy, dx);
    if (length > remaining) {
      car.x += dx / length * remaining; car.y += dy / length * remaining;
      return false;
    }
    car.x = x; car.y = y; remaining -= length;
    assist.index++;
  }
  return true;
}
