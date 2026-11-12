export function upcomingRoute(route, edges, currentId) {
  if (!route?.length) return route;
  const current = edges.get(currentId);
  if (!current) throw new Error(`Unknown current road: ${currentId}`);
  const index = route.findIndex(id => {
    const edge = edges.get(id);
    if (!edge) throw new Error(`Unknown route road: ${id}`);
    return edge.id === current.id || (edge.way === current.way
      && edge.a === current.b && edge.b === current.a);
  });
  return index < 0 ? [] : route.slice(index + 1);
}
