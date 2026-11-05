export class SpatialGrid {
  constructor(items, bounds, size = 256) {
    this.cells = new Map();
    this.size = size;
    for (const item of items) {
      const [left, top, right, bottom] = bounds(item);
      for (let x = Math.floor(left / size); x <= Math.floor(right / size); x++)
        for (let y = Math.floor(top / size); y <= Math.floor(bottom / size); y++) {
          const key = `${x}:${y}`;
          if (!this.cells.has(key)) this.cells.set(key, []);
          this.cells.get(key).push(item);
        }
    }
  }
  query([left, top, right, bottom]) {
    const items = new Set();
    for (let x = Math.floor(left / this.size); x <= Math.floor(right / this.size); x++)
      for (let y = Math.floor(top / this.size); y <= Math.floor(bottom / this.size); y++)
        for (const item of this.cells.get(`${x}:${y}`) ?? []) items.add(item);
    return [...items];
  }
}

export function pointBounds(points, margin = 0) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const [x, y] of points) {
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  return [left - margin, top - margin, right + margin, bottom + margin];
}
