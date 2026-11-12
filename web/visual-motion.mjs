export function interpolateCar(previous, current, alpha) {
  if (!previous) return current;
  const t = Math.max(0, Math.min(1, alpha));
  const turn = Math.atan2(Math.sin(current.heading - previous.heading),
    Math.cos(current.heading - previous.heading));
  return { ...current, x: previous.x + (current.x - previous.x) * t,
    y: previous.y + (current.y - previous.y) * t, heading: previous.heading + turn * t };
}
