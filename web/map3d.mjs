import * as THREE from "./vendor/three/three.module.min.js";
import { MapView } from "./map.mjs?v=tunnel-clearance-1";
import { doorSide, peopleOnMap, drawHailBubble, HAIL_BUBBLE } from "./citizens.mjs?v=parabolic-steering-1";
import { en, zh } from "./i18n.mjs?v=parabolic-steering-1";
import polygonClipping from "./vendor/polygon-clipping/polygon-clipping.mjs";
import { surfacePose, surfaceSegments, terrainHeight, isElevatedRoad, isGroundRoad, isTunnelRoad }
  from "./elevation.mjs?v=tunnel-clearance-1";
import { staticCollisionLines, COLLISION_LINE_WIDTH } from "./collision-lines.mjs?v=tunnel-clearance-1";
import { roadWidth } from "./road-width.mjs";
import { WORLD_SCALE } from "./world-scale.mjs";
import { mergeStraightSegments, straightJoin } from "./straight-lines.mjs";
import { project } from "./physics.mjs?v=tunnel-clearance-1";
import { visualStream } from "./map-stream.mjs";

export class Map3DView {
  constructor(canvas, data, stops) {
    this.canvas = canvas;
    this.data = data;
    this.stops = stops;
    this.zoom = 1.65;
    this.overview = false;
    this.camera = { x: 0, y: 0 };
    this.edges = new Map(data.edges.map(edge => [edge.id, edge]));
    this.nodes = data.nodes;
    this.elevation = data.elevation;
    this.stream = visualStream(data);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(1);
    this.quality = 1;
    this.graphicsMode = "auto";
    this.minimumQuality = .55;
    this.cameraSmoothness = 0.6;
    this.cameraRotationSpeed = 0.9;
    this.chaseDistanceScale = 1;
    this.reducedMotion = false;
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
    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, {
      depthTexture: new THREE.DepthTexture(1, 1),
      samples: Math.min(4, this.renderer.capabilities.maxSamples),
    });
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
      if (this.elevation) {
        if (this.stream) { this.structures = []; this.roadBuildTask = this.roadSurfaceGeometry(); }
        else this.buildRoadSurfaces();
      }
      this.buildCity();
      this.buildTaxi();
      this.buildCitizens();
      this.overlays = new THREE.Group();
      this.boundaryScene.add(this.overlays);
      this.overlayKey = null;
      this.buildMarkers();
      this.detailWorker = new Worker(new URL("./map3d-worker.mjs?v=tunnel-clearance-1", import.meta.url), { type: "module" });
      this.detailWorker.postMessage({ type: "init", map: this.data,
        edges: this.elevation ? this.groundMap.unique.filter(isGroundRoad)
          : this.groundMap.unique,
        size: this.detailSize, scale: this.detailScale, revision: this.stream?.revision ?? 0 });
      this.detailWorker.onmessage = ({ data }) => {
        if (data.type === "route") {
          if (data.request === this.pendingRoute?.request) this.readyRoute = data;
          return;
        }
        this.detailPending = false;
        this.readyDetail = data;
      };
      this.detailWorker.onerror = event => {
        console.error("3D detail worker failed", event.message);
        this.canvas.dispatchEvent(new CustomEvent("renderererror", { detail: event.message }));
      };
      this.unsubscribeStream = this.stream?.subscribe(() => {
        this.detailWorker.postMessage({ type: "visuals", backdrop: this.data.backdrop,
          revision: this.stream.revision });
      });
    } catch (error) {
      this.dispose();
      throw error;
    }
    this.cameraReady = false;
    this.onResize = () => this.resize();
    window.addEventListener("resize", this.onResize);
    this.resize();
  }
  applyPreferences(preferences) {
    const presets = {
      auto: [1, .55],
      quality: [1, 1],
      performance: [0.75, 0.5],
    };
    const [quality, minimum] = presets[preferences.graphics] || presets.auto;
    const previousQuality = this.quality;
    const resizeNeeded = preferences.graphics !== this.graphicsMode;
    this.quality = resizeNeeded ? quality : Math.max(minimum, this.quality);
    this.graphicsMode = preferences.graphics;
    this.minimumQuality = minimum;
    this.cameraSmoothness = preferences.cameraSmoothness / 100;
    this.cameraRotationSpeed = preferences.cameraRotationSpeed / 100;
    this.chaseDistanceScale = preferences.chaseDistance / 100;
    this.reducedMotion = preferences.reducedMotion;
    this.frameTimes = [];
    if (resizeNeeded || this.quality !== previousQuality) this.resize();
  }
  resize() {
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.renderer.getDrawingBufferSize(this.outputSize);
    this.sceneTarget.setSize(Math.ceil(this.outputSize.x * this.quality), Math.ceil(this.outputSize.y * this.quality));
    this.sceneSize.set(this.sceneTarget.width, this.sceneTarget.height);
    this.lens.aspect = innerWidth / innerHeight;
    this.lens.updateProjectionMatrix();
  }
  buildGround() {
    const [left, top, right, bottom] = this.data.bounds;
    const map = Object.create(MapView.prototype);
    map.data = this.data;
    map.collisionLines = staticCollisionLines(this.data);
    map.drawCollisionLines = () => {};
    map.backdrop = document.createElement("canvas");
    const seen = new Set();
    map.unique = this.data.edges.filter(edge => {
      const key = `${edge.way}:${[edge.a, edge.b].sort().join(":")}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    const allRoads = map.unique;
    if (this.elevation) {
      map.unique = allRoads.filter(isGroundRoad);
      map.drawRoadDirections = () => {};
    }
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
    map.drawRoadDirections = () => {};
    const chaseLimit = Math.min(8192, this.renderer.capabilities.maxTextureSize);
    const chaseScale = this.elevation
      ? Math.min(3, chaseLimit / Math.max(right - left, bottom - top)) : scale;
    map.buildBackdrop(this.data.bounds, chaseScale);
    map.unique = allRoads;
    this.chaseTexture = new THREE.CanvasTexture(map.backdrop);
    this.chaseTexture.colorSpace = THREE.SRGBColorSpace;
    this.chaseTexture.anisotropy = texture.anisotropy;
    this.chaseTexture.name = "high-detail-terrain";
    this.resources.push(this.chaseTexture);
    const geometry = new THREE.PlaneGeometry(right - left, bottom - top,
      this.elevation ? this.elevation.terrain.width - 1 : 1,
      this.elevation ? this.elevation.terrain.height - 1 : 1);
    geometry.rotateX(-Math.PI / 2);
    if (this.elevation) {
      const positions = geometry.getAttribute("position");
      const cells = new Map();
      for (const edge of map.unique) {
        if (!isGroundRoad(edge)) continue;
        const a = this.nodes[edge.a], b = this.nodes[edge.b], margin = 20;
        for (let i = Math.floor((Math.min(a[0], b[0]) - margin) / 40); i <= Math.floor((Math.max(a[0], b[0]) + margin) / 40); i++)
          for (let j = Math.floor((Math.min(a[1], b[1]) - margin) / 40); j <= Math.floor((Math.max(a[1], b[1]) + margin) / 40); j++) {
            const key = `${i}:${j}`;
            if (!cells.has(key)) cells.set(key, []);
            cells.get(key).push(edge);
          }
      }
      for (let i = 0; i < positions.count; i++) {
        const x = positions.getX(i) + (left + right) / 2, y = positions.getZ(i) + (top + bottom) / 2;
        let z = terrainHeight(this.elevation, x, y);
        for (const edge of cells.get(`${Math.floor(x / 40)}:${Math.floor(y / 40)}`) || []) {
          const a = this.nodes[edge.a], b = this.nodes[edge.b];
          const dx = b[0] - a[0], dy = b[1] - a[1];
          const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
          if (Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy) < roadWidth(this.data.driving, edge) / 2 + 12)
            z = Math.min(z, surfacePose(this, edge, { x, y }, 0).height - .12);
        }
        positions.setY(i, z);
      }
      geometry.computeVertexNormals();
    }
    const ground = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: texture }));
    ground.position.set((left + right) / 2, 0, (top + bottom) / 2);
    ground.name = "district-roads";
    this.ground = ground;
    this.scene.add(ground);
    this.terrainTiles = [];
    if (this.elevation) {
      const { width, height } = this.elevation.terrain;
      for (let j = 0; j < height - 1; j += 20) for (let i = 0; i < width - 1; i += 20) {
        const indices = [];
        for (let row = j; row < Math.min(j + 20, height - 1); row++)
          for (let col = i; col < Math.min(i + 20, width - 1); col++) {
            const a = row * width + col, b = a + width;
            indices.push(a, b, a + 1, b, b + 1, a + 1);
          }
        const tileGeometry = new THREE.BufferGeometry();
        for (const [key, attribute] of Object.entries(geometry.attributes)) tileGeometry.setAttribute(key, attribute);
        tileGeometry.setIndex(indices);
        const box = new THREE.Box3(), point = new THREE.Vector3();
        for (const index of indices) box.expandByPoint(point.fromBufferAttribute(geometry.getAttribute("position"), index));
        tileGeometry.boundingBox = box;
        tileGeometry.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
        const tile = new THREE.Mesh(tileGeometry, ground.material);
        tile.position.copy(ground.position);
        tile.name = "culled-terrain-tile";
        this.scene.add(tile); this.terrainTiles.push(tile);
      }
    }
    this.groundMap = map;
    this.detailMap = Object.create(map);
    if (this.elevation) {
      this.detailMap.unique = allRoads.filter(isGroundRoad);
    }
    this.detailMap.drawRoadDirections = () => {};
    this.detailMap.backdrop = document.createElement("canvas");
    this.detailMap.backdropBounds = null;
    const detailContext = this.detailMap.backdrop.getContext("2d", { willReadFrequently: true });
    detailContext.fillText = () => {};
    detailContext.strokeText = () => {};
    this.detailSize = 256;
    this.detailScale = Math.min(14, this.renderer.capabilities.maxTextureSize / this.detailSize);
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
    if (this.elevation) {
      this.terrainDetailTexture = { value: detailTexture };
      this.terrainDetailBounds = new THREE.Vector4(0, 0, this.detailSize, this.detailSize);
      this.terrainDetailEnabled = { value: 0 };
      ground.material.onBeforeCompile = shader => {
        shader.uniforms.terrainDetail = this.terrainDetailTexture;
        shader.uniforms.terrainDetailBounds = { value: this.terrainDetailBounds };
        shader.uniforms.terrainDetailEnabled = this.terrainDetailEnabled;
        shader.vertexShader = `varying vec2 vTerrainPoint;\n${shader.vertexShader}`
          .replace("#include <begin_vertex>", `#include <begin_vertex>
            vTerrainPoint = (modelMatrix * vec4(transformed, 1.0)).xz;`);
        shader.fragmentShader = `uniform sampler2D terrainDetail;
          uniform vec4 terrainDetailBounds;
          uniform float terrainDetailEnabled;
          varying vec2 vTerrainPoint;\n${shader.fragmentShader}`
          .replace("#include <map_fragment>", `#include <map_fragment>
            vec2 detailUV = (vTerrainPoint - terrainDetailBounds.xy) / terrainDetailBounds.zw;
            vec2 border = min(detailUV, 1.0 - detailUV) * terrainDetailBounds.zw;
            float detailWeight = smoothstep(0.0, 16.0, min(border.x, border.y)) * terrainDetailEnabled;
            vec4 detailColor = texture2D(terrainDetail, vec2(detailUV.x, 1.0 - detailUV.y));
            diffuseColor.rgb = mix(diffuseColor.rgb, diffuse * detailColor.rgb, detailWeight);`);
      };
      ground.material.customProgramCacheKey = () => "terrain-detail-1";
    }
  }
  updateGroundDetail(car) {
    this.groundDetail.visible = !this.overview && !this.elevation;
    if (this.elevation) {
      this.terrainDetailEnabled.value = !this.overview && this.detailMap.backdropBounds ? 1 : 0;
    }
    if (this.overview) return;
    if (this.detailUpload) {
      this.uploadGroundDetail();
      return;
    }
    if (this.readyDetail) {
      if (this.stream && this.readyDetail.revision !== this.stream.revision) {
        this.readyDetail = null;
        this.detailPending = false;
      }
    }
    if (this.readyDetail) {
      const { x, y, buffers, image, mipmaps, revision } = this.readyDetail;
      this.readyDetail = null;
      if (this.elevation && image) {
        this.detailUpload = { x, y, levels: [image, ...mipmaps], level: 0, row: 0, revision };
        this.uploadGroundDetail();
        return;
      }
      for (const [index, attributes] of buffers.entries()) {
        const mesh = [this.directionLines][index];
        const geometry = new THREE.BufferGeometry();
        for (const [name, array] of Object.entries(attributes)) {
          geometry.setAttribute(name, new THREE.BufferAttribute(array, 3));
        }
        mesh.geometry.dispose();
        mesh.geometry = geometry;
      }
      this.refreshGroundDetail(x, y, image);
      this.detailVisualRevision = revision;
    }
    const x = Math.round(car.x / 64) * 64, y = Math.round(car.y / 64) * 64;
    if (this.groundDetail.position.x === x && this.groundDetail.position.z === y
        && this.detailMap.backdropBounds && (!this.stream || this.detailVisualRevision === this.stream.revision)) return;
    if (this.detailWorker && this.detailMap.backdropBounds) {
      if (!this.detailPending) {
        this.detailPending = true;
        this.detailWorker.postMessage({ type: "update", x, y });
      }
      return;
    }
    this.refreshGroundDetail(x, y);
    this.detailVisualRevision = this.stream?.revision ?? 0;
    if (this.directionLines && !this.elevation) this.updateDirections(x, y);
  }
  buildRoadSurfaces() {
    this.structures = [];
    const task = this.roadSurfaceGeometry();
    while (!task.next().done) {}
  }
  *roadSurfaceGeometry() {
    const tiles = new Map(), nodeRadii = new Map(), elevatedNodes = new Set(), nodeSurfaces = new Map();
    const triangle = (array, a, b, c) => array.push(...a, ...b, ...c);
    const quad = (array, a, b, c, d) => { triangle(array, a, b, c); triangle(array, a, c, d); };
    const roadKey = edge => {
      const a = this.nodes[edge.a], b = this.nodes[edge.b];
      return `${Math.floor((a[0] + b[0]) / 400)}:${Math.floor((a[1] + b[1]) / 400)}`;
    };
    const groups = new Map();
    for (const edge of this.groundMap.unique) {
      const key = roadKey(edge);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(edge);
    }
    const distance = key => {
      const [x, y] = key.split(":").map(Number);
      return Math.hypot((x + .5) * 200 - this.camera.x, (y + .5) * 200 - this.camera.y);
    };
    const roads = this.stream ? [...groups].sort((a, b) => distance(a[0]) - distance(b[0]))
      .flatMap(([, edges]) => edges) : this.groundMap.unique;
    const remaining = new Map([...groups].map(([key, edges]) => [key, edges.length]));
    for (const edge of roads) {
      const a = this.nodes[edge.a], b = this.nodes[edge.b];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const r = roadWidth(this.data.driving, edge) / 2;
      const nx = -(b[1] - a[1]) / length, ny = (b[0] - a[0]) / length;
      const point = (p, side) => {
        const x = p[0] + nx * r * side, y = p[1] + ny * r * side;
        return [x, surfacePose(this, edge, { x, y }, 0).height + .08, y];
      };
      const key = roadKey(edge);
      if (!tiles.has(key)) tiles.set(key, { deck: [], shell: [], elevatedDeck: [], markings: [] });
      const tile = tiles.get(key);
      const bridge = isElevatedRoad(edge), tunnel = isTunnelRoad(edge);
      const lower = p => [p[0], p[1] - WORLD_SCALE.bridgeDeckThickness, p[2]];
      const upper = p => [p[0], p[1] + WORLD_SCALE.tunnelClearance, p[2]];
      for (const [start, end] of surfaceSegments(this, edge)) {
        const al = point(start, -1), ar = point(start, 1),
          bl = point(end, -1), br = point(end, 1);
        const strips = this.elevation.road_junctions?.[edge.id] ? Math.ceil(r * 2) : 1;
        for (let i = 0; i < strips; i++) {
          const left = -1 + 2 * i / strips, right = -1 + 2 * (i + 1) / strips;
          quad(bridge ? tile.elevatedDeck : tile.deck,
            point(start, left), point(start, right), point(end, right), point(end, left));
        }
        if (bridge && !(this.elevation.node_quality?.[edge.a] && this.elevation.node_quality?.[edge.b])) {
          quad(tile.shell, lower(al), lower(bl), lower(br), lower(ar));
          quad(tile.shell, al, bl, lower(bl), lower(al));
          quad(tile.shell, ar, br, lower(br), lower(ar));
        }
        if (tunnel) {
          quad(tile.shell, al, bl, upper(bl), upper(al));
          quad(tile.shell, ar, br, upper(br), upper(ar));
          quad(tile.shell, upper(al), upper(ar), upper(br), upper(bl));
        }
      }
      for (const node of [edge.a, edge.b]) {
        nodeRadii.set(node, Math.max(nodeRadii.get(node) ?? 0, r));
        const [x, y] = this.nodes[node], z = surfacePose(this, edge, { x, y }, 0).height + .08;
        const owners = this.elevation.road_junctions?.[edge.id];
        if (!nodeSurfaces.has(node) || owners?.some(owner => owner.node === node)) nodeSurfaces.set(node, edge);
        if (!bridge) continue;
        elevatedNodes.add(node);
        const rim = angle => {
          const dx = r * Math.cos(angle), dy = r * Math.sin(angle);
          return [x + dx, surfacePose(this, edge, { x: x + dx, y: y + dy }, 0).height + .08, y + dy];
        };
        for (let i = 0; i < 16; i++) triangle(tile.elevatedDeck, [x, z, y],
          rim(i * Math.PI / 8), rim((i + 1) * Math.PI / 8));
      }
      const stripe = (start, end, buffer) => {
        const q = (p, side) => {
          const x = p[0] + nx * side * WORLD_SCALE.markingWidth / 2,
            y = p[1] + ny * side * WORLD_SCALE.markingWidth / 2;
          return [x, surfacePose(this, edge, { x, y }, 0).height + .12, y];
        };
        const at = distance => {
          const t = distance / length;
          return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        };
        const p = at(start), qPoint = at(end);
        for (const [a, b] of surfaceSegments(this, edge, p, qPoint)) {
          quad(buffer, q(a, -1), q(a, 1), q(b, 1), q(b, -1));
        }
      };
      if (r * 2 >= 5.5) {
        for (let distance = 0; distance < length; distance += WORLD_SCALE.dashLength + WORLD_SCALE.dashGap)
          stripe(distance, Math.min(length, distance + WORLD_SCALE.dashLength), tile.markings);
      }
      if (length > 12) {
        const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
        const arrow = (direction, side) => {
          const x = (a[0] + b[0]) / 2 + nx * side, y = (a[1] + b[1]) / 2 + ny * side;
          const front = WORLD_SCALE.arrowLength * .6, back = WORLD_SCALE.arrowLength * .4,
            halfWidth = Math.min(WORLD_SCALE.arrowWidth / 2, r * .2);
          const points = [[x + Math.cos(angle) * direction * front, y + Math.sin(angle) * direction * front],
            [x - Math.cos(angle) * direction * back + nx * halfWidth, y - Math.sin(angle) * direction * back + ny * halfWidth],
            [x - Math.cos(angle) * direction * back - nx * halfWidth, y - Math.sin(angle) * direction * back - ny * halfWidth]];
          triangle(tile.markings, ...points.map(([px, py]) =>
            [px, surfacePose(this, edge, { x: px, y: py }, 0).height + .13, py]));
        };
        arrow(1, edge.oneway ? 0 : -r * .5);
        if (!edge.oneway) arrow(-1, r * .5);
      }
      remaining.set(key, remaining.get(key) - 1);
      if (this.stream && remaining.get(key) === 0) {
        this.addRoadTile(tile);
        tiles.delete(key);
      }
      yield;
    }
    for (const tile of tiles.values()) {
      this.addRoadTile(tile);
      yield;
    }
    const pilot = this.elevation.pilot;
    if (pilot.triangles?.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(
        pilot.triangles.flatMap(triangle => triangle.flatMap(([x, y, z]) =>
          [x, z + pilot.estimated_vertical_offset_m, y])), 3));
      geometry.computeVertexNormals(); geometry.computeBoundingSphere();
      const material = new THREE.MeshStandardMaterial({ color: "#8b9693", roughness: 1, side: THREE.DoubleSide });
      const faded = material.clone();
      faded.transparent = true; faded.opacity = .12; faded.depthWrite = false;
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = "official-LandsD-pilot-bridge-estimated-datum-alignment";
      this.scene.add(mesh);
      this.resources.push(material, faded);
      this.structures.push({ mesh, material, faded });
    }
    for (const node of elevatedNodes) nodeRadii.delete(node);
    const material = new THREE.MeshBasicMaterial({ color: "#46545a", side: THREE.DoubleSide });
    const jointTiles = new Map();
    for (const [node, radius] of nodeRadii) {
      const [x, y] = this.nodes[node];
      const key = `${Math.floor(x / 200)}:${Math.floor(y / 200)}`;
      if (!jointTiles.has(key)) jointTiles.set(key, []);
      const edge = nodeSurfaces.get(node), positions = jointTiles.get(key);
      const centre = [x, surfacePose(this, edge, { x, y }, 0).height + .08, y];
      const rim = angle => {
        const px = x + radius * Math.cos(angle), py = y + radius * Math.sin(angle);
        return [px, surfacePose(this, edge, { x: px, y: py }, 0).height + .08, py];
      };
      for (let i = 0; i < 32; i++) triangle(positions, centre, rim(i * Math.PI / 16), rim((i + 1) * Math.PI / 16));
      yield;
    }
    for (const positions of jointTiles.values()) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geometry.computeVertexNormals(); geometry.computeBoundingSphere();
      const joints = new THREE.Mesh(geometry, material);
      joints.name = "continuous-shared-node-road-joints";
      this.scene.add(joints);
      yield;
    }
  }
  addRoadTile(tile) {
    for (const [kind, positions] of Object.entries(tile)) {
      if (!positions.length) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geometry.computeVertexNormals(); geometry.computeBoundingSphere();
      const material = new THREE.MeshBasicMaterial({ color: { deck: "#46545a", shell: "#788483",
        elevatedDeck: "#46545a", markings: "#c2d0bf" }[kind], side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = kind === "deck" || kind === "elevatedDeck"
        ? "level-separated-solid-road-decks" : "bridge-and-tunnel-shells";
      this.scene.add(mesh);
      if (kind === "shell" || kind === "elevatedDeck") {
        const faded = material.clone();
        faded.transparent = true; faded.opacity = .12; faded.depthWrite = false;
        this.resources.push(material, faded);
        this.structures.push({ mesh, material, faded });
      }
    }
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
    if (this.elevation) {
      if (!this.detailSpareTexture) {
        // Allocate both mip chains at startup, never while replacing a driving texture.
        const texture = this.groundDetail.material.map;
        this.renderer.initTexture(texture);
        this.detailSpareTexture = texture.clone();
        this.detailSpareTexture.source = new THREE.Source(image);
        this.detailSpareTexture.needsUpdate = true;
        this.renderer.initTexture(this.detailSpareTexture);
        this.detailSpareTexture.generateMipmaps = false;
        this.detailUploadSource = new THREE.DataTexture();
        this.resources.push(this.detailSpareTexture, this.detailUploadSource);
      }
      this.terrainDetailBounds.set(bounds[0], bounds[1], this.detailSize, this.detailSize);
      this.terrainDetailEnabled.value = this.overview ? 0 : 1;
    }
  }
  uploadGroundDetail() {
    const upload = this.detailUpload;
    const image = upload.levels[upload.level];
    const rows = Math.min(image.height - upload.row, Math.max(1, Math.floor(2 * 1024 * 1024 / (image.width * 4))));
    const start = upload.row * image.width * 4;
    this.detailUploadSource.image = {
      width: image.width, height: rows,
      data: image.data.subarray(start, start + rows * image.width * 4),
    };
    // Each canvas strip is flipped on upload, so its destination rows count from the bottom.
    this.renderer.copyTextureToTexture(this.detailUploadSource, this.detailSpareTexture, null,
      new THREE.Vector2(0, image.height - upload.row - rows), 0, upload.level);
    upload.row += rows;
    if (upload.row < image.height) return;
    upload.row = 0;
    if (++upload.level < upload.levels.length) return;
    const previous = this.groundDetail.material.map;
    this.groundDetail.material.map = this.detailSpareTexture;
    this.terrainDetailTexture.value = this.detailSpareTexture;
    this.detailSpareTexture.image = upload.levels[0];
    this.detailSpareTexture = previous;
    this.detailSpareTexture.generateMipmaps = false;
    this.detailMap.backdropBounds = [upload.x - this.detailSize / 2, upload.y - this.detailSize / 2,
      upload.x + this.detailSize / 2, upload.y + this.detailSize / 2];
    this.detailMap.backdropScale = this.detailScale;
    this.groundDetail.position.set(upload.x, .02, upload.y);
    this.terrainDetailBounds.set(this.detailMap.backdropBounds[0], this.detailMap.backdropBounds[1],
      this.detailSize, this.detailSize);
    this.detailVisualRevision = upload.revision;
    this.detailUpload = null;
  }
  buildBoundaries() {
    this.boundaryOutline = new THREE.Mesh(new THREE.BufferGeometry(), this.smoothLineMaterial("#f15e5e", 0.8));
    this.boundaryOutline.name = "nearby-collision-boundaries";
    this.boundaryOutline.renderOrder = 3;
    this.boundaryScene.add(this.boundaryOutline);
    this.directionLines = new THREE.Mesh(new THREE.BufferGeometry(), this.smoothLineMaterial("#c2d0bf", 1));
    this.directionLines.name = "road-direction-arrows";
    this.directionLines.renderOrder = 6;
    this.boundaryScene.add(this.directionLines);
    this.updateBoundaries();
  }
  updateDirections(x, y) {
    const segments = [], half = this.detailSize / 2;
    for (const arrow of this.groundMap.directionArrows()) {
      if (Math.abs(arrow.x - x) > half - 4 || Math.abs(arrow.y - y) > half - 4) continue;
      const point = (a, b) => [arrow.x + Math.cos(arrow.angle) * a - Math.sin(arrow.angle) * b,
        arrow.y + Math.sin(arrow.angle) * a + Math.cos(arrow.angle) * b];
      const tip = WORLD_SCALE.arrowLength / 2, halfWidth = WORLD_SCALE.arrowWidth / 2;
      segments.push([point(-tip, 0), point(tip, 0)], [point(0, -halfWidth), point(tip, 0)],
        [point(tip, 0), point(0, halfWidth)]);
    }
    const geometry = this.roundLineGeometry(segments, WORLD_SCALE.markingWidth, 0.06);
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
  updateBoundaries() {
    const lines = this.groundMap.collisionLines.all();
    if (lines === this.boundaryLines) return;
    this.boundaryLines = lines;
    const positions = [], coverage = [];
    for (const { a, b, edge } of lines) {
      const heights = new Map();
      const vertex = (point, coord) => {
        const x = Math.fround(point[0]), y = Math.fround(point[1]);
        const key = `${x},${y}`;
        let height = heights.get(key);
        if (height === undefined) {
          height = surfacePose(this, edge, { x, y }, 0).height;
          heights.set(key, height);
        }
        positions.push(x, height + .14, y);
        coverage.push(...coord);
      };
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const nx = -(b[1] - a[1]) / length * COLLISION_LINE_WIDTH / 2,
        ny = (b[0] - a[0]) / length * COLLISION_LINE_WIDTH / 2;
      const vertices = [[a[0] + nx, a[1] + ny], [a[0] - nx, a[1] - ny],
        [b[0] - nx, b[1] - ny], [b[0] + nx, b[1] + ny]];
      for (const [triangle, indices] of [[0, [0, 1, 2]], [1, [0, 2, 3]]]) {
        for (const index of indices) {
          vertex(vertices[index], [triangle === 0 ? Number(index === 0) : Number(index === 2), 1, 1]);
        }
      }
      const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
      for (const [centre, start] of [[b, angle - Math.PI / 2], [a, angle + Math.PI / 2]]) {
        for (let i = 0; i < 8; i++) {
          const rim = step => [
            centre[0] + Math.cos(start + step * Math.PI / 8) * COLLISION_LINE_WIDTH / 2,
            centre[1] + Math.sin(start + step * Math.PI / 8) * COLLISION_LINE_WIDTH / 2,
          ];
          // Only the curved rim fades; fan spokes and the join stay solid.
          vertex(centre, [1, 1, 1]);
          vertex(rim(i), [0, 1, 1]);
          vertex(rim(i + 1), [0, 1, 1]);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("boundaryCoord", new THREE.Float32BufferAttribute(coverage, 3));
    for (const tile of [...this.boundaryOutline.children]) {
      tile.geometry.dispose();
      this.boundaryOutline.remove(tile);
    }
    this.boundaryOutline.geometry.dispose();
    this.boundaryOutline.geometry = geometry;
    if (this.elevation) {
      const tiles = new Map();
      for (const [index, { a, b }] of lines.entries()) {
        const key = `${Math.floor((a[0] + b[0]) / 160)}:${Math.floor((a[1] + b[1]) / 160)}`;
        if (!tiles.has(key)) tiles.set(key, []);
        const indices = tiles.get(key);
        for (let vertex = index * 54; vertex < (index + 1) * 54; vertex++) indices.push(vertex);
      }
      const point = new THREE.Vector3();
      for (const indices of tiles.values()) {
        const tileGeometry = new THREE.BufferGeometry();
        for (const [name, attribute] of Object.entries(geometry.attributes)) tileGeometry.setAttribute(name, attribute);
        tileGeometry.setIndex(indices);
        const bounds = new THREE.Box3();
        for (const index of indices) bounds.expandByPoint(point.fromBufferAttribute(geometry.getAttribute("position"), index));
        tileGeometry.boundingBox = bounds;
        tileGeometry.boundingSphere = bounds.getBoundingSphere(new THREE.Sphere());
        const tile = new THREE.Mesh(tileGeometry, this.boundaryOutline.material);
        tile.renderOrder = this.boundaryOutline.renderOrder;
        this.boundaryOutline.add(tile);
      }
      // Share the static vertex data; only nearby tile indices are submitted.
      geometry.setDrawRange(0, 0);
    }
  }
  lineGeometry(outlines, solidJoins = []) {
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
      if (solidJoins.some(([from, to]) =>
        project({ x: positions.getX(a), y: -positions.getY(a) }, from, to).distance < .0002
        && project({ x: positions.getX(b), y: -positions.getY(b) }, from, to).distance < .0002)) return false;
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
    this.buildingCount = 0;
    this.buildings = [];
    if (this.stream) {
      this.cityGroups = new Map();
      this.cityQueue = [];
      return;
    }
    const task = this.cityGeometry(this.data.backdrop);
    let next = task.next();
    while (!next.done) next = task.next();
    this.buildings = next.value;
    this.buildingCount = this.data.backdrop.filter(shape => shape.kind === "building" && shape.points.length >= 3).length;
  }
  *cityGeometry(footprints) {
    const tiles = new Map();
    const buildingMetadata = new Map((this.elevation?.buildings || []).map(b => [b.index, b]));
    for (const [index, footprint] of footprints.entries()) {
      if (footprint.kind !== "building" || footprint.points.length < 3) continue;
      const points = footprint.points;
      const cx = points.reduce((sum, p) => sum + p[0], 0) / points.length;
      const cy = points.reduce((sum, p) => sum + p[1], 0) / points.length;
      const key = `${Math.floor(cx / 60)}:${Math.floor(cy / 60)}`;
      if (!tiles.has(key)) tiles.set(key, { positions: [], normals: [], colors: [], uvs: [] });
      const tile = tiles.get(key);
      const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, -y)));
      const seed = Math.abs(Math.round(cx * 13 + cy * 7));
      const metadata = footprint.building ?? buildingMetadata.get(footprint.id ?? index);
      const height = metadata?.height ?? WORLD_SCALE.fallbackBuildingHeight;
      const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, steps: 1 });
      geometry.rotateX(-Math.PI / 2);
      const position = geometry.getAttribute("position"), normal = geometry.getAttribute("normal");
      const color = new THREE.Color().setHSL(0.48 + seed % 8 / 100, 0.13, 0.48 + seed % 6 / 100);
      for (let i = 0; i < position.count; i++) {
        tile.positions.push(position.getX(i), position.getY(i) + (metadata?.base ?? 0) + 0.05, position.getZ(i));
        tile.normals.push(normal.getX(i), normal.getY(i), normal.getZ(i));
        const shade = normal.getY(i) > 0.5 ? 0.7
          : 0.7 + 0.3 * Math.max(0, -normal.getX(i) * 0.5 - normal.getZ(i) * 0.8);
        tile.colors.push(color.r * shade, color.g * shade, color.b * shade);
        tile.uvs.push(normal.getY(i) > 0.5 ? 0.03
          : (Math.abs(normal.getX(i)) > 0.5 ? position.getZ(i) : position.getX(i)) / WORLD_SCALE.facadeBayWidth,
        normal.getY(i) > 0.5 ? 0.03 : position.getY(i) / WORLD_SCALE.floorHeight);
      }
      geometry.dispose();
      yield;
    }
    const meshes = [];
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
      meshes.push(mesh);
    }
    return meshes;
  }
  updateStreamedCity() {
    if (!this.stream) return;
    const revision = `${this.stream.revision}:${Math.floor(this.camera.x / 128)}:${Math.floor(this.camera.y / 128)}`;
    if (this.cityRevision !== revision) {
      this.cityRevision = revision;
      const groups = new Map();
      for (const shape of this.data.backdrop) {
        if (shape.kind !== "building" || shape.points.length < 3) continue;
        const cx = shape.points.reduce((sum, p) => sum + p[0], 0) / shape.points.length;
        const cy = shape.points.reduce((sum, p) => sum + p[1], 0) / shape.points.length;
        const radius = Math.max(...shape.points.map(([x, y]) => Math.hypot(x - cx, y - cy)));
        if (Math.hypot(cx - this.camera.x, cy - this.camera.y) > 512 + radius) continue;
        const key = `${Math.floor(cx / 60)}:${Math.floor(cy / 60)}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(shape);
      }
      this.cityTask = null;
      this.cityQueue = [];
      for (const [key, group] of this.cityGroups) {
        const signature = groups.get(key)?.map(shape => shape.id).join(",");
        if (signature !== group.signature) {
          for (const mesh of group.meshes) { this.scene.remove(mesh); mesh.geometry.dispose(); }
          this.cityGroups.delete(key);
        }
      }
      for (const [key, shapes] of groups) {
        if (!this.cityGroups.has(key)) this.cityQueue.push({ key, shapes });
      }
      this.cityQueue.sort((a, b) => {
        const distance = group => {
          const [x, y] = group.key.split(":").map(Number);
          return Math.hypot((x + .5) * 60 - this.camera.x, (y + .5) * 60 - this.camera.y);
        };
        return distance(a) - distance(b);
      });
      this.buildings = [...this.cityGroups.values()].flatMap(group => group.meshes);
    }
    const deadline = performance.now() + 4;
    let steps = 0;
    while (performance.now() < deadline && steps++ < 8) {
      if (!this.cityTask) {
        const group = this.cityQueue.shift();
        if (!group) break;
        this.cityTask = { ...group, generator: this.cityGeometry(group.shapes) };
      }
      const next = this.cityTask.generator.next();
      if (next.done) {
        const group = this.cityTask;
        this.cityGroups.set(group.key, { signature: group.shapes.map(shape => shape.id).join(","),
          meshes: next.value, count: group.shapes.length });
        this.buildings.push(...next.value);
        this.cityTask = null;
      }
    }
    this.buildingCount = [...this.cityGroups.values()].reduce((sum, group) => sum + group.count, 0);
  }
  buildTaxi() {
    this.taxi = new THREE.Group();
    this.taxi.name = "taxi";
    const length = this.data.driving.taxi_length ?? 4.7, width = this.data.driving.taxi_width ?? 1.7;
    const box = (x, y, z, position, color) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(x, y, z),
        new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.15 }));
      mesh.position.set(...position);
      this.taxi.add(mesh);
      return mesh;
    };
    const body = box(length, .65, width, [0, .625, 0], "#bb343a");
    body.name = "taxi-body";
    box(length * 0.52, .55, width * .86, [-length * .06, 1.175, 0], "#c8d6ca");
    box(length * 0.53, .36, width * .88, [-length * .06, 1.18, 0], "#193b4a");
    box(length * .5, .08, width * .87, [-length * .06, WORLD_SCALE.taxiHeight - .04, 0], "#dbe6dd");
    const sign = box(.4, WORLD_SCALE.taxiSignHeight, .25,
      [0, WORLD_SCALE.taxiHeight + WORLD_SCALE.taxiSignHeight / 2, 0], "#fff3c0");
    sign.name = "taxi-sign";
    for (const side of [-1, 1]) {
      for (const axle of [-0.32, 0.32]) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(WORLD_SCALE.wheelRadius, WORLD_SCALE.wheelRadius, WORLD_SCALE.wheelWidth, 12),
          new THREE.MeshStandardMaterial({ color: "#10191b", roughness: 1 }));
        wheel.rotation.x = Math.PI / 2;
        wheel.position.set(length * axle, WORLD_SCALE.wheelRadius, side * (width / 2 - WORLD_SCALE.wheelWidth / 2));
        wheel.name = "taxi-wheel";
        this.taxi.add(wheel);
      }
      const light = box(0.06, 0.12, width * 0.2, [length / 2 - 0.03, 0.72, side * width * 0.3], "#fff1bd");
      light.material.emissive.set("#ffe0a0"); light.material.emissiveIntensity = 1.5;
      const tail = box(0.06, 0.12, width * 0.2, [-length / 2 + 0.03, 0.72, side * width * 0.3], "#e93736");
      tail.material.emissive.set("#e93736");
    }
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(length * 1.15, width * 1.2),
      new THREE.MeshBasicMaterial({ color: "#050c10", transparent: true, opacity: 0.55, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.08;
    this.taxi.add(shadow);
    this.scene.add(this.taxi);
  }
  buildMarkers() {
    const depot = this.stops.find(stop => stop.id === "depot");
    const templates = depot ? [depot, depot] : this.stops.slice(0, 1);
    this.markers = templates.map((stop, index) => {
      const color = stop.id === "depot" ? "#85bada" : "#92d7b6";
      const marker = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.TorusGeometry(3, 0.3, 8, 32),
        new THREE.MeshBasicMaterial({ color }));
      ring.rotation.x = Math.PI / 2; ring.position.y = 0.4; ring.renderOrder = 20;
      const beacon = new THREE.Mesh(new THREE.ConeGeometry(1.2, 2.2, 6),
        new THREE.MeshBasicMaterial({ color }));
      beacon.rotation.z = Math.PI; beacon.position.y = 5; beacon.renderOrder = 20;
      marker.add(ring, beacon);
      const edge = this.edges.get(stop.edge);
      const pose = edge ? surfacePose(this, edge, { x: stop.point[0], y: stop.point[1] }, 0) : { height: 0 };
      marker.position.set(stop.point[0], pose.height + (this.elevation ? .1 : 0), stop.point[1]);
      if (edge && this.elevation) {
        const a = this.nodes[edge.a], b = this.nodes[edge.b];
        const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
        const grade = surfacePose(this, edge, { x: stop.point[0], y: stop.point[1] }, angle).grade;
        ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1),
          new THREE.Vector3(-grade * Math.cos(angle), 1, -grade * Math.sin(angle)).normalize());
      }
      marker.name = `stop-${stop.id}`;
      this.scene.add(marker);
      return { stop, marker, ring, beacon, dynamic: !depot || index === 1, positionKey: null };
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
  buildCitizens() {
    this.people = [];
    this.bubbleScene = new THREE.Scene();
    this.bubbleScene.fog = this.scene.fog;
    this.hailBubbles = Object.fromEntries(Object.entries({ en, zh }).map(([lang, messages]) => {
      const canvas = document.createElement("canvas");
      canvas.width = HAIL_BUBBLE.canvasWidth * 2; canvas.height = HAIL_BUBBLE.canvasHeight * 2;
      const context = canvas.getContext("2d");
      context.scale(2, 2);
      drawHailBubble(context, messages.hailTaxi);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      const material = new THREE.SpriteMaterial({ map: texture, depthWrite: false, depthTest: false });
      this.resources.push(texture, material);
      return [lang, material];
    }));
    this.personBody = new THREE.CylinderGeometry(0.3, 0.25, 0.8, 6);
    this.personHead = new THREE.SphereGeometry(0.25, 6, 6);
    this.personLimb = new THREE.CylinderGeometry(0.08, 0.08, 0.7, 5);
    this.personMaterial = new THREE.MeshStandardMaterial({ color: "#b1c8da" });
    this.hailMaterial = new THREE.MeshStandardMaterial({ color: "#ffac6e", emissive: "#653010" });
    this.skinMaterial = new THREE.MeshStandardMaterial({ color: "#edc59d" });
    this.resources.push(this.personBody, this.personHead, this.personLimb,
      this.personMaterial, this.hailMaterial, this.skinMaterial);
    this.door = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.8, 0.08),
      new THREE.MeshStandardMaterial({ color: "#f7cc65" }));
    this.door.position.set(-0.4, 0.9, (this.data.driving.taxi_width ?? 2.6) / 2 + 0.45);
    this.door.rotation.y = Math.PI / 3;
    this.door.visible = false;
    this.taxi.add(this.door);
  }
  updateCitizens(state, car, lang = "en") {
    const people = peopleOnMap(state, car);
    this.door.visible = Boolean(state.boarding);
    if (state.boarding) {
      const side = doorSide(state, car);
      this.door.position.z = side * ((this.data.driving.taxi_width ?? 2.6) / 2 + 0.45);
      this.door.rotation.y = side * Math.PI / 3;
    }
    while (this.people.length < people.length) {
      const group = new THREE.Group();
      const body = new THREE.Mesh(this.personBody, this.personMaterial);
      body.position.y = 1;
      const head = new THREE.Mesh(this.personHead, this.skinMaterial);
      head.position.y = 1.65;
      const arm = new THREE.Mesh(this.personLimb, this.personMaterial);
      const otherArm = new THREE.Mesh(this.personLimb, this.personMaterial);
      otherArm.position.set(0, 1, -0.45); otherArm.rotation.x = -0.3;
      group.add(body, head, arm, otherArm);
      const bubble = new THREE.Sprite(this.hailBubbles[lang]);
      bubble.center.set((HAIL_BUBBLE.x + HAIL_BUBBLE.width / 2) / HAIL_BUBBLE.canvasWidth,
        1 - (HAIL_BUBBLE.y + HAIL_BUBBLE.height + HAIL_BUBBLE.tailHeight) / HAIL_BUBBLE.canvasHeight);
      bubble.scale.set(6, 3, 1); //width, height, depth
      this.bubbleScene.add(bubble);
      const legs = [-0.16, 0.16].map(z => {
        const leg = new THREE.Mesh(this.personLimb, this.personMaterial);
        leg.position.set(0, 0.35, z); group.add(leg); return leg;
      });
      this.scene.add(group);
      this.people.push({ group, body, arm, otherArm, legs, bubble });
    }
    this.people.forEach((item, index) => {
      const person = people[index];
      item.group.visible = Boolean(person);
      item.bubble.visible = Boolean(person?.hailing && person.id !== "customer" && !person.boarding && !this.overview);
      if (!person) return;
      item.bubble.material = this.hailBubbles[lang];
      let height = 0;
      if (this.elevation) {
        const edgeId = person.boarding ? car.edge
          : person.id === "customer" ? this.stops.find(stop => stop.id === state.pickup).edge
          : person.edge;
        height = surfacePose(this, this.edges.get(edgeId),
          { x: person.point[0], y: person.point[1] }, 0).height + .1;
      }
      item.group.position.set(person.point[0], height, person.point[1]);
      item.bubble.position.set(person.point[0], height + 2.3, person.point[1]);
      if (item.id !== person.id) {
        item.id = person.id;
        item.heading = person.heading ?? 0;
        item.lastElapsed = state.elapsed;
      }
      const delta = Math.max(0, Math.min(.1, state.elapsed - item.lastElapsed));
      item.lastElapsed = state.elapsed;
      const heading = person.heading ?? item.heading;
      item.heading += Math.atan2(Math.sin(heading - item.heading), Math.cos(heading - item.heading))
        * (1 - Math.exp(-10 * delta));
      item.group.rotation.y = -item.heading;
      item.group.scale.setScalar(person.scale ?? 1);
      item.body.material = person.hailing ? this.hailMaterial : this.personMaterial;
      item.arm.position.set(0, person.hailing ? 1.7 : 1, 0.5);
      const walking = person.walking ?? !person.hailing;
      const swing = walking ? Math.sin(state.elapsed * (person.walkSpeed ?? 1.1) * 7 + index) * .45 : 0;
      item.arm.rotation.x = person.hailing ? -.7 + Math.sin(state.elapsed * 5 + index) * .25 : 0;
      item.arm.rotation.z = person.hailing ? 0 : -swing;
      item.otherArm.rotation.z = swing;
      item.legs.forEach((leg, side) => {
        leg.rotation.z = side ? swing : -swing;
      });
    });
  }
  visibleCitizens(state, car) {
    if (this.overview || state.boarding || ["onboard", "boarding"].includes(state.phase)) return [];
    this.lens.updateMatrixWorld();
    const point = new THREE.Vector3();
    const result = [];
    for (const person of peopleOnMap(state, car)) {
      if (!person.motion || person.hailing || person.motion.seeking_curb
          || Math.hypot(person.point[0] - car.x, person.point[1] - car.y)
            > (state.citizen_hailing_distance ?? 80)) continue;
      const height = surfacePose(this, this.edges.get(person.edge),
        { x: person.point[0], y: person.point[1] }, 0).height;
      point.set(person.point[0], height + 1, person.point[1]).project(this.lens);
      if (Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1 && point.z >= -1 && point.z <= 1)
        result.push(person.id);
    }
    return result;
  }
  ribbon(edges, color, width, height, start = null) {
    const geometry = this.ribbonGeometry(edges, width, height, start);
    const mesh = new THREE.Mesh(geometry, this.smoothLineMaterial(color));
    mesh.renderOrder = Math.round(height * 100);
    this.overlays.add(mesh);
    return mesh;
  }
  ribbonGeometry(edges, width, height, start = null) {
    if (this.elevation) {
      this.ribbonEdgeCache ??= new Map();
      const chunks = [];
      const edgeStarts = [];
      let vertices = 0;
      for (const [index, edge] of edges.entries()) {
        edgeStarts.push(vertices);
        if (!edge) continue;
        const a = index === 0 && start ? [start.x, start.y] : this.nodes[edge.a], b = this.nodes[edge.b];
        const joins = (previous, next) => previous && next && previous.b === next.a
          && previous.way === next.way
          && ["layer", "bridge", "tunnel", "width"].every(tag => previous[tag] === next[tag])
          && straightJoin([this.nodes[previous.a], this.nodes[previous.b]], this.nodes[next.b]);
        const startCap = !joins(edges[index - 1], edge), endCap = !joins(edge, edges[index + 1]);
        const key = JSON.stringify([edge.id, width, height, startCap, endCap]);
        const partial = index === 0 && start;
        let cached = partial ? null : this.ribbonEdgeCache.get(key);
        if (!cached) {
          cached = [];
          const segments = surfaceSegments(this, edge, a, b);
          for (const [i, segment] of segments.entries()) {
            const geometry = this.roundLineGeometry([segment], width, height, {
              startCap: i === 0 ? startCap : !straightJoin(segments[i - 1], segment[1]),
              endCap: i === segments.length - 1 ? endCap : !straightJoin(segment, segments[i + 1][1]),
            });
            const positions = geometry.getAttribute("position");
            for (let i = 0; i < positions.count; i++) {
              const x = positions.getX(i), y = positions.getZ(i);
              positions.setY(i, surfacePose(this, edge, { x, y }, 0).height + height + .08);
            }
            cached.push(Object.fromEntries(["position", "normal", "uv", "boundaryCoord"]
              .map(name => [name, geometry.getAttribute(name).array])));
            geometry.dispose();
          }
          if (!partial) {
            if (this.ribbonEdgeCache.size >= 512) this.ribbonEdgeCache.delete(this.ribbonEdgeCache.keys().next().value);
            this.ribbonEdgeCache.set(key, cached);
          }
        }
        for (const chunk of cached) {
          chunks.push(chunk);
          vertices += chunk.position.length / 3;
        }
      }
      const result = new THREE.BufferGeometry();
      for (const name of ["position", "normal", "uv", "boundaryCoord"]) {
        const size = name === "uv" ? 2 : 3;
        const values = new Float32Array(vertices * size);
        let offset = 0;
        for (const chunk of chunks) {
          values.set(chunk[name], offset);
          offset += chunk[name].length;
        }
        result.setAttribute(name, new THREE.BufferAttribute(values, size));
      }
      result.userData.edgeStarts = edgeStarts;
      return result;
    }
    const segments = [];
    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i];
      if (!edge) continue;
      const a = i === 0 && start ? [start.x, start.y] : this.data.nodes[edge.a], b = this.data.nodes[edge.b];
      segments.push([a, b]);
    }
    return this.roundLineGeometry(segments, width, height);
  }
  roundLineGeometry(segments, width, height, { startCap = true, endCap = true } = {}) {
    const polygons = [], solidJoins = [];
    const merged = mergeStraightSegments(segments.map(([a, b]) => ({ a, b })));
    for (const { a, b } of merged) {
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (!length) continue;
      const angle = Math.atan2(b[1] - a[1], b[0] - a[0]), points = [];
      for (const [centre, theta, capped] of [[b, angle - Math.PI / 2, endCap], [a, angle + Math.PI / 2, startCap]]) {
        const steps = capped ? 16 : 1;
        for (let j = 0; j <= steps; j++) {
          points.push([centre[0] + width / 2 * Math.cos(theta + j * Math.PI / steps),
            centre[1] + width / 2 * Math.sin(theta + j * Math.PI / steps)]);
        }
      }
      if (!endCap) solidJoins.push([points[0], points[1]]);
      if (!startCap) solidJoins.push([points[points.length - 2], points[points.length - 1]]);
      points.push(points[0]);
      polygons.push([points]);
    }
    const geometry = this.lineGeometry(polygons.length > 1 ? polygonClipping.union(...polygons) : polygons, solidJoins);
    geometry.translate(0, height, 0);
    return geometry;
  }
  updateOverlays(state, approach, previewExit) {
    this.overlayLayers ??= new Map();
    const suffixOffset = (original, ids) => {
      const offset = original.length - ids.length;
      return ids.length && offset >= 0 && ids.every((id, index) => id === original[offset + index])
        ? offset : -1;
    };
    const replaceLayer = (name, ids, color, height, geometry = null) => {
      const previous = this.overlayLayers.get(name);
      if (previous) {
        previous.mesh.geometry.dispose();
        previous.mesh.material.dispose();
        this.overlays.remove(previous.mesh);
        this.overlayLayers.delete(name);
      }
      if (!geometry) return;
      const mesh = new THREE.Mesh(geometry, this.smoothLineMaterial(color));
      mesh.renderOrder = Math.round(height * 100);
      this.overlays.add(mesh);
      this.overlayLayers.set(name, { key: JSON.stringify([ids, color]), ids: [...ids], color, mesh });
    };
    if (this.readyRoute) {
      const ready = this.readyRoute, pending = this.pendingRoute;
      this.readyRoute = null;
      if (pending && ready.request === pending.request) {
        // A newer state can arrive between the worker reply and this frame.
        const offset = suffixOffset(pending.ids, state.route ?? []);
        if (offset >= 0 && pending.color === (state.phase === "pickup" ? "#24ca72" : "#f3c047")) {
          const geometry = new THREE.BufferGeometry();
          for (const [name, attribute] of Object.entries(ready.attributes))
            geometry.setAttribute(name, new THREE.BufferAttribute(attribute.array, attribute.itemSize));
          geometry.userData.edgeStarts = ready.edgeStarts;
          const start = ready.edgeStarts[offset];
          geometry.setDrawRange(start, geometry.getAttribute("position").count - start);
          replaceLayer("route", pending.ids, pending.color, pending.height, geometry);
        }
        this.pendingRoute = null;
      }
    }
    const selectedPaths = approach?.exits.filter(({ edge }) =>
      edge.id === previewExit || edge.id === state.selected_exit) ?? [];
    const key = JSON.stringify([state.closed, state.traffic, state.route, state.phase,
      selectedPaths.map(({ path }) => path.edges.map(edge => edge.id))]);
    if (key === this.overlayKey) return;
    this.overlayKey = key;
    const updateLayer = (name, ids, color, width, height) => {
      const key = JSON.stringify([ids, color]);
      const previous = this.overlayLayers.get(name);
      if (name === "route" && this.pendingRoute
          && (this.pendingRoute.color !== color || suffixOffset(this.pendingRoute.ids, ids) < 0)) {
        this.pendingRoute = null;
        this.readyRoute = null;
      }
      if (previous?.key === key) {
        if (name === "route") previous.mesh.geometry.setDrawRange(0, Infinity);
        return;
      }
      if (name === "route" && this.pendingRoute) return;
      if (name === "route" && this.elevation && previous?.color === color && ids.length) {
        const offset = suffixOffset(previous.ids, ids);
        if (offset >= 0) {
          const start = previous.mesh.geometry.userData.edgeStarts[offset];
          previous.mesh.geometry.setDrawRange(start, previous.mesh.geometry.getAttribute("position").count - start);
          return;
        }
      }
      if (name === "route" && this.elevation && this.detailWorker && ids.length) {
        if (this.pendingRoute?.key === key) return;
        if (previous) replaceLayer(name, [], color, height);
        const request = this.routeRequest = (this.routeRequest ?? 0) + 1;
        this.pendingRoute = { request, key, ids: [...ids], color, height };
        this.detailWorker.postMessage({ type: "route", request, ids, width, height });
        return;
      }
      replaceLayer(name, ids, color, height,
        ids.length ? this.ribbonGeometry(ids.map(id => this.edges.get(id)), width, height) : null);
    };
    const closed = new Set(state.closed);
    updateLayer("closed", [...this.edges.values()].filter(e => closed.has(e.way)).map(e => e.id), "#ed8879", 3, 0.12);
    updateLayer("traffic", [...this.edges.values()].filter(e => !closed.has(e.way) && state.traffic[e.way]).map(e => e.id),
      "#bd955c", 1, 0.14);
    updateLayer("selected", selectedPaths.flatMap(({ path }) => path.edges.map(edge => edge.id)), "#55e9ff", 2, 0.3);
    updateLayer("route", state.route ?? [],
      state.phase === "pickup" ? "#24ca72" : "#f3c047", 0.8, state.phase === "pickup" ? 0.25 : 0.22);
  }
  updateCameraHeading(heading, dt) {
    const smoothness = this.cameraSmoothness ?? 0.6;
    const rotationSpeed = this.cameraRotationSpeed ?? 0.9;
    if (!this.cameraReady || this.reducedMotion || smoothness === 0) {
      this.cameraHeading = heading;
      return;
    }
    const difference = Math.atan2(Math.sin(heading - this.cameraHeading), Math.cos(heading - this.cameraHeading));
    const change = difference * (1 - Math.exp(-(3.5 - smoothness * 2.5) * dt));
    const limit = rotationSpeed * dt;
    this.cameraHeading += Math.max(-limit, Math.min(limit, change));
  }
  render(car, state, lang, approach, previewExit = null) {
    // Use the animation-frame time the taxi was stepped with; performance.now() jitters with prior work.
    const now = document.timeline?.currentTime ?? performance.now();
    const dt = this.lastRender ? Math.min((now - this.lastRender) / 1000, 0.1) : 1;
    this.updateCameraHeading(car.heading, dt);
    this.camera.x = car.x; this.camera.y = car.y;
    if (this.roadBuildTask) {
      const deadline = performance.now() + 4;
      let steps = 0;
      while (performance.now() < deadline && steps++ < 24) {
        if (this.roadBuildTask.next().done) { this.roadBuildTask = null; break; }
      }
    }
    this.updateStreamedCity();
    this.ground.material.map = this.overview ? this.overviewTexture : this.chaseTexture;
    this.ground.visible = this.overview || !this.elevation;
    for (const tile of this.terrainTiles) tile.visible = !this.overview;
    this.updateGroundDetail(car);
    this.boundaryOutline.visible = true;
    this.directionLines.visible = !this.overview && !this.elevation;
    const forward = new THREE.Vector3(Math.cos(this.cameraHeading), 0, Math.sin(this.cameraHeading));
    const pose = surfacePose(this, this.edges.get(car.edge), car, car.heading);
    const position = new THREE.Vector3(car.x, pose.height + (this.elevation ? .08 : 0), car.y);
    for (const tile of this.boundaryOutline.children) {
      const sphere = tile.geometry.boundingSphere;
      tile.visible = this.overview || sphere.center.distanceTo(position) < 240 + sphere.radius;
    }
    this.taxi.position.copy(position);
    this.taxi.rotation.set(0, -car.heading, pose.pitch, "YXZ");
    const distance = Math.min(150, 48 * 1.65 / this.zoom) * this.chaseDistanceScale;
    const target = position.clone().addScaledVector(forward, 10);
    target.y = this.elevation ? surfacePose(this, this.edges.get(car.edge),
      { x: target.x, y: target.z }, car.heading).height + 1 : 1;
    const eye = position.clone().addScaledVector(forward, -distance * 0.9);
    eye.y = position.y + distance * 0.6;
    const inTunnel = this.elevation && isTunnelRoad(this.edges.get(car.edge));
    if (inTunnel && !this.overview) { eye.y = position.y + 3.3; target.y = position.y + 1.4; }
    if (this.elevation) {
      this.ground.material.transparent = Boolean(inTunnel && !this.overview);
      this.ground.material.opacity = inTunnel && !this.overview ? .08 : 1;
      this.ground.material.depthWrite = !inTunnel || this.overview;
    }
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
        if (average > 1 / 28 && this.quality > this.minimumQuality) {
          this.quality = Math.max(this.minimumQuality, this.quality * Math.sqrt((1 / 36) / average));
          this.resize();
        }
        this.frameTimes = [];
      }
    }
    this.lastRender = now;
    const positionEase = 1 - Math.exp(-(8 - this.cameraSmoothness * 5) * dt);
    const targetEase = 1 - Math.exp(-(6.5 - this.cameraSmoothness * 4.17) * dt);
    this.lookAt ??= target.clone();
    const smoothCamera = this.cameraReady && !this.reducedMotion && this.cameraSmoothness > 0;
    this.lens.position.lerp(eye, smoothCamera ? positionEase : 1);
    this.lookAt.lerp(target, smoothCamera ? targetEase : 1);
    this.lens.lookAt(this.lookAt);
    this.lens.setViewOffset(innerWidth, innerHeight, 0, innerHeight * 0.04, innerWidth, innerHeight);
    this.cameraReady = true;
    this.camera.x = car.x; this.camera.y = car.y;
    // Fade entire small blocks intersecting the camera sightline, keeping the taxi visible.
    const line = new THREE.Line3(this.lens.position, position.clone().add(new THREE.Vector3(0, 1, 0)));
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
    for (const { mesh, material, faded } of this.structures || []) {
      const sphere = mesh.geometry.boundingSphere;
      line.closestPointToPoint(sphere.center, true, closest);
      mesh.material = !this.overview && closest.distanceTo(sphere.center) < sphere.radius + 4
        && sphere.center.y > position.y + 2
        && sphere.center.distanceTo(position) < distance + sphere.radius ? faded : material;
    }
    if (state) {
      this.updateCitizens(state, car, lang);
      this.updateOverlays(state, approach, previewExit);
      let activeLabel = null;
      for (const item of this.markers) {
        const { marker, ring, beacon } = item;
        const targetId = state.phase === "pickup" ? state.pickup
          : state.phase === "onboard" ? state.destination : null;
        const stop = item.dynamic ? this.stops.find(candidate => candidate.id === targetId) : item.stop;
        const active = item.dynamic && Boolean(stop);
        marker.visible = active || !item.dynamic;
        if (!stop) continue;
        item.stop = stop;
        const point = active ? ((state.phase === "pickup" ? state.pickup_point : state.destination_point) || stop.point) : stop.point;
        const positionKey = `${stop.id}:${point[0]}:${point[1]}`;
        if (item.positionKey !== positionKey) {
          marker.name = `stop-${stop.id}`;
          const edge = this.edges.get(stop.edge);
          const pose = edge ? surfacePose(this, edge, { x: point[0], y: point[1] }, 0) : { height: 0 };
          marker.position.set(point[0], pose.height + (this.elevation ? .1 : 0), point[1]);
          if (edge && this.elevation) {
            const a = this.nodes[edge.a], b = this.nodes[edge.b];
            const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
            const grade = surfacePose(this, edge, { x: point[0], y: point[1] }, angle).grade;
            ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1),
              new THREE.Vector3(-grade * Math.cos(angle), 1, -grade * Math.sin(angle)).normalize());
          }
          item.positionKey = positionKey;
        }
        beacon.visible = marker.position.distanceTo(position) > 12;
        const color = !item.dynamic ? "#85bada" : state.phase === "pickup" ? "#92d7b6" : "#f5c65a";
        ring.material.color.set(color); beacon.material.color.set(color);
        if (active || (!activeLabel && !item.dynamic)) activeLabel = item;
      }
      this.label.hidden = true;
      if (activeLabel && !this.overview) {
        const point = activeLabel.marker.position.clone().add(new THREE.Vector3(0, 7, 0)).project(this.lens);
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
    this.renderer.render(this.bubbleScene, this.lens);
    this.renderer.autoClear = true;
  }
  dispose() {
    this.unsubscribeStream?.();
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
    this.bubbleScene.clear();
    geometries.forEach(geometry => geometry.dispose());
    if (this.cityMaterial) materials.add(this.cityMaterial);
    if (this.fadedCityMaterial) materials.add(this.fadedCityMaterial);
    materials.forEach(material => material.dispose());
    this.resources.forEach(resource => resource.dispose());
    this.renderer.dispose();
  }
}
