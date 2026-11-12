import { project } from "./physics.mjs?v=tunnel-clearance-1";

export function routeDistance(route, roads, position, stop) {
  if (!route?.length || !stop) return null;
  const edges = route.map(id => roads.edges.get(id));
  if (edges.some(edge => !edge)) return null;
  const first = edges[0], last = edges[edges.length - 1];
  if (last.id !== stop.edge) return null;
  const start = project(position, roads.nodes[first.a], roads.nodes[first.b]).t;
  const end = project({ x: stop.point[0], y: stop.point[1] },
    roads.nodes[last.a], roads.nodes[last.b]).t;
  if (edges.length === 1) return end >= start ? (end - start) * first.length : null;
  return (1 - start) * first.length + edges.slice(1, -1).reduce((sum, edge) => sum + edge.length, 0)
    + end * last.length;
}
