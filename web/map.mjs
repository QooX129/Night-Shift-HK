export class MapView {
  constructor(canvas, data, stops) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.data = data;
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
  resize() {
    this.width = innerWidth; this.height = innerHeight;
    this.ratio = devicePixelRatio || 1;
    this.canvas.width = Math.ceil(this.width * this.ratio);
    this.canvas.height = Math.ceil(this.height * this.ratio);
  }
  buildBackdrop(bounds, s) {
    const [left, top, right, bottom] = bounds;
    this.backdropBounds = bounds;
    this.backdropScale = s;
    this.backdrop.width = Math.ceil((right - left) * s);
    this.backdrop.height = Math.ceil((bottom - top) * s);
    const c = this.backdrop.getContext("2d");
    c.fillStyle = "#1a2c30"; c.fillRect(0, 0, this.backdrop.width, this.backdrop.height);
    c.scale(s, s); c.translate(-left, -top);
    c.lineWidth = 0.5;
    for (const shape of this.data.backdrop) {
      c.beginPath();
      shape.points.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y));
      c.closePath();
      c.fillStyle = shape.kind === "park" ? "#28483c" : "#263c3d";
      c.strokeStyle = shape.kind === "park" ? "#355743" : "#304748";
      c.fill(); c.stroke();
    }
    c.lineCap = "round"; c.lineJoin = "round";
    for (const border of [true, false]) {
      for (const e of this.unique) {
        const a = this.data.nodes[e.a], b = this.data.nodes[e.b];
        const major = ["primary", "secondary"].includes(e.kind);
        c.lineWidth = (this.data.driving.widths[e.kind] ?? 10) + (border ? 2 : 0);
        c.strokeStyle = border ? "#17292d" : e.layer !== "0" ? "#52605b" : major ? "#4b5955" : "#3b504f";
        c.beginPath(); c.moveTo(...a); c.lineTo(...b); c.stroke();
      }
    }
    this.drawRoadBoundaries(c, s);
    this.drawRoadDirections(c);
    const labelled = new Set();
    const occupied = new Set();
    for (const e of [...this.unique].sort((a, b) => b.length - a.length)) {
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
  drawRoadBoundaries(context, scale) {
    const mask = document.createElement("canvas");
    mask.width = this.backdrop.width; mask.height = this.backdrop.height;
    const c = mask.getContext("2d");
    const [left, top] = this.backdropBounds;
    c.scale(scale, scale); c.translate(-left, -top);
    c.lineCap = "round"; c.strokeStyle = "#f15e5e";
    for (const erase of [false, true]) {
      c.globalCompositeOperation = erase ? "destination-out" : "source-over";
      for (const edge of this.unique) {
        const width = this.data.driving.widths[edge.kind] ?? 10;
        const radius = Math.max(0, width / 2 - (this.data.driving.taxi_length ? 0 : this.data.driving.taxi_radius));
        const strokeWidth = Math.max(0, radius * 2 + (erase ? -1 : 1));
        if (strokeWidth === 0) continue;
        c.lineWidth = strokeWidth;
        c.beginPath(); this.roadPath(c, edge); c.stroke();
      }
    }
    context.save(); context.resetTransform();
    context.globalAlpha = 0.8;
    context.drawImage(mask, 0, 0);
    context.restore();
  }
  *directionArrows() {
    const legal = this.data.edges.filter(edge => !edge.wrongway);
    const directions = new Set(legal.map(edge => `${edge.way}:${edge.a}:${edge.b}`));
    for (const edge of legal) {
      if (edge.length < 16) continue;
      const a = this.data.nodes[edge.a], b = this.data.nodes[edge.b];
      const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const offset = directions.has(`${edge.way}:${edge.b}:${edge.a}`)
        ? (this.data.driving.widths[edge.kind] ?? 10) / 4 : 0;
      const count = Math.max(1, Math.floor(edge.length / 55));
      for (let i = 0; i < count; i++) {
        const t = (i + 0.5) / count;
        yield { x: a[0] + (b[0] - a[0]) * t + Math.sin(angle) * offset,
          y: a[1] + (b[1] - a[1]) * t - Math.cos(angle) * offset, angle };
      }
    }
  }
  drawRoadDirections(c) {
    c.save(); c.strokeStyle = "#c2d0bf"; c.lineWidth = 0.9;
    for (const { x, y, angle } of this.directionArrows()) {
      c.save(); c.translate(x, y); c.rotate(angle);
      c.beginPath(); c.moveTo(-3, 0); c.lineTo(3, 0);
      c.moveTo(0, -2); c.lineTo(3, 0); c.lineTo(0, 2); c.stroke();
      c.restore();
    }
    c.restore();
  }
  render(car, state, lang, approach, previewExit = null) {
    if (this.ratio !== (devicePixelRatio || 1)) this.resize();
    const c = this.ctx, w = this.width, h = this.height;
    const [left, top, right, bottom] = this.data.bounds;
    const zoom = this.overview ? Math.min((w - (w > 800 ? 370 : 25)) / (right - left), (h - 180) / (bottom - top)) : this.zoom;
    const target = this.overview ? { x: (left + right) / 2, y: (top + bottom) / 2 } : car;
    this.camera.x += (target.x - this.camera.x) * 0.12;
    this.camera.y += (target.y - this.camera.y) * 0.12;
    const cx = w > 800 ? w * 0.64 : w * 0.58, cy = this.overview ? h * 0.5 : h * 0.61;
    c.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    c.fillStyle = "#15262c"; c.fillRect(0, 0, w, h);
    c.translate(cx, cy); c.scale(zoom, zoom); c.translate(-this.camera.x, -this.camera.y);
    const visibleLeft = Math.max(left, this.camera.x - cx / zoom);
    const visibleTop = Math.max(top, this.camera.y - cy / zoom);
    const visibleRight = Math.min(right, this.camera.x + (w - cx) / zoom);
    const visibleBottom = Math.min(bottom, this.camera.y + (h - cy) / zoom);
    if (visibleRight > visibleLeft && visibleBottom > visibleTop) {
      const scale = zoom * this.ratio;
      const cached = this.backdropBounds;
      if (!cached || this.backdropScale !== scale ||
          visibleLeft < cached[0] || visibleTop < cached[1] ||
          visibleRight > cached[2] || visibleBottom > cached[3]) {
        // Cache a small offscreen margin so driving does not redraw the map every frame.
        const margin = 128 / zoom;
        this.buildBackdrop([
          Math.max(left, visibleLeft - margin), Math.max(top, visibleTop - margin),
          Math.min(right, visibleRight + margin), Math.min(bottom, visibleBottom + margin),
        ], scale);
      }
      const [cacheLeft, cacheTop] = this.backdropBounds;
      c.drawImage(
        this.backdrop, (visibleLeft - cacheLeft) * scale, (visibleTop - cacheTop) * scale,
        (visibleRight - visibleLeft) * scale, (visibleBottom - visibleTop) * scale,
        visibleLeft, visibleTop, visibleRight - visibleLeft, visibleBottom - visibleTop,
      );
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
      if (approach) {
        this.highlightExit(c, approach.edges[0], "#92d7b6", zoom, approach);
        const index = state.route?.indexOf(approach.incoming) ?? -1;
        const suggested = index >= 0 ? state.route[index + 1] : null;
        for (const { edge, path } of [...approach.exits].sort((a, b) =>
          Number(a.edge.id === suggested) - Number(b.edge.id === suggested))) {
          this.highlightExit(c, edge, edge.id === suggested ? "#f5c65a" : "#b5e3d780", zoom, path);
        }
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
        const [x, y] = stop.point, color = stop.id === "depot" ? "#85bada" : state.phase === "pickup" ? "#92d7b6" : "#f5c65a";
        c.fillStyle = color + "20"; c.beginPath(); c.arc(x, y, 18 / zoom, 0, Math.PI * 2); c.fill();
        c.fillStyle = color; c.strokeStyle = "#13252b"; c.lineWidth = 3 / zoom;
        c.beginPath(); c.arc(x, y, 7 / zoom, 0, Math.PI * 2); c.fill(); c.stroke();
        c.font = `${11 / zoom}px system-ui`; c.textAlign = "center"; c.fillStyle = "#e1ece2";
        c.strokeStyle = "#15282b"; c.lineWidth = 4 / zoom;
        const label = lang === "zh" ? stop.zh : stop.name;
        c.strokeText(label, x, y - 28 / zoom); c.fillText(label, x, y - 28 / zoom);
      }
    }
    c.save(); c.translate(car.x, car.y); c.rotate(car.heading);
    const body = this.data.driving;
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
    c.restore();
    c.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    const nx = w - 35, ny = h - (matchMedia("(pointer:coarse)").matches ? 240 : 210);
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
