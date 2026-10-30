import * as THREE from "./vendor/three/three.module.min.js";
import { MapView } from "./map.mjs?v=minimap-2";
import polygonClipping from "./vendor/polygon-clipping/polygon-clipping.mjs";

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
    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, { depthTexture: new THREE.DepthTexture(1, 1) });
    const outputMaterial = new THREE.MeshBasicMaterial({ map: this.sceneTarget.texture, depthTest: false, depthWrite: false });
    this.outputSize = new THREE.Vector2();
    this.sceneSize = new THREE.Vector2();
    const output = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), outputMaterial);
    this.outputScene = new THREE.Scene();
    this.outputScene.add(output);
    this.outputCamera = new THREE.Camera();
    this.boundaryScene = new THREE.Scene();
    this.boundaryScene.fog = this.scene.fog;
    this.resources.push(this.sceneTarget, output.geometry, outputMaterial);
    try {
      this.buildGround();
      this.buildBoundaries();
      this.buildCity();
      this.buildTaxi();
      this.overlays = new THREE.Group();
      this.boundaryScene.add(this.overlays);
      this.overlayKey = null;
      this.buildMarkers();
      this.detailWorker = new Worker(new URL("./map3d-worker.mjs?v=pixel-texture-1", import.meta.url), { type: "module" });
      this.detailWorker.postMessage({ type: "init", map: this.data, edges: this.groundMap.unique,
        size: this.detailSize, scale: this.detailScale });
      this.detailWorker.onmessage = ({ data }) => {
        this.detailPending = false;
        this.readyDetail = data;
      };
      this.detailWorker.onerror = event => {
        console.error("3D detail worker failed", event.message);
        this.canvas.dispatchEvent(new CustomEvent("renderererror", { detail: event.message }));
      };
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
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.renderer.getDrawingBufferSize(this.outputSize);
    this.sceneTarget.setSize(Math.ceil(innerWidth * this.quality), Math.ceil(innerHeight * this.quality));
    this.sceneSize.set(this.sceneTarget.width, this.sceneTarget.height);
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
    this.overviewTexture = texture;
    map.backdrop = document.createElement("canvas");
    const chaseContext = map.backdrop.getContext("2d");
    chaseContext.fillText = () => {};
    chaseContext.strokeText = () => {};
    map.drawRoadBoundaries = () => {};
    map.drawRoadDirections = () => {};
    map.buildBackdrop(this.data.bounds, scale);
    this.chaseTexture = new THREE.CanvasTexture(map.backdrop);
    this.chaseTexture.colorSpace = THREE.SRGBColorSpace;
    this.chaseTexture.anisotropy = texture.anisotropy;
    this.resources.push(this.chaseTexture);
    const geometry = new THREE.PlaneGeometry(right - left, bottom - top);
    geometry.rotateX(-Math.PI / 2);
    const ground = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: texture }));
    ground.position.set((left + right) / 2, 0, (top + bottom) / 2);
    ground.name = "district-roads";
    this.ground = ground;
    this.scene.add(ground);
    this.groundMap = map;
    this.detailMap = Object.create(map);
    this.detailMap.drawRoadBoundaries = () => {};
    this.detailMap.drawRoadDirections = () => {};
    this.detailMap.backdrop = document.createElement("canvas");
    this.detailMap.backdropBounds = null;
    const detailContext = this.detailMap.backdrop.getContext("2d", { willReadFrequently: true });
    detailContext.fillText = () => {};
    detailContext.strokeText = () => {};
    this.detailSize = 384;
    this.detailScale = Math.min(8, this.renderer.capabilities.maxTextureSize / this.detailSize);
    const detailTexture = new THREE.DataTexture();
    detailTexture.flipY = true;
    detailTexture.generateMipmaps = true;
    detailTexture.magFilter = THREE.LinearFilter;
    detailTexture.minFilter = THREE.LinearMipmapLinearFilter;
    detailTexture.colorSpace = THREE.SRGBColorSpace;
    detailTexture.anisotropy = texture.anisotropy;
    this.resources.push(detailTexture);
    const detailGeometry = new THREE.PlaneGeometry(this.detailSize, this.detailSize);
    detailGeometry.rotateX(-Math.PI / 2);
    this.groundDetail = new THREE.Mesh(detailGeometry, new THREE.MeshBasicMaterial({ map: detailTexture }));
    this.groundDetail.name = "district-roads-detail";
    this.groundDetail.visible = false;
    this.scene.add(this.groundDetail);
  }
  updateGroundDetail(car) {
    this.groundDetail.visible = !this.overview;
    if (this.overview) return;
    if (this.readyDetail) {
      const { x, y, buffers, image } = this.readyDetail;
      this.readyDetail = null;
      for (const [index, mesh] of [this.boundaryOutline, this.directionLines].entries()) {
        const geometry = new THREE.BufferGeometry();
        for (const [name, array] of Object.entries(buffers[index])) {
          geometry.setAttribute(name, new THREE.BufferAttribute(array, 3));
        }
        mesh.geometry.dispose();
        mesh.geometry = geometry;
      }
      this.refreshGroundDetail(x, y, image);
    }
    // Reuse one local texture, refreshing only after crossing a 64 m cache cell.
    const x = Math.round(car.x / 64) * 64, y = Math.round(car.y / 64) * 64;
    if (this.groundDetail.position.x === x && this.groundDetail.position.z === y
        && this.detailMap.backdropBounds) return;
    if (this.detailWorker && this.detailMap.backdropBounds) {
      if (!this.detailPending) {
        this.detailPending = true;
        this.detailWorker.postMessage({ type: "update", x, y });
      }
      return;
    }
    this.refreshGroundDetail(x, y);
    if (this.boundaryOutline) this.updateBoundaries(x, y);
    if (this.directionLines) this.updateDirections(x, y);
  }
  refreshGroundDetail(x, y, image = null) {
    const half = this.detailSize / 2;
    const bounds = [x - half, y - half, x + half, y + half];
    if (image) {
      this.detailMap.backdropBounds = bounds;
      this.detailMap.backdropScale = this.detailScale;
    } else {
      this.detailMap.buildBackdrop(bounds, this.detailScale);
      const canvas = this.detailMap.backdrop;
      image = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    }
    this.groundDetail.position.set(x, 0.02, y);
    // Typed pixels avoid the GPU canvas/bitmap synchronization that stalls ANGLE.
    this.groundDetail.material.map.image = image;
    this.groundDetail.material.map.needsUpdate = true;
  }
  buildBoundaries() {
    this.boundaryOutline = new THREE.Mesh(new THREE.BufferGeometry(), this.smoothLineMaterial("#f15e5e", 0.8));
    this.boundaryOutline.position.y = 0.04;
    this.boundaryOutline.name = "road-boundaries";
    this.boundaryOutline.renderOrder = 3;
    this.boundaryScene.add(this.boundaryOutline);
    this.directionLines = new THREE.Mesh(new THREE.BufferGeometry(), this.smoothLineMaterial("#c2d0bf", 1));
    this.directionLines.name = "road-direction-arrows";
    this.directionLines.renderOrder = 6;
    this.boundaryScene.add(this.directionLines);
  }
  updateDirections(x, y) {
    const segments = [], half = this.detailSize / 2;
    for (const arrow of this.groundMap.directionArrows()) {
      if (Math.abs(arrow.x - x) > half - 4 || Math.abs(arrow.y - y) > half - 4) continue;
      const point = (a, b) => [arrow.x + Math.cos(arrow.angle) * a - Math.sin(arrow.angle) * b,
        arrow.y + Math.sin(arrow.angle) * a + Math.cos(arrow.angle) * b];
      segments.push([point(-3, 0), point(3, 0)], [point(0, -2), point(3, 0)], [point(3, 0), point(0, 2)]);
    }
    const geometry = this.roundLineGeometry(segments, 0.9, 0.06);
    this.directionLines.geometry.dispose();
    this.directionLines.geometry = geometry;
  }
  smoothLineMaterial(color, opacity = 0.85) {
    const material = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
    });
    material.onBeforeCompile = shader => {
      shader.uniforms.sceneDepth = { value: this.sceneTarget.depthTexture };
      shader.uniforms.outputSize = { value: this.outputSize };
      shader.uniforms.sceneSize = { value: this.sceneSize };
      shader.vertexShader = `attribute vec3 boundaryCoord;\nvarying vec3 vBoundaryCoord;\n${shader.vertexShader}`
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvBoundaryCoord = boundaryCoord;");
      shader.fragmentShader = `uniform sampler2D sceneDepth;\nuniform vec2 outputSize;\nuniform vec2 sceneSize;\nvarying vec3 vBoundaryCoord;\n${shader.fragmentShader}`
        .replace("#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>
          float depthTolerance = max(0.000002, fwidth(gl_FragCoord.z) * max(outputSize.x / sceneSize.x, outputSize.y / sceneSize.y) * 1.5);
          if (gl_FragCoord.z > texture2D(sceneDepth, gl_FragCoord.xy / outputSize).r + depthTolerance) discard;`)
        .replace("#include <opaque_fragment>", `
          vec3 coverage = smoothstep(vec3(0.0), max(fwidth(vBoundaryCoord), vec3(0.00001)), vBoundaryCoord);
          diffuseColor.a *= min(coverage.x, min(coverage.y, coverage.z));
          #include <opaque_fragment>`);
    };
    return material;
  }
  updateBoundaries(x, y) {
    const half = this.detailSize / 2;
    const edges = this.groundMap.unique.filter(edge => {
      const a = this.data.nodes[edge.a], b = this.data.nodes[edge.b];
      const margin = (this.data.driving.widths[edge.kind] ?? 10) / 2 + 1;
      return Math.max(a[0], b[0]) + margin >= x - half && Math.min(a[0], b[0]) - margin <= x + half
        && Math.max(a[1], b[1]) + margin >= y - half && Math.min(a[1], b[1]) - margin <= y + half;
    });
    const unions = [];
    for (const inset of [0.5, -0.5]) {
      const polygons = [];
      for (const edge of edges) {
        const width = this.data.driving.widths[edge.kind] ?? 10;
        const radius = Math.max(0, width / 2 - (this.data.driving.taxi_length ? 0 : this.data.driving.taxi_radius));
        const r = Math.max(0, radius + inset);
        if (!r) continue;
        const a = this.data.nodes[edge.a], b = this.data.nodes[edge.b];
        const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
        const points = [];
        for (const [centre, start] of [[b, angle - Math.PI / 2], [a, angle + Math.PI / 2]]) {
          for (let i = 0; i <= 16; i++) {
            const theta = start + i * Math.PI / 16;
            points.push([centre[0] + r * Math.cos(theta), centre[1] + r * Math.sin(theta)]);
          }
        }
        points.push(points[0]);
        polygons.push([points]);
      }
      unions.push(polygons.length ? polygonClipping.union(...polygons) : []);
    }
    const perimeter = unions[0].length ? polygonClipping.difference(unions[0], unions[1]) : [];
    const bounds = [[[x - half, y - half], [x + half, y - half], [x + half, y + half],
      [x - half, y + half], [x - half, y - half]]];
    const outlines = perimeter.length ? polygonClipping.intersection(perimeter, bounds) : [];
    this.boundaryOutline.geometry.dispose();
    this.boundaryOutline.geometry = this.lineGeometry(outlines);
  }
  lineGeometry(outlines) {
    const hasHoles = outlines.some(polygon => polygon.length > 1);
    const contourSegments = hasHoles ? outlines.flatMap(polygon => polygon.flatMap(ring =>
      ring.slice(1).map((point, i) => [ring[i], point]))) : [];
    const pending = [...outlines], shapes = [];
    // Narrow, concave holes can confuse hole-bridging triangulation. Cut through
    // each hole first, leaving simple polygons with the exact same perimeter.
    while (pending.length) {
      const polygon = pending.pop();
      if (polygon.length === 1) {
        shapes.push(new THREE.Shape(polygon[0].map(([px, py]) => new THREE.Vector2(px, -py))));
        continue;
      }
      const xs = polygon[1].map(point => point[0]);
      const split = (Math.min(...xs) + Math.max(...xs)) / 2;
      const points = polygon[0];
      const left = Math.min(...points.map(point => point[0])) - 1;
      const right = Math.max(...points.map(point => point[0])) + 1;
      const top = Math.min(...points.map(point => point[1])) - 1;
      const bottom = Math.max(...points.map(point => point[1])) + 1;
      for (const [a, b] of [[left, split], [split, right]]) {
        pending.push(...polygonClipping.intersection(polygon,
          [[[a, top], [b, top], [b, bottom], [a, bottom], [a, top]]]));
      }
    }
    const indexed = new THREE.ShapeGeometry(shapes);
    const indices = indexed.index.array, edgeCounts = new Map();
    const positions = indexed.getAttribute("position");
    const vertices = new Map();
    const vertexIds = Array.from({ length: positions.count }, (_, i) => {
      const point = `${positions.getX(i)}:${positions.getY(i)}`;
      if (!vertices.has(point)) vertices.set(point, vertices.size);
      return vertices.get(point);
    });
    const key = (a, b) => {
      a = vertexIds[a]; b = vertexIds[b];
      return a < b ? `${a}:${b}` : `${b}:${a}`;
    };
    for (let i = 0; i < indices.length; i += 3) {
      for (let j = 0; j < 3; j++) {
        const edge = key(indices[i + j], indices[i + (j + 1) % 3]);
        edgeCounts.set(edge, (edgeCounts.get(edge) ?? 0) + 1);
      }
    }
    const coordinates = [];
    const isContourEdge = (a, b) => {
      if (edgeCounts.get(key(a, b)) !== 1) return false;
      if (!hasHoles) return true;
      const x = (positions.getX(a) + positions.getX(b)) / 2;
      const y = -(positions.getY(a) + positions.getY(b)) / 2;
      return contourSegments.some(([from, to]) => {
        const dx = to[0] - from[0], dy = to[1] - from[1], length = dx * dx + dy * dy;
        const t = length ? Math.max(0, Math.min(1, ((x - from[0]) * dx + (y - from[1]) * dy) / length)) : 0;
        return Math.hypot(x - from[0] - t * dx, y - from[1] - t * dy) < 0.0002;
      });
    };
    for (let i = 0; i < indices.length; i += 3) {
      const boundary = [0, 1, 2].map(j =>
        isContourEdge(indices[i + (j + 1) % 3], indices[i + (j + 2) % 3]));
      for (let vertex = 0; vertex < 3; vertex++) {
        for (let component = 0; component < 3; component++) {
          coordinates.push(!boundary[component] || vertex === component ? 1 : 0);
        }
      }
    }
    const geometry = indexed.toNonIndexed();
    indexed.dispose();
    geometry.setAttribute("boundaryCoord", new THREE.Float32BufferAttribute(coordinates, 3));
    geometry.rotateX(-Math.PI / 2);
    return geometry;
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
        new THREE.MeshBasicMaterial({ color }));
      ring.rotation.x = Math.PI / 2; ring.position.y = 0.4; ring.renderOrder = 20;
      const beacon = new THREE.Mesh(new THREE.ConeGeometry(1.2, 2.2, 6),
        new THREE.MeshBasicMaterial({ color }));
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
    const geometry = this.ribbonGeometry(edges, width, height, start);
    const mesh = new THREE.Mesh(geometry, this.smoothLineMaterial(color));
    mesh.renderOrder = Math.round(height * 100);
    this.overlays.add(mesh);
    return mesh;
  }
  ribbonGeometry(edges, width, height, start = null) {
    const segments = [];
    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i];
      if (!edge) continue;
      const a = i === 0 && start ? [start.x, start.y] : this.data.nodes[edge.a], b = this.data.nodes[edge.b];
      segments.push([a, b]);
    }
    return this.roundLineGeometry(segments, width, height);
  }
  roundLineGeometry(segments, width, height) {
    const polygons = [];
    for (const [a, b] of segments) {
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (!length) continue;
      const angle = Math.atan2(b[1] - a[1], b[0] - a[0]), points = [];
      for (const [centre, theta] of [[b, angle - Math.PI / 2], [a, angle + Math.PI / 2]]) {
        for (let j = 0; j <= 16; j++) {
          points.push([centre[0] + width / 2 * Math.cos(theta + j * Math.PI / 16),
            centre[1] + width / 2 * Math.sin(theta + j * Math.PI / 16)]);
        }
      }
      points.push(points[0]);
      polygons.push([points]);
    }
    const geometry = this.lineGeometry(polygons.length ? polygonClipping.union(...polygons) : []);
    geometry.translate(0, height, 0);
    return geometry;
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
    this.forwardStart = null;
    const closed = new Set(state.closed);
    this.ribbon([...this.edges.values()].filter(e => closed.has(e.way)), "#ed8879", 3, 0.12);
    this.ribbon([...this.edges.values()].filter(e => !closed.has(e.way) && state.traffic[e.way]), "#bd955c", 1, 0.14);
    if (approach) {
      this.forwardRibbon = this.ribbon(approach.edges, "#92d7b6", 1.4, 0.16);
      const index = state.route?.indexOf(approach.incoming) ?? -1;
      for (const { edge, path } of approach.exits) {
        const selected = edge.id === previewExit || edge.id === state.selected_exit;
        const suggested = index >= 0 && edge.id === state.route?.[index + 1];
        this.ribbon(path.edges, selected ? "#55e9ff" : suggested ? "#f5c65a" : "#92d7b6",
          selected ? 2 : 1, selected ? 0.3 : suggested ? 0.22 : 0.18);
      }
    }
    if (state.route) this.ribbon(state.route.map(id => this.edges.get(id)),
      state.phase === "pickup" ? "#24ca72" : "#f3c047", 0.8, state.phase === "pickup" ? 0.25 : 0.22);
  }
  updateCameraHeading(heading, dt) {
    if (!this.cameraReady) {
      this.cameraHeading = heading;
      return;
    }
    const difference = Math.atan2(Math.sin(heading - this.cameraHeading), Math.cos(heading - this.cameraHeading));
    const change = difference * (1 - Math.exp(-2 * dt));
    const limit = 0.9 * dt;
    this.cameraHeading += Math.max(-limit, Math.min(limit, change));
  }
  render(car, state, lang, approach, previewExit = null) {
    const now = performance.now(), dt = this.lastRender ? Math.min((now - this.lastRender) / 1000, 0.1) : 1;
    this.updateCameraHeading(car.heading, dt);
    this.ground.material.map = this.overview ? this.overviewTexture : this.chaseTexture;
    this.updateGroundDetail(car);
    this.boundaryOutline.visible = !this.overview;
    this.directionLines.visible = !this.overview;
    const forward = new THREE.Vector3(Math.cos(this.cameraHeading), 0, Math.sin(this.cameraHeading));
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
    this.lens.position.lerp(eye, this.cameraReady ? 1 - Math.exp(-5 * dt) : 1);
    this.lookAt ??= target.clone();
    this.lookAt.lerp(target, this.cameraReady ? 1 - Math.exp(-4 * dt) : 1);
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
        const start = approach.start;
        if (!this.forwardStart || start.x !== this.forwardStart.x || start.y !== this.forwardStart.y) {
          const geometry = this.ribbonGeometry(approach.edges, 1.4, 0.16, start);
          this.forwardRibbon.geometry.dispose();
          this.forwardRibbon.geometry = geometry;
          this.forwardStart = { x: start.x, y: start.y };
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
    this.drawScene();
  }
  drawScene() {
    // Keep boundary edges at screen resolution even when the city pass scales down.
    this.renderer.setRenderTarget(this.sceneTarget);
    this.renderer.render(this.scene, this.lens);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.outputScene, this.outputCamera);
    this.renderer.autoClear = false;
    this.renderer.render(this.boundaryScene, this.lens);
    this.renderer.autoClear = true;
  }
  dispose() {
    this.detailWorker?.terminate();
    window.removeEventListener("resize", this.onResize);
    this.label?.remove();
    this.roadLabel?.remove();
    const geometries = new Set(), materials = new Set();
    this.scene.traverse(object => {
      if (object.geometry) geometries.add(object.geometry);
      if (object.material) materials.add(object.material);
    });
    this.boundaryScene.traverse(object => {
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
