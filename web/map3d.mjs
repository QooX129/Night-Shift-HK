import * as THREE from "./vendor/three/three.module.min.js";
import { MapView } from "./map.mjs";

export class Map3DView {
  constructor(canvas, data, stops) {
    this.canvas = canvas;
    this.data = data;
    this.stops = stops;
    this.zoom = 1.65;
    this.overview = false;
    this.camera = { x: 0, y: 0 };
    this.edges = new Map(data.edges.map(edge => [edge.id, edge]));
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(1);
    this.quality = 1;
    this.frameTimes = [];
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color("#172b38");
    this.scene.fog = new THREE.Fog("#172b38", 180, 600);
    this.lens = new THREE.PerspectiveCamera(48, 1, 0.3, 5000);
    this.scene.add(new THREE.HemisphereLight("#bcdbe6", "#304239", 1.8));
    const sun = new THREE.DirectionalLight("#ffe0b0", 1.8);
    sun.position.set(-100, 180, -60);
    this.scene.add(sun);
    this.resources = [];
    try {
      this.buildGround();
      this.buildCity();
      this.buildTaxi();
      this.overlays = new THREE.Group();
      this.scene.add(this.overlays);
      this.overlayKey = null;
      this.buildMarkers();
    } catch (error) {
      this.dispose();
      throw error;
    }
    this.cameraReady = false;
    this.onResize = () => this.resize();
    window.addEventListener("resize", this.onResize);
    this.resize();
  }
  resize() {
    this.renderer.setPixelRatio(this.quality);
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.lens.aspect = innerWidth / innerHeight;
    this.lens.updateProjectionMatrix();
  }
  buildGround() {
    const [left, top, right, bottom] = this.data.bounds;
    const map = Object.create(MapView.prototype);
    map.data = this.data;
    map.backdrop = document.createElement("canvas");
    const seen = new Set();
    map.unique = this.data.edges.filter(edge => {
      const key = `${edge.way}:${[edge.a, edge.b].sort().join(":")}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    const scale = Math.min(1.5, 4096 / Math.max(right - left, bottom - top));
    // Road names are shown in the HUD; metre-sized canvas text overwhelms the chase view.
    const context = map.backdrop.getContext("2d");
    context.fillText = () => {};
    context.strokeText = () => {};
    map.buildBackdrop(this.data.bounds, scale);
    const texture = new THREE.CanvasTexture(map.backdrop);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.resources.push(texture);
    const geometry = new THREE.PlaneGeometry(right - left, bottom - top);
    geometry.rotateX(-Math.PI / 2);
    const ground = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: texture }));
    ground.position.set((left + right) / 2, 0, (top + bottom) / 2);
    ground.name = "district-roads";
    this.scene.add(ground);
  }
  buildCity() {
    const facade = document.createElement("canvas");
    facade.width = 64; facade.height = 64;
    const paint = facade.getContext("2d");
    paint.fillStyle = "#81918d"; paint.fillRect(0, 0, 64, 64);
    paint.fillStyle = "#354e58"; paint.fillRect(15, 13, 30, 34);
    paint.fillStyle = "#b8ab70"; paint.fillRect(17, 15, 26, 13);
    paint.fillStyle = "#9ca7a1"; paint.fillRect(12, 47, 36, 3);
    paint.fillStyle = "#61726e"; paint.fillRect(0, 61, 64, 3);
    const texture = new THREE.CanvasTexture(facade);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.resources.push(texture);
    this.cityMaterial = new THREE.MeshBasicMaterial({ map: texture, vertexColors: true });
    this.fadedCityMaterial = this.cityMaterial.clone();
    this.fadedCityMaterial.transparent = true;
    this.fadedCityMaterial.opacity = 0.12;
    this.fadedCityMaterial.depthWrite = false;
    const tiles = new Map();
    this.buildingCount = 0;
    for (const footprint of this.data.backdrop) {
      if (footprint.kind !== "building" || footprint.points.length < 3) continue;
      const points = footprint.points;
      const cx = points.reduce((sum, p) => sum + p[0], 0) / points.length;
      const cy = points.reduce((sum, p) => sum + p[1], 0) / points.length;
      const key = `${Math.floor(cx / 60)}:${Math.floor(cy / 60)}`;
      if (!tiles.has(key)) tiles.set(key, { positions: [], normals: [], colors: [], uvs: [] });
      const tile = tiles.get(key);
      const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, -y)));
      const seed = Math.abs(Math.round(cx * 13 + cy * 7));
      const height = 10 + seed % 29;
      const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, steps: 1 });
      geometry.rotateX(-Math.PI / 2);
      const position = geometry.getAttribute("position"), normal = geometry.getAttribute("normal");
      const color = new THREE.Color().setHSL(0.48 + seed % 8 / 100, 0.13, 0.48 + seed % 6 / 100);
      for (let i = 0; i < position.count; i++) {
        tile.positions.push(position.getX(i), position.getY(i) + 0.05, position.getZ(i));
        tile.normals.push(normal.getX(i), normal.getY(i), normal.getZ(i));
        const shade = normal.getY(i) > 0.5 ? 0.7
          : 0.7 + 0.3 * Math.max(0, -normal.getX(i) * 0.5 - normal.getZ(i) * 0.8);
        tile.colors.push(color.r * shade, color.g * shade, color.b * shade);
        tile.uvs.push(normal.getY(i) > 0.5 ? 0.03
          : (Math.abs(normal.getX(i)) > 0.5 ? position.getZ(i) : position.getX(i)) / 3,
        normal.getY(i) > 0.5 ? 0.03 : position.getY(i) / 3);
      }
      geometry.dispose();
      this.buildingCount++;
    }
    this.buildings = [];
    for (const tile of tiles.values()) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(tile.positions, 3));
      geometry.setAttribute("normal", new THREE.Float32BufferAttribute(tile.normals, 3));
      geometry.setAttribute("color", new THREE.Float32BufferAttribute(tile.colors, 3));
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(tile.uvs, 2));
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, this.cityMaterial);
      mesh.name = "building-block";
      this.scene.add(mesh);
      this.buildings.push(mesh);
    }
  }
  buildTaxi() {
    this.taxi = new THREE.Group();
    this.taxi.name = "taxi";
    const length = this.data.driving.taxi_length ?? 5.4, width = this.data.driving.taxi_width ?? 2.6;
    const box = (x, y, z, position, color) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(x, y, z),
        new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.15 }));
      mesh.position.set(...position);
      this.taxi.add(mesh);
      return mesh;
    };
    box(length, 0.85, width, [0, 0.85, 0], "#bb343a");
    box(length * 0.52, 0.75, width * 0.86, [-length * 0.06, 1.6, 0], "#c8d6ca");
    box(length * 0.53, 0.42, width * 0.88, [-length * 0.06, 1.55, 0], "#193b4a");
    box(length * 0.5, 0.12, width * 0.87, [-length * 0.06, 2, 0], "#dbe6dd");
    box(length * 0.15, 0.25, width * 0.35, [0, 2.18, 0], "#fff3c0");
    for (const side of [-1, 1]) {
      for (const axle of [-0.32, 0.32]) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.48, 0.24, 12),
          new THREE.MeshStandardMaterial({ color: "#10191b", roughness: 1 }));
        wheel.rotation.x = Math.PI / 2;
        wheel.position.set(length * axle, 0.48, side * (width / 2 - 0.12));
        this.taxi.add(wheel);
      }
      const light = box(0.08, 0.18, width * 0.2, [length / 2 - 0.04, 0.95, side * width * 0.3], "#fff1bd");
      light.material.emissive.set("#ffe0a0"); light.material.emissiveIntensity = 1.5;
      const tail = box(0.08, 0.18, width * 0.2, [-length / 2 + 0.04, 0.95, side * width * 0.3], "#e93736");
      tail.material.emissive.set("#e93736");
    }
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(length * 1.15, width * 1.2),
      new THREE.MeshBasicMaterial({ color: "#050c10", transparent: true, opacity: 0.55, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.08;
    this.taxi.add(shadow);
    this.scene.add(this.taxi);
  }
  buildMarkers() {
    this.markers = this.stops.map(stop => {
      const color = stop.id === "depot" ? "#85bada" : "#92d7b6";
      const marker = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.TorusGeometry(3, 0.3, 8, 32),
        new THREE.MeshBasicMaterial({ color, depthTest: false }));
      ring.rotation.x = Math.PI / 2; ring.position.y = 0.4; ring.renderOrder = 20;
      const beacon = new THREE.Mesh(new THREE.ConeGeometry(1.2, 2.2, 6),
        new THREE.MeshBasicMaterial({ color, depthTest: false }));
      beacon.rotation.z = Math.PI; beacon.position.y = 5; beacon.renderOrder = 20;
      marker.add(ring, beacon);
      marker.position.set(stop.point[0], 0, stop.point[1]);
      marker.name = `stop-${stop.id}`;
      this.scene.add(marker);
      return { stop, marker, ring, beacon };
    });
    this.label = document.createElement("div");
    this.label.className = "world-label";
    this.label.hidden = true;
    this.label.setAttribute("role", "status");
    this.canvas.parentElement.append(this.label);
    this.roadLabel = document.createElement("div");
    this.roadLabel.className = "road-label";
    this.canvas.parentElement.append(this.roadLabel);
  }
  ribbon(edges, color, width, height, start = null) {
    const positions = [];
    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i];
      if (!edge) continue;
      const a = i === 0 && start ? [start.x, start.y] : this.data.nodes[edge.a], b = this.data.nodes[edge.b];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (!length) continue;
      const x = -(b[1] - a[1]) / length * width / 2, z = (b[0] - a[0]) / length * width / 2;
      const p = [[a[0] + x, height, a[1] + z], [a[0] - x, height, a[1] - z],
        [b[0] + x, height, b[1] + z], [b[0] - x, height, b[1] - z]];
      for (const index of [0, 2, 1, 1, 2, 3]) positions.push(...p[index]);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide,
      transparent: true, opacity: 0.85, depthWrite: false }));
    this.overlays.add(mesh);
    return mesh;
  }
  updateOverlays(state, approach, previewExit) {
    const key = JSON.stringify([state.closed, state.traffic, state.route, state.phase,
      state.selected_exit, approach?.edges[0]?.id, approach?.incoming, approach?.exits.map(e => e.edge.id), previewExit]);
    if (key === this.overlayKey) return;
    this.overlayKey = key;
    for (const child of [...this.overlays.children]) {
      child.geometry.dispose(); child.material.dispose(); this.overlays.remove(child);
    }
    this.forwardRibbon = null;
    const closed = new Set(state.closed);
    this.ribbon([...this.edges.values()].filter(e => closed.has(e.way)), "#ed8879", 3, 0.12);
    this.ribbon([...this.edges.values()].filter(e => !closed.has(e.way) && state.traffic[e.way]), "#bd955c", 1, 0.14);
    if (approach) {
      this.forwardRibbon = this.ribbon(approach.edges, "#92d7b6", 1.4, 0.16);
      const index = state.route?.indexOf(approach.incoming) ?? -1;
      for (const { edge, path } of approach.exits) {
        const selected = edge.id === previewExit || edge.id === state.selected_exit;
        this.ribbon(path.edges, selected ? "#55e9ff" : edge.id === state.route?.[index + 1] ? "#f5c65a" : "#92d7b6",
          selected ? 2 : 1, 0.2);
      }
    }
    if (state.route) this.ribbon(state.route.map(id => this.edges.get(id)),
      state.phase === "pickup" ? "#92d7b6" : "#f5c65a", 0.8, 0.25);
  }
  render(car, state, lang, approach, previewExit = null) {
    const forward = new THREE.Vector3(Math.cos(car.heading), 0, Math.sin(car.heading));
    const position = new THREE.Vector3(car.x, 0, car.y);
    this.taxi.position.copy(position);
    this.taxi.rotation.y = -car.heading;
    const distance = Math.min(150, 48 * 1.65 / this.zoom);
    const target = position.clone().addScaledVector(forward, 10);
    target.y = 1;
    const eye = position.clone().addScaledVector(forward, -distance * 0.9);
    eye.y = distance * 0.6;
    if (this.overview) {
      const [left, top, right, bottom] = this.data.bounds;
      const span = Math.max(bottom - top, (right - left) / this.lens.aspect);
      target.set((left + right) / 2, 0, (top + bottom) / 2);
      eye.copy(target).add(new THREE.Vector3(0, span * 1.4, span * 0.15));
      this.scene.fog.far = 6000; this.scene.fog.near = 4000;
    } else {
      this.scene.fog.near = 80; this.scene.fog.far = 220;
    }
    const now = performance.now(), dt = this.lastRender ? Math.min((now - this.lastRender) / 1000, 0.1) : 1;
    if (this.lastRender && !this.overview) {
      this.frameTimes.push(dt);
      if (this.frameTimes.length === 12) {
        const average = this.frameTimes.reduce((sum, value) => sum + value, 0) / this.frameTimes.length;
        if (average > 1 / 28 && this.quality > 0.55) {
          this.quality = Math.max(0.55, this.quality * Math.sqrt((1 / 36) / average));
          this.resize();
        }
        this.frameTimes = [];
      }
    }
    this.lastRender = now;
    this.lens.position.lerp(eye, this.cameraReady ? 1 - Math.exp(-7 * dt) : 1);
    this.lookAt ??= target.clone();
    this.lookAt.lerp(target, this.cameraReady ? 1 - Math.exp(-10 * dt) : 1);
    this.lens.lookAt(this.lookAt);
    this.lens.setViewOffset(innerWidth, innerHeight, innerWidth > 800 ? -innerWidth * 0.13 : 0,
      innerHeight * 0.04, innerWidth, innerHeight);
    this.cameraReady = true;
    this.camera.x = car.x; this.camera.y = car.y;
    // Fade entire small blocks intersecting the camera sightline, keeping the taxi visible.
    const line = new THREE.Line3(this.lens.position, position.clone().setY(1));
    const closest = new THREE.Vector3();
    for (const building of this.buildings) {
      const sphere = building.geometry.boundingSphere;
      building.visible = this.overview || sphere.center.distanceTo(position) < 220 + sphere.radius;
      if (!building.visible) continue;
      line.closestPointToPoint(sphere.center, true, closest);
      const obstructs = closest.distanceTo(sphere.center) < sphere.radius + 6
        && sphere.center.distanceTo(position) < distance + sphere.radius;
      building.material = !this.overview && obstructs ? this.fadedCityMaterial : this.cityMaterial;
    }
    if (state) {
      this.updateOverlays(state, approach, previewExit);
      if (this.forwardRibbon && approach?.start) {
        const edge = approach.edges[0], a = this.data.nodes[edge.a], end = this.data.nodes[edge.b], start = approach.start;
        const length = Math.hypot(end[0] - a[0], end[1] - a[1]);
        const vertices = this.forwardRibbon.geometry.getAttribute("position");
        if (length > 1e-6 && vertices.count >= 6) {
          const x = -(end[1] - a[1]) / length * 0.7, z = (end[0] - a[0]) / length * 0.7;
          vertices.setXYZ(0, start.x + x, 0.16, start.y + z);
          vertices.setXYZ(2, start.x - x, 0.16, start.y - z);
          vertices.setXYZ(3, start.x - x, 0.16, start.y - z);
          vertices.needsUpdate = true;
        }
      }
      let activeLabel = null;
      for (const item of this.markers) {
        const { stop, marker, ring, beacon } = item;
        const active = state.phase === "pickup" ? stop.id === state.pickup
          : state.phase === "onboard" ? stop.id === state.destination : false;
        marker.visible = active || stop.id === "depot";
        beacon.visible = marker.position.distanceTo(position) > 12;
        const color = stop.id === "depot" ? "#85bada" : state.phase === "pickup" ? "#92d7b6" : "#f5c65a";
        ring.material.color.set(color); beacon.material.color.set(color);
        if (active || (!activeLabel && stop.id === "depot")) activeLabel = item;
      }
      this.label.hidden = true;
      if (activeLabel && !this.overview) {
        const point = activeLabel.marker.position.clone().setY(7).project(this.lens);
        if (point.z > -1 && point.z < 1 && Math.abs(point.x) < 0.9 && Math.abs(point.y) < 0.9) {
          this.label.textContent = lang === "zh" ? activeLabel.stop.zh : activeLabel.stop.name;
          this.label.style.left = `${(point.x + 1) * innerWidth / 2}px`;
          this.label.style.top = `${(1 - point.y) * innerHeight / 2}px`;
          this.label.hidden = false;
        }
      }
    }
    this.roadLabel.textContent = this.edges.get(car.edge)?.[lang === "zh" ? "zh" : "name"] ?? "";
    this.roadLabel.hidden = this.overview || !this.roadLabel.textContent;
    this.renderer.render(this.scene, this.lens);
  }
  dispose() {
    window.removeEventListener("resize", this.onResize);
    this.label?.remove();
    this.roadLabel?.remove();
    const geometries = new Set(), materials = new Set();
    this.scene.traverse(object => {
      if (object.geometry) geometries.add(object.geometry);
      if (object.material) materials.add(object.material);
    });
    geometries.forEach(geometry => geometry.dispose());
    if (this.cityMaterial) materials.add(this.cityMaterial);
    if (this.fadedCityMaterial) materials.add(this.fadedCityMaterial);
    materials.forEach(material => material.dispose());
    this.resources.forEach(resource => resource.dispose());
    this.renderer.dispose();
  }
}
