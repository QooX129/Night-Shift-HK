export const STRAIGHT_ANGLE = Math.PI / 180;
export const STRAIGHT_DEVIATION = .01;

export function straightJoin(points, next) {
  const a = points[0], b = points.at(-1);
  const angle = Math.atan2(b[1] - points.at(-2)[1], b[0] - points.at(-2)[0]);
  const turn = Math.atan2(next[1] - b[1], next[0] - b[0]) - angle;
  if (Math.abs(Math.atan2(Math.sin(turn), Math.cos(turn))) > STRAIGHT_ANGLE) return false;
  const dx = next[0] - a[0], dy = next[1] - a[1], length = Math.hypot(dx, dy);
  if (!length) return false;
  return points.slice(1).every(p =>
    Math.abs(dx * (p[1] - a[1]) - dy * (p[0] - a[0])) / length <= STRAIGHT_DEVIATION);
}

export function mergeStraightSegments(segments) {
  const chains = [];
  for (const segment of segments) {
    const previous = chains.at(-1);
    if (previous && previous.key === segment.key
        && Math.hypot(previous.b[0] - segment.a[0], previous.b[1] - segment.a[1]) < 1e-7
        && straightJoin(previous.points, segment.b)) {
      previous.b = segment.b;
      previous.points.push(segment.b);
    } else chains.push({ ...segment, points: [segment.a, segment.b] });
  }
  return chains;
}

export function colliderSegments(roads, edges) {
  const unique = new Map();
  for (const edge of edges) {
    const key = JSON.stringify([edge.way, ...[edge.a, edge.b].sort(), roads.radius(edge),
      edge.layer, edge.bridge, edge.tunnel]);
    if (!unique.has(key)) unique.set(key, edge);
  }
  const remaining = new Set(unique.values()), result = [];
  while (remaining.size) {
    const edge = remaining.values().next().value;
    remaining.delete(edge);
    let points = [roads.nodes[edge.a], roads.nodes[edge.b]], first = edge.a, last = edge.b;
    const radius = roads.radius(edge);
    for (const reverse of [false, true]) {
      if (reverse) { points.reverse(); [first, last] = [last, first]; }
      while (true) {
        const next = [...remaining].filter(candidate =>
          (candidate.a === last || candidate.b === last) && candidate.way === edge.way
          && roads.radius(candidate) === radius
          && ["layer", "bridge", "tunnel"].every(tag => candidate[tag] === edge[tag]));
        if (next.length !== 1) break;
        const candidate = next[0], node = candidate.a === last ? candidate.b : candidate.a;
        if (!straightJoin(points, roads.nodes[node])) break;
        points.push(roads.nodes[node]);
        last = node;
        remaining.delete(candidate);
      }
    }
    result.push({ a: points[0], b: points.at(-1), radius });
  }
  return result;
}
