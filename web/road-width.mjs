export function roadWidth(driving, edge) {
  return edge.width ?? driving.widths[edge.kind] ?? 10;
}
