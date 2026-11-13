import { doorSide, peopleOnMap, drawHailBubble, drawCitizen, HAIL_BUBBLE } from "./citizens.mjs?v=passenger-extras-2";
import { en, zh } from "./i18n.mjs?v=passenger-extras-1";
import { staticCollisionLines, COLLISION_LINE_WIDTH } from "./collision-lines.mjs?v=tunnel-clearance-1";
import { roadWidth } from "./road-width.mjs";
import { WORLD_SCALE } from "./world-scale.mjs";
import { visualStream } from "./map-stream.mjs";
import { SpatialGrid, pointBounds } from "./spatial-grid.mjs";
import { roadLayer, isElevatedRoad, isTunnelRoad } from "./elevation.mjs?v=tunnel-clearance-1";

export const TAXI_ICON_MIN_LENGTH = { map: 20, minimap: 20 };
export const MAP_TILE_PIXELS = 256;
export const MAP_TILE_CACHE_LIMIT = 128;

export class MapView {
  constructor(canvas, data, stops, { compact = false, interactive = false } = {}) {
    this.canvas = canvas;
    this.compact = compact;
    this.interactive = interactive;
    this.ctx = canvas.getContext("2d");
    this.data = data;
    this.stream = visualStream(data);
    this.tileCache = new Map();
    this.collisionLines = staticCollisionLines(data);
    this.edges = new Map(data.edges.map(e => [e.id, e]));
    this.stops = stops;
    this.zoom = 1.65;
    this.overview = false;
    this.camera = { x: 0, y: 0 };
    this.backdrop = document.createElement("canvas");
    const seen = new Set();
    this.unique = this.data.edges.filter(e => {
      const key = `${e.way}:${[e.a, e.b].sort().join(":")}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }
  spatialIndexes() {
    if (this.indexedRoads !== this.unique) {
      this.indexedRoads = this.unique;
      this.roadIndex = new SpatialGrid(this.unique,
        edge => pointBounds([this.data.nodes[edge.a], this.data.nodes[edge.b]], 24));
    }
    if (this.indexedShapes !== this.data.backdrop) {
      this.indexedShapes = this.data.backdrop;
      this.shapeIndex = new SpatialGrid(this.data.backdrop, shape => pointBounds(shape.points));
      this.loadedShapeIds = new Set(this.data.backdrop.map(shape => shape.id));
    }
    if (this.data.overview && !this.overviewIndex)
      this.overviewIndex = new SpatialGrid(this.data.overview, shape => pointBounds(shape.points));
    if (this.collisionLines && !this.collisionIndex)
      this.collisionIndex = new SpatialGrid(this.collisionLines.all(), line => pointBounds([line.a, line.b], 1));
    this.legalDirections ??= this.data.edges.filter(edge => !edge.wrongway);
    this.directionKeys ??= new Set(this.legalDirections.map(edge => `${edge.way}:${edge.a}:${edge.b}`));
    this.directionIndex ??= new SpatialGrid(this.legalDirections,
      edge => pointBounds([this.data.nodes[edge.a], this.data.nodes[edge.b]], 10));
  }
  resize() {
    this.width = this.compact ? this.canvas.clientWidth : innerWidth;
    this.height = this.compact ? this.canvas.clientHeight : innerHeight;
    this.ratio = this.compact ? Math.max(2, devicePixelRatio || 1) : devicePixelRatio || 1;
    this.canvas.width = Math.ceil(this.width * this.ratio);
    this.canvas.height = Math.ceil(this.height * this.ratio);
  }
  buildBackdrop(bounds, s) {
    this.spatialIndexes();
    const [left, top, right, bottom] = bounds;
    this.backdropBounds = bounds;
    this.backdropScale = s;
    this.backdrop.width = Math.ceil((right - left) * s);
    this.backdrop.height = Math.ceil((bottom - top) * s);
    const c = this.backdrop.getContext("2d");
    c.fillStyle = "#1a2c30"; c.fillRect(0, 0, this.backdrop.width, this.backdrop.height);
    c.scale(s, s); c.translate(-left, -top);
    c.lineWidth = 0.5;
    const shapes = this.shapeIndex.query(bounds);
    const overview = (this.overviewIndex?.query(bounds) ?? []).filter(shape => !this.loadedShapeIds.has(shape.id));
    for (const shape of [...overview, ...shapes]) {
      c.beginPath();
      shape.points.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y));
      c.closePath();
      c.fillStyle = shape.kind === "park" ? "#28483c" : "#263c3d";
      c.strokeStyle = shape.kind === "park" ? "#355743" : "#304748";
      c.fill(); c.stroke();
    }
    c.lineCap = "round"; c.lineJoin = "round";
    const levels = new Map();
    for (const edge of this.roadIndex.query(bounds)) {
      const layer = roadLayer(edge) || (isElevatedRoad(edge) ? 1
        : isTunnelRoad(edge) && edge.tunnel !== "building_passage" ? -1 : 0);
      if (!levels.has(layer)) levels.set(layer, []);
      levels.get(layer).push(edge);
    }
    for (const level of [...levels.keys()].sort((a, b) => a - b)) {
      for (const border of [true, false]) for (const e of levels.get(level)) {
        const a = this.data.nodes[e.a], b = this.data.nodes[e.b];
        const major = ["motorway", "trunk", "primary", "secondary"].includes(e.kind);
        c.lineWidth = roadWidth(this.data.driving, e) + (border ? .2 : 0);
        c.strokeStyle = border ? "#17292d" : level !== 0 ? "#52605b" : major ? "#4b5955" : "#3b504f";
        c.beginPath(); c.moveTo(...a); c.lineTo(...b); c.stroke();
      }
    }
    this.drawCollisionLines(c, bounds);
    this.drawRoadDirections(c, bounds);
    const labelled = new Set();
    const occupied = new Set();
    const localLabels = this.roadIndex.query(bounds.map((v, i) => v + (i < 2 ? -80 : 80)))
      .sort((a, b) => b.length - a.length);
    for (const e of localLabels) {
      if (e.length < 36 || e.name === "Local road") continue;
      const a = this.data.nodes[e.a], b = this.data.nodes[e.b], x = (a[0] + b[0]) / 2, y = (a[1] + b[1]) / 2;
      const cell = `${Math.round(x / 90)},${Math.round(y / 60)}`;
      if (occupied.has(cell) || labelled.has(`${e.way}:${Math.round(x / 220)},${Math.round(y / 220)}`)) continue;
      occupied.add(cell); labelled.add(`${e.way}:${Math.round(x / 220)},${Math.round(y / 220)}`);
      let angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
      if (angle > Math.PI / 2 || angle < -Math.PI / 2) angle += Math.PI;
      c.save(); c.translate(x, y); c.rotate(angle);
      c.textAlign = "center"; c.font = "8px system-ui"; c.fillStyle = "#b8c3ae";
      c.strokeStyle = "#344947"; c.lineWidth = 2;
      c.strokeText(e.name, 0, -3); c.fillText(e.name, 0, -3);
      c.font = "7px system-ui"; c.fillStyle = "#9daea1"; c.fillText(e.zh, 0, 6);
      c.restore();
    }
  }
  roadPath(c, e) {
    c.moveTo(...this.data.nodes[e.a]); c.lineTo(...this.data.nodes[e.b]);
  }
  drawCollisionLines(c, bounds) {
    c.save();
    c.strokeStyle = "#f15e5e"; c.globalAlpha = .8; c.lineWidth = COLLISION_LINE_WIDTH; c.lineCap = "round";
    c.beginPath();
    if (!this.collisionIndex) this.collisionIndex = new SpatialGrid(this.collisionLines.all(),
      line => pointBounds([line.a, line.b], 1));
    for (const { a, b } of bounds ? this.collisionIndex.query(bounds) : this.collisionLines.all()) { c.moveTo(...a); c.lineTo(...b); }
    c.stroke(); c.restore();
  }
  *directionArrows(bounds) {
    this.legalDirections ??= this.data.edges.filter(edge => !edge.wrongway);
    this.directionKeys ??= new Set(this.legalDirections.map(edge => `${edge.way}:${edge.a}:${edge.b}`));
    const legal = this.legalDirections, directions = this.directionKeys;
    if (bounds && !this.directionIndex) this.directionIndex = new SpatialGrid(legal,
      edge => pointBounds([this.data.nodes[edge.a], this.data.nodes[edge.b]], 10));
    for (const edge of bounds ? this.directionIndex.query(bounds) : legal) {
      if (edge.length < 16) continue;
      const a = this.data.nodes[edge.a], b = this.data.nodes[edge.b];
      const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const offset = directions.has(`${edge.way}:${edge.b}:${edge.a}`)
        ? roadWidth(this.data.driving, edge) / 4 : 0;
      const count = Math.max(1, Math.floor(edge.length / 55));
      for (let i = 0; i < count; i++) {
        const t = (i + 0.5) / count;
        yield { x: a[0] + (b[0] - a[0]) * t + Math.sin(angle) * offset,
          y: a[1] + (b[1] - a[1]) * t - Math.cos(angle) * offset, angle };
      }
    }
  }
  drawRoadDirections(c, bounds) {
    c.save(); c.strokeStyle = "#c2d0bf"; c.lineWidth = WORLD_SCALE.markingWidth;
    for (const { x, y, angle } of this.directionArrows(bounds)) {
      c.save(); c.translate(x, y); c.rotate(angle);
      const tip = WORLD_SCALE.arrowLength / 2, halfWidth = WORLD_SCALE.arrowWidth / 2;
      c.beginPath(); c.moveTo(-tip, 0); c.lineTo(tip, 0);
      c.moveTo(0, -halfWidth); c.lineTo(tip, 0); c.lineTo(0, halfWidth); c.stroke();
      c.restore();
    }
    c.restore();
  }
  drawTiles(c, bounds, zoom) {
    const revision = this.stream?.revision ?? 0;
    const rasterScale = 2 ** (Math.round(Math.log2(zoom * this.ratio) * 2) / 2);
    const span = MAP_TILE_PIXELS / rasterScale, gutter = 2 / rasterScale;
    const scales = [...new Set([...this.tileCache.keys()].map(key => Number(key.split(":")[0])))];
    const fallback = scales.filter(scale => scale !== rasterScale)
      .sort((a, b) => Math.abs(Math.log2(a / rasterScale)) - Math.abs(Math.log2(b / rasterScale)))[0];
    if (fallback) {
      const fallbackSpan = MAP_TILE_PIXELS / fallback;
      for (const [key, tile] of this.tileCache) {
        const [scale, x, y] = key.split(":").map(Number);
        if (scale !== fallback || (x + 1) * fallbackSpan < bounds[0] || x * fallbackSpan > bounds[2]
            || (y + 1) * fallbackSpan < bounds[1] || y * fallbackSpan > bounds[3]) continue;
        c.drawImage(tile.canvas, 2, 2, MAP_TILE_PIXELS, MAP_TILE_PIXELS,
          x * fallbackSpan, y * fallbackSpan, fallbackSpan, fallbackSpan);
      }
    }
    let budget = 2;
    const tiles = [];
    for (let x = Math.floor(bounds[0] / span); x <= Math.floor(bounds[2] / span); x++)
      for (let y = Math.floor(bounds[1] / span); y <= Math.floor(bounds[3] / span); y++)
        tiles.push({ x, y });
    const cx = (bounds[0] + bounds[2]) / 2, cy = (bounds[1] + bounds[3]) / 2;
    tiles.sort((a, b) => Math.hypot((a.x + .5) * span - cx, (a.y + .5) * span - cy)
      - Math.hypot((b.x + .5) * span - cx, (b.y + .5) * span - cy));
    this.spatialIndexes();
    for (const { x, y } of tiles) {
      const key = `${rasterScale}:${x}:${y}`;
      let tile = this.tileCache.get(key);
      if ((!tile || tile.revision !== revision) && budget > 0) {
        const painter = Object.create(this);
        painter.backdrop = document.createElement("canvas");
        painter.buildBackdrop([x * span - gutter, y * span - gutter,
          (x + 1) * span + gutter, (y + 1) * span + gutter], rasterScale);
        tile = { canvas: painter.backdrop, revision };
        this.tileCache.set(key, tile); budget--;
      }
      if (tile) {
        this.tileCache.delete(key); this.tileCache.set(key, tile);
        c.drawImage(tile.canvas, 2, 2, MAP_TILE_PIXELS, MAP_TILE_PIXELS, x * span, y * span, span, span);
      }
    }
    while (this.tileCache.size > MAP_TILE_CACHE_LIMIT) this.tileCache.delete(this.tileCache.keys().next().value);
    this.backdropBounds = bounds;
    this.backdropScale = zoom * this.ratio;
  }
  render(car, state, lang, approach, previewExit = null) {
    const ratio = this.compact ? Math.max(2, devicePixelRatio || 1) : devicePixelRatio || 1;
    if (this.ratio !== ratio) this.resize();
    const c = this.ctx, w = this.width, h = this.height;
    const [left, top, right, bottom] = this.data.bounds;
    const zoom = this.overview ? Math.min((w - 25) / (right - left), (h - 180) / (bottom - top)) : this.zoom;
    const target = this.interactive ? this.camera
      : this.overview ? { x: (left + right) / 2, y: (top + bottom) / 2 } : car;
    this.camera.x += (target.x - this.camera.x) * 0.12;
    this.camera.y += (target.y - this.camera.y) * 0.12;
    const cx = w / 2;
    const cy = this.compact ? h / 2 : this.overview ? h * 0.5 : h * 0.61;
    if (this.compact) {
      this.camera.x = target.x;
      this.camera.y = target.y;
    }
    c.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    c.fillStyle = "#15262c"; c.fillRect(0, 0, w, h);
    c.translate(cx, cy); c.scale(zoom, zoom); c.translate(-this.camera.x, -this.camera.y);
    const visibleLeft = Math.max(left, this.camera.x - cx / zoom);
    const visibleTop = Math.max(top, this.camera.y - cy / zoom);
    const visibleRight = Math.min(right, this.camera.x + (w - cx) / zoom);
    const visibleBottom = Math.min(bottom, this.camera.y + (h - cy) / zoom);
    if (this.stream && zoom >= .5) {
      const radius = Math.min(384, Math.max(w, h) / (2 * zoom) + 128);
      this.stream.interest(this.interactive ? "popup" : this.compact ? "minimap" : "map",
        [this.camera.x - radius, this.camera.y - radius, this.camera.x + radius, this.camera.y + radius]);
    }
    if (visibleRight > visibleLeft && visibleBottom > visibleTop) {
      this.drawTiles(c, [visibleLeft, visibleTop, visibleRight, visibleBottom], zoom);
    }
    c.lineWidth = 1 / zoom; c.strokeStyle = "#f5c65a55"; c.setLineDash([6 / zoom, 5 / zoom]);
    c.strokeRect(left, top, right - left, bottom - top); c.setLineDash([]);
    if (state) {
      const closed = new Set(state.closed);
      c.lineCap = "round";
      for (const e of this.unique) {
        if (!closed.has(e.way) && !state.traffic[e.way]) continue;
        c.strokeStyle = closed.has(e.way) ? "#ed8879" : "#bd955c";
        c.lineWidth = (closed.has(e.way) ? 5 : 2) / Math.max(zoom, 0.8);
        c.beginPath(); this.roadPath(c, e); c.stroke();
      }
      if (state.route) {
        c.lineWidth = 5 / zoom; c.strokeStyle = "#f5c65a22"; c.beginPath();
        for (const id of state.route) this.roadPath(c, this.edges.get(id));
        c.stroke(); c.lineWidth = 2.5 / zoom; c.strokeStyle = state.phase === "pickup" ? "#92d7b6" : "#f5c65a"; c.stroke();
      }
      if (state.selected_exit && state.selected_junction && car.edge === state.edge) {
        const node = this.data.nodes[state.selected_junction];
        const current = this.edges.get(car.edge);
        if (current.a !== state.selected_junction && Math.hypot(car.x - node[0], car.y - node[1]) <= 61.5) {
          const path = approach?.exits.find(exit => exit.edge.id === state.selected_exit)?.path;
          this.highlightExit(c, this.edges.get(state.selected_exit), "#55e9ff", zoom, path);
        }
      }
      const preview = approach?.exits.find(exit => exit.edge.id === previewExit);
      if (preview) this.highlightExit(c, preview.edge, "#55e9ff", zoom, preview.path);
      for (const stop of this.stops) {
        const active = state.phase === "pickup" ? stop.id === state.pickup : state.phase === "onboard" ? stop.id === state.destination : false;
        if (!active && stop.id !== "depot") continue;
        const point = active ? (state.phase === "pickup" ? state.pickup_point : state.destination_point) : null;
        const [x, y] = point || stop.point, color = stop.id === "depot" ? "#85bada" : state.phase === "pickup" ? "#92d7b6" : "#f5c65a";
        c.fillStyle = color + "20"; c.beginPath(); c.arc(x, y, 18 / zoom, 0, Math.PI * 2); c.fill();
        c.fillStyle = color; c.strokeStyle = "#13252b"; c.lineWidth = 3 / zoom;
        c.beginPath(); c.arc(x, y, 7 / zoom, 0, Math.PI * 2); c.fill(); c.stroke();
        c.font = `${11 / zoom}px system-ui`; c.textAlign = "center"; c.fillStyle = "#e1ece2";
        c.strokeStyle = "#15282b"; c.lineWidth = 4 / zoom;
        const label = lang === "zh" ? stop.zh : stop.name;
        c.strokeText(label, x, y - 28 / zoom); c.fillText(label, x, y - 28 / zoom);
      }
    }
    for (const person of peopleOnMap(state ?? {}, car)) {
      const [x, y] = person.point;
      // Body is ~2 m at true scale; the hail ring stays screen-sized so hails remain easy to spot.
      const size = Math.max(0.5, 0.8 / zoom) * (person.scale ?? 1);
      if (person.hailing) {
        c.strokeStyle = "#ffac6e"; c.lineWidth = 1.5 / zoom;
        c.beginPath(); c.arc(x, y, 7 / zoom, 0, Math.PI * 2); c.stroke();
      }
      c.save(); c.translate(x, y); c.scale(size, size);
      drawCitizen(c, person, state?.elapsed ?? 0);
      c.restore();
      if (person.hailing && person.id !== "customer" && !person.boarding && !this.compact && !this.overview) {
        c.save();
        const scale = 24 / HAIL_BUBBLE.canvasWidth / zoom;
        const tipX = HAIL_BUBBLE.x + HAIL_BUBBLE.width / 2,
          tipY = HAIL_BUBBLE.y + HAIL_BUBBLE.height + HAIL_BUBBLE.tailHeight;
        c.translate(x - tipX * scale, y - 5 / zoom - tipY * scale);
        c.scale(scale, scale);
        drawHailBubble(c, (lang === "zh" ? zh : en).hailTaxi);
        c.restore();
      }
    }
    c.save(); c.translate(car.x, car.y); c.rotate(car.heading);
    const body = this.data.driving;
    const minLength = this.compact && !this.interactive
      ? TAXI_ICON_MIN_LENGTH.minimap : TAXI_ICON_MIN_LENGTH.map;
    const iconScale = Math.max(1, minLength / (body.taxi_length ? body.taxi_length * 26 / 27 * zoom : 26));
    c.scale(iconScale, iconScale);
    if (body.taxi_length) c.scale(body.taxi_length / 27, body.taxi_width / 13);
    const s = body.taxi_length ? 1 : 1 / zoom;
    c.fillStyle = "#f5c65a1f";
    c.beginPath(); c.arc(0, 0, 22 * s, 0, Math.PI * 2); c.fill();
    c.fillStyle = "#060d1490"; c.fillRect(-11 * s, -4 * s, 26 * s, 12 * s);
    c.fillStyle = "#f7cc65"; c.strokeStyle = "#fff0ba"; c.lineWidth = s;
    c.beginPath(); c.roundRect(-13 * s, -6 * s, 26 * s, 12 * s, 3 * s); c.fill(); c.stroke();
    c.fillStyle = "#253e42"; c.fillRect(-5 * s, -5 * s, 10 * s, 10 * s);
    c.fillStyle = "#e4e8d6"; c.fillRect(-2 * s, -3 * s, 4 * s, 6 * s);
    c.fillStyle = "#ffffbd"; c.fillRect(10 * s, -5 * s, 2 * s, 2 * s); c.fillRect(10 * s, 3 * s, 2 * s, 2 * s);
    if (state?.boarding) {
      const side = doorSide(state, car);
      c.strokeStyle = "#fff0ba"; c.lineWidth = 1.5 * s;
      c.beginPath(); c.moveTo(-5 * s, 6 * s * side); c.lineTo(-8 * s, 13 * s * side); c.stroke();
    }
    c.restore();
    c.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    const nx = this.compact ? w - 15 : w - 35;
    const ny = this.compact ? 30 : h - (matchMedia("(pointer:coarse)").matches ? 240 : 210);
    c.fillStyle = "#c2d0bf"; c.font = "10px system-ui"; c.textAlign = "center"; c.fillText("N", nx, ny - 15);
    c.beginPath(); c.moveTo(nx, ny - 7); c.lineTo(nx - 4, ny + 7); c.lineTo(nx + 4, ny + 7); c.closePath(); c.fill();
  }
  highlightExit(c, edge, color, zoom, path) {
    const start = path?.start;
    c.strokeStyle = color; c.lineWidth = 4 / zoom;
    c.beginPath();
    if (start) c.moveTo(start.x, start.y);
    else c.moveTo(...this.data.nodes[edge.a]);
    for (const segment of path?.edges ?? [edge]) c.lineTo(...this.data.nodes[segment.b]);
    c.stroke();
  }
}
