export const VISUAL_CHUNK_CACHE_LIMIT = 64;
export const VISUAL_STREAM_RADIUS = 384;

export class VisualStream {
  constructor(data, { fetcher = (...args) => fetch(...args), onError = error => console.error(error), onRecovery = () => {} } = {}) {
    this.data = data;
    this.manifest = data.visualChunks;
    this.keys = new Set(this.manifest.keys);
    this.fetcher = fetcher;
    this.onError = onError;
    this.onRecovery = onRecovery;
    this.cache = new Map();
    this.pending = new Map();
    this.failures = new Map();
    this.interests = new Map();
    this.listeners = new Set();
    this.revision = 0;
    this.disposed = false;
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  interest(name, bounds, now = performance.now()) {
    this.interests.set(name, { bounds, at: now });
    if (this.lastUpdate !== undefined && now - this.lastUpdate < 250) return;
    this.lastUpdate = now;
    const desired = new Map(), size = this.manifest.size;
    for (const [name, interest] of this.interests) {
      if (now - interest.at > 1000) { this.interests.delete(name); continue; }
      const [left, top, right, bottom] = interest.bounds;
      const cx = (left + right) / 2, cy = (top + bottom) / 2;
      for (let x = Math.floor(left / size); x <= Math.floor(right / size); x++)
        for (let y = Math.floor(top / size); y <= Math.floor(bottom / size); y++) {
          const key = `${x}:${y}`;
          if (!this.keys.has(key)) continue;
          const distance = Math.hypot((x + .5) * size - cx, (y + .5) * size - cy);
          const priority = distance + (name === "player" ? 0 : 1000);
          desired.set(key, Math.min(desired.get(key) ?? Infinity, priority));
        }
    }
    this.desired = new Set([...desired].sort((a, b) => a[1] - b[1])
      .slice(0, VISUAL_CHUNK_CACHE_LIMIT).map(([key]) => key));
    for (const key of this.failures.keys()) {
      if (!this.desired.has(key)) this.failures.delete(key);
    }
    for (const [key, controller] of this.pending) {
      if (!this.desired.has(key)) controller.abort();
    }
    for (const key of this.desired) {
      if (this.cache.has(key)) {
        const chunk = this.cache.get(key);
        this.cache.delete(key); this.cache.set(key, chunk);
      }
    }
    this.pump(now);
  }
  pump(now = performance.now()) {
    if (this.disposed || !this.desired) return;
    for (const key of this.desired) {
      if (this.pending.size >= 2) break;
      if (this.cache.has(key) || this.pending.has(key) || (this.failures.get(key) ?? 0) > now) continue;
      this.load(key);
    }
  }
  async load(key) {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 10000);
    this.pending.set(key, controller);
    const [x, y] = key.split(":");
    try {
      const response = await this.fetcher(`/api/map/chunks/${this.manifest.version}/${x}/${y}`,
        { signal: controller.signal });
      if (!response.ok) throw new Error(`Visual chunk ${key}: HTTP ${response.status}${response.status === 409 ? "; refresh to load the updated map" : ""}`);
      const chunk = await response.json();
      if (chunk.version !== this.manifest.version || chunk.key !== key || !Array.isArray(chunk.backdrop))
        throw new Error(`Invalid visual chunk ${key}. Refresh to reload the map.`);
      if (!chunk.backdrop.every(shape => Number.isInteger(shape.id)
          && ["building", "park"].includes(shape.kind) && Array.isArray(shape.points) && shape.points.length >= 3
          && shape.points.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))))
        throw new Error(`Invalid visual shapes in chunk ${key}.`);
      if (controller.signal.aborted || this.disposed || !this.desired.has(key)) return;
      this.cache.set(key, chunk);
      this.failures.delete(key);
      while (this.cache.size > VISUAL_CHUNK_CACHE_LIMIT) {
        const oldest = [...this.cache.keys()].find(key => !this.desired.has(key));
        if (!oldest) break;
        this.cache.delete(oldest);
      }
      const shapes = new Map();
      for (const chunk of this.cache.values()) {
        for (const shape of chunk.backdrop) shapes.set(shape.id, shape);
      }
      this.data.backdrop = [...shapes.values()].sort((a, b) => a.id - b.id);
      this.revision++;
      for (const listener of this.listeners) listener();
      if (!this.failures.size) this.onRecovery();
    } catch (error) {
      if ((!controller.signal.aborted || timedOut) && !this.disposed && this.desired.has(key)) {
        this.failures.set(key, performance.now() + 5000);
        this.onError(timedOut ? new Error(`Visual chunk ${key} timed out.`) : error);
      }
    } finally {
      clearTimeout(timeout);
      this.pending.delete(key);
      this.pump();
    }
  }
  dispose() {
    this.disposed = true;
    for (const controller of this.pending.values()) controller.abort();
    this.listeners.clear();
    this.cache.clear();
  }
}

const streams = new WeakMap();

export function visualStream(data, options) {
  if (!data.visualChunks) return null;
  if (!streams.has(data)) streams.set(data, new VisualStream(data, options));
  return streams.get(data);
}
