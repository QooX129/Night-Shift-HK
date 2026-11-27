import * as THREE from "./vendor/three/three.module.min.js";
import { MapView, TRANSPORT_STYLES, roadAreaLabel } from "./map.mjs?v=subroad-area-labels-1";
import { doorSide, peopleOnMap, drawHailBubble, HAIL_BUBBLE } from "./citizens.mjs?v=passenger-extras-2";
import { en, zh } from "./i18n.mjs?v=passenger-extras-1";
import polygonClipping from "./vendor/polygon-clipping/polygon-clipping.mjs";
import { surfacePose, surfaceSegments, terrainHeight, isElevatedRoad, isGroundRoad, isTunnelRoad }
  from "./elevation.mjs?v=tunnel-clearance-1";
import { staticCollisionLines, COLLISION_LINE_WIDTH, capsuleIntervals, subtractIntervals }
  from "./collision-lines.mjs?v=hk-streets-2";
import { roadWidth } from "./road-width.mjs";
import { roadMarkingRanges } from "./road-markings.mjs";
import { WORLD_SCALE } from "./world-scale.mjs";
import { mergeStraightSegments, straightJoin } from "./straight-lines.mjs";
import { project } from "./physics.mjs?v=tunnel-clearance-1";
import { visualStream } from "./map-stream.mjs?v=roof-canopies-1";
import { SpatialGrid, pointBounds } from "./spatial-grid.mjs";

const CHASE_PITCH = Math.atan2(.6, .9);
const MIN_CHASE_PITCH = Math.PI / 10;
const MAX_CHASE_PITCH = Math.PI * .4;
const MIN_CHASE_GRADE = Math.tan(MIN_CHASE_PITCH);
const DEFAULT_CHASE_DISTANCE = 48 * 5 / 7;
const SKID_LIFETIME = 60;
const SKID_FADE_TIME = 1.5;
const SKID_INITIAL_CAPACITY = 256;
const SIDEWALK_COLOR = "#687873";
const BUILDING_TINTS = {
  apartments: "#a9c2c2", residential: "#b9ad96", house: "#c5ad8f",
  commercial: "#c7a77e", retail: "#d0a16c", hotel: "#93bdc1", office: "#91b5bd",
  industrial: "#a0a9a2", warehouse: "#a0a9a2", school: "#c6bb98",
  hospital: "#c9a7a1", church: "#d1ba86", temple: "#d1ba86", mosque: "#c8b27f",
};
const ROAD_TINTS = {
  motorway: "#35444a", motorway_link: "#344349", trunk: "#34454b", trunk_link: "#34434a",
  primary: "#36464b", primary_link: "#35444a", secondary: "#34454a", secondary_link: "#34444a",
  tertiary: "#334347", tertiary_link: "#334247", residential: "#303e40",
  living_street: "#39463e", unclassified: "#313f3f", service: "#2d393b",
};
// Confirmed location from the supplied street image; dimensions use mapped road widths.
const VERIFIED_YELLOW_BOXES = [
  { road: "Argyle Street", crossing: "Nathan Road", nodes: ["1151084860", "308473424"] },
];

function hasTunnelShell(edge) {
  return isTunnelRoad(edge) && !(edge.tunnel === "building_passage" && Number(edge.layer || 0) >= 0);
}

function isSurfaceRoad(edge) {
  return isGroundRoad(edge) || (!isElevatedRoad(edge) && edge.tunnel === "building_passage" && Number(edge.layer || 0) === 0);
}

function roadFootprint(view, edge) {
  const a = view.nodes[edge.a], b = view.nodes[edge.b];
  const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
  if (!length) return null;
  const radius = roadWidth(view.data.driving, edge) / 2 + .05;
  const nx = -dy / length * radius, ny = dx / length * radius;
  const ex = dx / length * radius, ey = dy / length * radius;
  const points = [[a[0] - ex - nx, a[1] - ey - ny], [a[0] - ex + nx, a[1] - ey + ny],
    [b[0] + ex + nx, b[1] + ey + ny], [b[0] + ex - nx, b[1] + ey - ny]];
  return [...points, points[0]];
}

function elevatedParkBottom(view, park) {
  const points = park.points;
  let surface = Math.max(...points.map(([x, y]) => terrainHeight(view.elevation, x, y)));
  for (const edge of view.groundMap.roadIndex.query(pointBounds(points))) {
    if (isElevatedRoad(edge) || hasTunnelShell(edge)) continue;
    const road = roadFootprint(view, edge);
    if (!road) continue;
    for (const polygon of polygonClipping.intersection([points], [road]))
      for (const ring of polygon) for (const [x, y] of ring)
        surface = Math.max(surface, surfacePose(view, edge, { x, y }, 0).height);
  }
  return surface + 5.2;
}

function pointInFootprint(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [x, y] = polygon[i], [px, py] = polygon[j];
    if ((y > point[1]) !== (py > point[1])
        && point[0] < (px - x) * (point[1] - y) / (py - y) + x) inside = !inside;
  }
  return inside;
}

function roadTint(edge) {
  if (edge.surface === "concrete") return new THREE.Color("#3b484b");
  if (edge.surface === "paving_stones") return new THREE.Color("#403b35");
  return new THREE.Color(ROAD_TINTS[edge.kind] ?? "#303d40");
}

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
    this.mapLabelIndex = data.mapLabels?.length
      ? new SpatialGrid(data.mapLabels, label => pointBounds(label.polygon ?? [label.point])) : null;
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
    this.scene.background = new THREE.Color("#101a21");
    this.scene.fog = new THREE.Fog("#101a21", 180, 600);
    this.lens = new THREE.PerspectiveCamera(48, 1, 0.3, 5000);
    this.orbitYaw = 0;
    this.orbitPitch = CHASE_PITCH;
    this.cameraDrag = null;
    this.cameraEvents = new AbortController();
    const listen = { signal: this.cameraEvents.signal };
    canvas.addEventListener("contextmenu", event => event.preventDefault(), listen);
    canvas.addEventListener("pointerdown", event => {
      if (event.button !== 2 || event.pointerType !== "mouse") return;
      event.preventDefault();
      if (this.chaseCameraSmoothed) {
        const offset = this.lens.position.clone().sub(this.taxi.position);
        this.orbitYaw = THREE.MathUtils.euclideanModulo(
          Math.atan2(-offset.z, -offset.x) - this.cameraHeading + Math.PI, Math.PI * 2) - Math.PI;
        this.orbitPitch = Math.atan2(offset.y, Math.hypot(offset.x, offset.z));
      }
      this.cameraDrag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
    }, listen);
    const endDrag = () => {
      const id = this.cameraDrag?.id;
      this.cameraDrag = null;
      if (id !== undefined && canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    };
    canvas.addEventListener("pointermove", event => {
      const drag = this.cameraDrag;
      if (drag?.id !== event.pointerId) return;
      if (!(event.buttons & 2)) { endDrag(); return; }
      this.orbitYaw = THREE.MathUtils.euclideanModulo(this.orbitYaw + (event.clientX - drag.x) * .007 + Math.PI,
        Math.PI * 2) - Math.PI;
      this.orbitPitch = THREE.MathUtils.clamp(this.orbitPitch + (event.clientY - drag.y) * .006,
        MIN_CHASE_PITCH, MAX_CHASE_PITCH);
      drag.x = event.clientX; drag.y = event.clientY;
    }, listen);
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
      canvas.addEventListener(type, event => {
        if (event.pointerId === this.cameraDrag?.id) endDrag();
      }, listen);
    }
    window.addEventListener("blur", endDrag, listen);
    this.skids = [];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(SKID_INITIAL_CAPACITY * 12 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(SKID_INITIAL_CAPACITY * 12 * 4), 4).setUsage(THREE.DynamicDrawUsage));
    geometry.setDrawRange(0, 0);
    this.skidMesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      transparent: true, depthWrite: false, vertexColors: true, side: THREE.DoubleSide,
    }));
    this.skidMesh.frustumCulled = false;
    this.scene.add(this.skidMesh);
    this.scene.add(new THREE.HemisphereLight("#9eb8c8", "#202a2d", 1.1));
    const sun = new THREE.DirectionalLight("#9bb2c4", 0.65);
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
      this.buildTransport();
      this.buildTaxi();
      this.buildCitizens();
      this.overlays = new THREE.Group();
      this.boundaryScene.add(this.overlays);
      this.overlayKey = null;
      this.buildMarkers();
      this.detailWorker = new Worker(new URL("./map3d-worker.mjs?v=subroad-area-labels-1", import.meta.url), { type: "module" });
      this.curbWorkerPending = Boolean(this.roadBuildTask);
      this.detailWorker.postMessage({ type: "init", map: this.data,
        edges: this.elevation ? this.groundMap.unique.filter(isSurfaceRoad)
          : this.groundMap.unique,
        size: this.detailSize, scale: this.detailScale, backdropColor: this.detailMap.backdropColor,
        curbs: this.curbWorkerPending,
        revision: this.stream?.revision ?? 0 });
      this.detailWorker.onmessage = ({ data }) => {
        if (data.type === "curbs") {
          this.readyCurbs = data.positions;
          return;
        }
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
    map.suppressElevatedParks = true;
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
      map.unique = allRoads.filter(isSurfaceRoad);
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
    map.backdropColor = SIDEWALK_COLOR;
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
        if (!isSurfaceRoad(edge)) continue;
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
      this.detailMap.unique = allRoads.filter(isSurfaceRoad);
    }
    this.detailMap.drawRoadDirections = () => {};
    this.detailMap.backdrop = document.createElement("canvas");
    this.detailMap.backdropBounds = null;
    const detailContext = this.detailMap.backdrop.getContext("2d", { willReadFrequently: true });
    detailContext.fillText = () => {};
    detailContext.strokeText = () => {};
    const asphalt = document.createElement("canvas");
    asphalt.width = asphalt.height = 64;
    const asphaltPaint = asphalt.getContext("2d");
    asphaltPaint.fillStyle = "#d9d9d1"; asphaltPaint.fillRect(0, 0, 64, 64);
    let noise = 17;
    for (let i = 0; i < 400; i++) {
      noise = (Math.imul(noise, 1664525) + 1013904223) >>> 0;
      const shade = 168 + (noise % 48);
      asphaltPaint.fillStyle = `rgb(${shade},${shade},${shade})`;
      asphaltPaint.fillRect((noise >>> 8) % 64, (noise >>> 16) % 64, 1, 1);
    }
    this.asphaltTexture = new THREE.CanvasTexture(asphalt);
    this.asphaltTexture.wrapS = this.asphaltTexture.wrapT = THREE.RepeatWrapping;
    this.asphaltTexture.colorSpace = THREE.SRGBColorSpace;
    this.resources.push(this.asphaltTexture);
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
  *curbMarkings() {
    const roads = [...new Map(this.groundMap.unique.filter(isSurfaceRoad).map(edge =>
      [`${roadWidth(this.data.driving, edge)}:${[edge.a, edge.b].sort().join(":")}`, edge])).values()];
    if (!roads.length) return [];
    let polygons = roads.map(edge => {
      const a = this.nodes[edge.a], b = this.nodes[edge.b], r = roadWidth(this.data.driving, edge) / 2;
      const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const steps = Math.max(8, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - .01 / r))));
      const ring = [];
      for (const [p, start] of [[b, angle - Math.PI / 2], [a, angle + Math.PI / 2]])
        for (let i = 0; i <= steps; i++) {
          const theta = start + i * Math.PI / steps;
          // Millimetre snapping avoids near-coincident capsule edges in the union.
          ring.push([p[0] + r * Math.cos(theta), p[1] + r * Math.sin(theta)]
            .map(v => Math.round(v * 1000) / 1000));
        }
      ring.push(ring[0]);
      return [[ring]];
    });
    // Bounded unions avoid the clipping library's full-map event-queue limit.
    while (polygons.length > 1) {
      const next = [];
      for (let i = 0; i < polygons.length; i += 64) {
        next.push(polygonClipping.union(...polygons.slice(i, i + 64)));
        yield;
      }
      polygons = next;
    }
    const [left, top, right, bottom] = this.data.bounds;
    const pavement = polygonClipping.intersection(polygons[0],
      [[[left, top], [right, top], [right, bottom], [left, bottom], [left, top]]]);
    const roadIndex = new SpatialGrid(roads, edge =>
      pointBounds([this.nodes[edge.a], this.nodes[edge.b]], roadWidth(this.data.driving, edge) / 2 + 1), 32);
    const owner = p => {
      let nearest, distance = Infinity;
      for (const edge of roadIndex.query([p[0], p[1], p[0], p[1]])) {
        const gap = Math.abs(project({ x: p[0], y: p[1] }, this.nodes[edge.a], this.nodes[edge.b]).distance
          - roadWidth(this.data.driving, edge) / 2);
        if (gap < distance) { nearest = edge; distance = gap; }
      }
      if (!nearest) throw new Error(`No ground road owns curb at ${p.join(",")}`);
      return nearest;
    };
    const sample = p => ({ p, edge: owner(p) });
    const vertex = ({ p, edge }, inset, normal) => {
      const x = p[0] + normal[0] * inset, y = p[1] + normal[1] * inset;
      let height = surfacePose(this, edge, { x, y }, 0).height;
      for (const next of roadIndex.query([x, y, x, y]))
        if (project({ x, y }, this.nodes[next.a], this.nodes[next.b]).distance <= roadWidth(this.data.driving, next) / 2 + .02)
          height = Math.max(height, surfacePose(this, next, { x, y }, 0).height);
      return [x, height + .12, y];
    };
    const positions = [];
    const strip = (a, b, c, d) => positions.push(...a, ...b, ...c, ...a, ...c, ...d);
    for (const polygon of pavement) for (const ring of polygon) {
      const segments = [], first = sample(ring[0]);
      let previous = first;
      for (let i = 1; i < ring.length; i++) {
        const a = ring[i - 1], b = ring[i], dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
        // Union rings keep pavement on the left, including around traffic islands.
        const normal = [-dy / length, dx / length];
        for (const [start, end] of surfaceSegments(this, owner([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]), a, b)) {
          const steps = Math.max(1, Math.ceil(Math.hypot(end[0] - start[0], end[1] - start[1]) / 2));
          for (let step = 1; step <= steps; step++) {
            const p = step === steps ? end : start.map((v, axis) => v + (end[axis] - v) * step / steps);
            const last = i === ring.length - 1 && step === steps
              && Math.hypot(p[0] - ring[0][0], p[1] - ring[0][1]) < 1e-7;
            const next = last ? first : sample(p);
            segments.push({ a: previous, b: next, normal });
            previous = next;
          }
        }
        if (i % 128 === 0) yield;
      }
      for (let i = 0; i < segments.length; i++) {
        const { a, b, normal } = segments[i];
        for (const inset of [.35, .65])
          strip(vertex(a, inset - .06, normal), vertex(a, inset + .06, normal),
            vertex(b, inset + .06, normal), vertex(b, inset - .06, normal));
        if (i % 256 === 0) yield;
      }
      for (let i = 0; i < segments.length; i++) {
        const endpoint = segments[i].b;
        const [nx, ny] = segments[i].normal, [ox, oy] = segments[(i + 1) % segments.length].normal;
        const angle = Math.atan2(nx * oy - ny * ox, nx * ox + ny * oy);
        const steps = Math.abs(angle) < 1e-7 ? 0 : Math.ceil(Math.abs(angle) / (Math.PI / 24));
        for (const inset of [.35, .65]) for (let step = 0; step < steps; step++) {
          const normal = i => {
            if (i === 0) return [nx, ny];
            if (i === steps) return [ox, oy];
            const a = angle * i / steps;
            return [nx * Math.cos(a) - ny * Math.sin(a), nx * Math.sin(a) + ny * Math.cos(a)];
          };
          const first = normal(step), last = normal(step + 1);
          strip(vertex(endpoint, inset - .06, first), vertex(endpoint, inset + .06, first),
            vertex(endpoint, inset + .06, last), vertex(endpoint, inset - .06, last));
        }
        if (i % 256 === 0) yield;
      }
    }
    return positions;
  }
  *roadSurfaceGeometry() {
    const tiles = new Map(), nodeRadii = new Map(), elevatedNodes = new Set(), nodeSurfaces = new Map();
    const junctions = new Map();
    this.roadFadeNeighbors = new Map();
    const edges = this.groundMap.unique, edgeOrder = new Map(edges.map((edge, i) => [edge, i]));
    const snapped = point => point.map(value => Math.round(value * 1000) / 1000);
    const footprints = new Map();
    for (const edge of edges) {
      const a = this.nodes[edge.a], b = this.nodes[edge.b];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const radius = roadWidth(this.data.driving, edge) / 2;
      const nx = -(b[1] - a[1]) / length * radius, ny = (b[0] - a[0]) / length * radius;
      const ring = [[a[0] - nx, a[1] - ny], [a[0] + nx, a[1] + ny],
        [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny]].map(snapped);
      ring.push(ring[0]);
      footprints.set(edge, { polygon: [ring], bounds: pointBounds(ring) });
      for (const node of [edge.a, edge.b]) {
        if (!this.roadFadeNeighbors.has(node)) this.roadFadeNeighbors.set(node, []);
        this.roadFadeNeighbors.get(node).push(edge);
        nodeRadii.set(node, Math.max(nodeRadii.get(node) ?? 0, radius));
        const owners = this.elevation.road_junctions?.[edge.id];
        if (!nodeSurfaces.has(node) || owners?.some(owner => owner.node === node)) nodeSurfaces.set(node, edge);
        if (isElevatedRoad(edge)) elevatedNodes.add(node);
      }
    }
    const roadIndex = new SpatialGrid(edges, edge => footprints.get(edge).bounds, 32);
    const overlap = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
    const touches = (a, b) => a[0] <= b[2] + .001 && b[0] <= a[2] + .001
      && a[1] <= b[3] + .001 && b[1] <= a[3] + .001;
    const sameSurface = (edge, other, point) => {
      const connected = edge.a === other.a || edge.a === other.b || edge.b === other.a || edge.b === other.b;
      if (!connected && (isElevatedRoad(edge) !== isElevatedRoad(other) || hasTunnelShell(edge) !== hasTunnelShell(other)
          || Number(edge.layer || 0) !== Number(other.layer || 0))) return false;
      const position = { x: point[0], y: point[1] };
      // Match the road network's vertical compatibility tolerance.
      return Math.abs(surfacePose(this, edge, position, 0).height
        - surfacePose(this, other, position, 0).height) <= .35;
    };
    const overlappingRoads = (edge, bounds) => roadIndex.query(bounds).filter(other => {
      const otherBounds = footprints.get(other).bounds;
      if (!overlap(bounds, otherBounds)) return false;
      const point = [(Math.max(bounds[0], otherBounds[0]) + Math.min(bounds[2], otherBounds[2])) / 2,
        (Math.max(bounds[1], otherBounds[1]) + Math.min(bounds[3], otherBounds[3])) / 2];
      return sameSurface(edge, other, point);
    });
    const nodes = [...nodeRadii].map(([node, radius], order) => ({
      node, radius, order, edge: nodeSurfaces.get(node), bounds: pointBounds([this.nodes[node]], radius),
    }));
    const nodeIndex = new SpatialGrid(nodes, item => item.bounds, 32);
    const nodeData = new Map(nodes.map(item => [item.node, item]));
    const disk = item => {
      const [x, y] = this.nodes[item.node], ring = [];
      for (let i = 0; i < 32; i++) {
        const angle = i * Math.PI / 16;
        ring.push(snapped([x + item.radius * Math.cos(angle), y + item.radius * Math.sin(angle)]));
      }
      ring.push(ring[0]);
      return [ring];
    };
    const caps = new Map(nodes.map(item => [item.node, disk(item)]));
    const area = ring => ring.reduce((sum, point, i) => {
      const next = ring[(i + 1) % ring.length];
      return sum + point[0] * next[1] - next[0] * point[1];
    }, 0);
    const clipHalfPlane = (ring, a, b, direction) => {
      const distance = p => direction * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
      const result = [];
      let previous = ring.at(-1), previousDistance = distance(previous);
      for (const point of ring) {
        const currentDistance = distance(point);
        if ((previousDistance < 0 && currentDistance > 0) || (previousDistance > 0 && currentDistance < 0)) {
          const t = previousDistance / (previousDistance - currentDistance);
          result.push([previous[0] + (point[0] - previous[0]) * t,
            previous[1] + (point[1] - previous[1]) * t]);
        }
        if (currentDistance >= 0) result.push(point);
        previous = point;
        previousDistance = currentDistance;
      }
      return result;
    };
    const intersection = (first, second) => {
      let ring = first[0].slice(0, -1);
      const boundary = second[0].slice(0, -1), direction = Math.sign(area(boundary));
      for (let i = 0; i < boundary.length && ring.length >= 3; i++)
        ring = clipHalfPlane(ring, boundary[i], boundary[(i + 1) % boundary.length], direction);
      return ring.length >= 3 && Math.abs(area(ring)) > 1e-8 ? ring : [];
    };
    // Partition convex road pieces against convex footprints without overlapping output pieces.
    const subtract = (polygon, cuts) => {
      let result = [polygon[0].slice(0, -1)];
      for (const cut of cuts) {
        if (!result.length) break;
        const boundary = cut[0].slice(0, -1), direction = Math.sign(area(boundary));
        const bounds = pointBounds(boundary), next = [];
        for (const ring of result) {
          if (!overlap(pointBounds(ring), bounds)) { next.push(ring); continue; }
          let inside = ring;
          for (let i = 0; i < boundary.length && inside.length >= 3; i++) {
            const a = boundary[i], b = boundary[(i + 1) % boundary.length];
            const outside = clipHalfPlane(inside, a, b, -direction);
            if (outside.length >= 3 && Math.abs(area(outside)) > 1e-8) next.push(outside);
            inside = clipHalfPlane(inside, a, b, direction);
          }
        }
        result = next;
      }
      return result.map(ring => [[...ring, ring[0]]]);
    };
    const junctionPolygons = (item, roads) => {
      const cuts = roads.map(edge => footprints.get(edge).polygon);
      for (const previous of nodeIndex.query(item.bounds)) {
        if (previous.order >= item.order || !overlap(item.bounds, previous.bounds)) continue;
        const point = [(Math.max(item.bounds[0], previous.bounds[0]) + Math.min(item.bounds[2], previous.bounds[2])) / 2,
          (Math.max(item.bounds[1], previous.bounds[1]) + Math.min(item.bounds[3], previous.bounds[3])) / 2];
        if (sameSurface(item.edge, previous.edge, point)) cuts.push(caps.get(previous.node));
      }
      return subtract(caps.get(item.node), cuts);
    };
    const addPolygons = (buffer, polygons, edge, owners = []) => {
      const candidates = owners.map(other => {
        const ring = footprints.get(other).polygon[0];
        return { edge: other, ring, direction: Math.sign(area(ring.slice(0, -1))) };
      });
      for (const polygon of polygons) {
        const rings = polygon.map(ring => ring.slice(0, -1).map(([x, y]) => new THREE.Vector2(x, y)));
        const [outer, ...holes] = rings;
        const faces = THREE.ShapeUtils.triangulateShape(outer, holes);
        const vertices = [outer, ...holes].flat();
        for (const face of faces) for (const index of face) {
          const { x, y } = vertices[index];
          const owner = candidates.find(({ ring, direction }) => {
            for (let i = 0; i < ring.length - 1; i++) {
              const a = ring[i], b = ring[i + 1], dx = b[0] - a[0], dy = b[1] - a[1];
              if (direction * (dx * (y - a[1]) - dy * (x - a[0])) < -1e-7 * Math.hypot(dx, dy)) return false;
            }
            return true;
          })?.edge ?? edge;
          buffer.push(x, surfacePose(this, owner, { x, y }, 0).height + .08, y);
        }
      }
    };
    const physicalKey = edge => `${edge.width ?? edge.kind}:${[edge.a, edge.b].sort().join(":")}`;
    const boundaries = new Map(), decorated = new Set();
    for (const line of this.groundMap.collisionLines.all()) {
      const key = physicalKey(line.edge);
      if (!boundaries.has(key)) boundaries.set(key, []);
      boundaries.get(key).push(line);
    }
    for (const edge of this.groundMap.unique) {
      if (!isSurfaceRoad(edge)) continue;
      for (const node of [edge.a, edge.b]) {
        if (!junctions.has(node)) junctions.set(node, []);
        junctions.get(node).push(edge);
      }
    }
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
      if (!tiles.has(key)) tiles.set(key, { deck: [], shell: [], elevatedDeck: [],
        colors: { deck: [], elevatedDeck: [] }, markings: [], yellow: [], box: [],
        roadRanges: { deck: [], shell: [], elevatedDeck: [], markings: [] },
        railing: [], signal: [], signalRed: [] });
      const tile = tiles.get(key);
      const starts = Object.fromEntries(Object.keys(tile.roadRanges).map(kind => [kind, tile[kind].length / 3]));
      const bridge = isElevatedRoad(edge), tunnel = hasTunnelShell(edge);
      const deckKind = bridge ? "elevatedDeck" : "deck";
      const tint = roadTint(edge);
      const lower = p => [p[0], p[1] - WORLD_SCALE.bridgeDeckThickness, p[2]];
      const upper = p => [p[0], p[1] + WORLD_SCALE.tunnelClearance, p[2]];
      const deckStart = tile[deckKind].length;
      const earlier = overlappingRoads(edge, footprints.get(edge).bounds)
        .filter(other => edgeOrder.get(other) < edgeOrder.get(edge))
        .map(other => ({ edge: other,
          overlap: intersection(footprints.get(edge).polygon, footprints.get(other).polygon) }))
        .filter(item => item.overlap.length);
      const breaks = earlier.flatMap(item => {
        const distances = item.overlap.map(p =>
          ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / length);
        const first = Math.min(...distances), last = Math.max(...distances);
        return [first - 8, first, last, last + 8].filter(value => value > 0 && value < length);
      }).sort((first, last) => first - last);
      const lateralBreaks = earlier.flatMap(item => item.overlap.map(p =>
        ((p[0] - a[0]) * nx + (p[1] - a[1]) * ny) / r))
        .filter(value => value > -1 + 1e-6 && value < 1 - 1e-6);
      const sections = [];
      for (const [start, end] of surfaceSegments(this, edge)) {
        const distance = p => ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / length;
        const first = distance(start), last = distance(end);
        const points = [start, ...breaks.filter(value => value > first + 1e-6 && value < last - 1e-6)
          .map(value => [a[0] + (b[0] - a[0]) * value / length, a[1] + (b[1] - a[1]) * value / length]), end];
        for (let i = 1; i < points.length; i++) {
          if (Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]) > 1e-6)
            sections.push([points[i - 1], points[i]]);
        }
      }
      for (const [start, end] of sections) {
        const al = point(start, -1), ar = point(start, 1),
          bl = point(end, -1), br = point(end, 1);
        const strips = this.elevation.road_junctions?.[edge.id] ? Math.ceil(r * 2) : 1;
        const sides = [...Array.from({ length: strips + 1 }, (_, i) => -1 + 2 * i / strips),
          ...lateralBreaks].sort((first, last) => first - last)
          .filter((value, i, values) => !i || value - values[i - 1] > 1e-6);
        for (let i = 1; i < sides.length; i++) {
          const left = sides[i - 1], right = sides[i];
          const vertices = [point(start, left), point(start, right), point(end, right), point(end, left)];
          const ring = vertices.map(vertex => snapped([vertex[0], vertex[2]]));
          const bounds = pointBounds(ring);
          const owners = earlier.filter(item => touches(bounds, footprints.get(item.edge).bounds))
            .map(item => item.edge).sort((a, b) => edgeOrder.get(a) - edgeOrder.get(b));
          const cuts = owners.map(other => footprints.get(other).polygon);
          if (!cuts.length) quad(tile[deckKind], ...vertices);
          else {
            ring.push(ring[0]);
            addPolygons(tile[deckKind], subtract([ring], cuts), edge, owners);
          }
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
      for (let i = deckStart; i < tile[deckKind].length; i += 3)
        tile.colors[deckKind].push(tint.r, tint.g, tint.b);
      for (const node of [edge.a, edge.b]) {
        if (!elevatedNodes.has(node) || nodeSurfaces.get(node) !== edge) continue;
        const start = tile.elevatedDeck.length;
        const item = nodeData.get(node);
        const owners = overlappingRoads(edge, item.bounds).sort((a, b) => edgeOrder.get(a) - edgeOrder.get(b));
        addPolygons(tile.elevatedDeck, junctionPolygons(item, owners), edge, owners);
        for (let i = start; i < tile.elevatedDeck.length; i += 3)
          tile.colors.elevatedDeck.push(tint.r, tint.g, tint.b);
      }
      const stripe = (start, end, buffer, offset = 0) => {
        const q = (p, side) => {
          const x = p[0] + nx * (offset + side * WORLD_SCALE.markingWidth / 2),
            y = p[1] + ny * (offset + side * WORLD_SCALE.markingWidth / 2);
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
      const markingRanges = roadMarkingRanges(this.data, edge);
      if (r * 2 >= 5.5) {
        const lanes = Math.max(1, Math.min(6, Number.parseInt(edge.lanes, 10) || 1));
        const dividers = lanes > 1 ? lanes - 1 : 1;
        for (let lane = 0; lane < dividers; lane++) {
          const offset = lanes > 1 ? -r + r * 2 * (lane + 1) / lanes : 0;
          for (let distance = 0; distance < length; distance += WORLD_SCALE.dashLength + WORLD_SCALE.dashGap) {
            for (const [first, last] of markingRanges) {
              const start = Math.max(distance, first * length), end = Math.min(distance + WORLD_SCALE.dashLength, last * length);
              if (end > start) stripe(start, end, tile.markings, offset);
            }
          }
        }
      }
      if (length > 12 && markingRanges.some(([first, last]) =>
        first * length <= length / 2 - WORLD_SCALE.arrowLength * .6
        && last * length >= length / 2 + WORLD_SCALE.arrowLength * .6)) {
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
      if (isSurfaceRoad(edge) && r >= 1.2 && length > .5) {
        const roadside = (distance, across, height) => {
          const x = a[0] + (b[0] - a[0]) * distance / length + nx * across;
          const y = a[1] + (b[1] - a[1]) * distance / length + ny * across;
          return [x, surfacePose(this, edge, { x, y }, 0).height + height, y];
        };
        const boundaryKey = physicalKey(edge);
        if (!decorated.has(boundaryKey)) {
          decorated.add(boundaryKey);
          for (const line of boundaries.get(boundaryKey) ?? []) {
            const lateral = p => (p[0] - a[0]) * nx + (p[1] - a[1]) * ny;
            const side = Math.sign(lateral(line.a));
            if (!side || Math.abs(lateral(line.a) - side * r) > .02
                || Math.abs(lateral(line.b) - side * r) > .02
                || Math.abs(lateral(line.a) - lateral(line.b)) > .0001) continue;
            const lineLength = Math.hypot(line.b[0] - line.a[0], line.b[1] - line.a[1]);
            const heights = line.heights ?? [line.a, line.b].map(([x, y]) =>
              surfacePose(this, line.edge, { x, y }, 0).height);
            const at = (t, offset, height) => {
              const x = line.a[0] + (line.b[0] - line.a[0]) * t + nx * side * offset;
              const y = line.a[1] + (line.b[1] - line.a[1]) * t + ny * side * offset;
              const z = heights[0] * (1 - t) + heights[1] * t;
              return [x, z + height, y];
            };
            let intervals = [[0, 1]];
            const bounds = [Math.min(line.a[0], line.b[0]) - 24, Math.min(line.a[1], line.b[1]) - 24,
              Math.max(line.a[0], line.b[0]) + 24, Math.max(line.a[1], line.b[1]) + 24];
            for (const other of this.groundMap.roadIndex.query(bounds)) {
              if (!isSurfaceRoad(other) || other.way === edge.way) continue;
              const oa = this.nodes[other.a], ob = this.nodes[other.b];
              const otherLength = Math.hypot(ob[0] - oa[0], ob[1] - oa[1]);
              if (Math.abs(nx * (ob[0] - oa[0]) + ny * (ob[1] - oa[1])) / otherLength < .01) continue;
              const joins = [other.a, other.b].some(node => {
                const p = this.nodes[node];
                const t = ((p[0] - line.a[0]) * (line.b[0] - line.a[0])
                  + (p[1] - line.a[1]) * (line.b[1] - line.a[1])) / (lineLength * lineLength);
                return t >= -.01 && t <= 1.01 && Math.abs(lateral(p)) < .05
                  && junctions.get(node)?.some(joined => joined.way === edge.way);
              });
              if (joins) intervals = subtractIntervals(intervals,
                capsuleIntervals(line.a, line.b, this.groundMap.collisionLines.roads, other, -.03));
            }
            for (const [first, last] of intervals) {
              for (let from = first * lineLength + 4; from + 3 <= last * lineLength - 4; from += 3) {
                for (const height of [.5, 1]) quad(tile.railing,
                  at(from / lineLength, .8, height), at((from + 3) / lineLength, .8, height),
                  at((from + 3) / lineLength, .8, height + .07), at(from / lineLength, .8, height + .07));
              }
            }
          }
        }
        if (length >= 15) for (const [node, atStart] of [[edge.a, true], [edge.b, false]]) {
          const crossStreet = junctions.get(node)?.some(other => other.name !== edge.name
            && other.name !== "Local road" && other.way !== edge.way);
          if (!crossStreet) continue;
          const center = atStart ? 7 : length - 7;
          const bars = Math.max(1, Math.floor((2 * r - 1.4) / 1.6) + 1);
          for (let bar = 0; bar < bars; bar++) {
            const lateral = (bar - (bars - 1) / 2) * 1.6;
            const begin = lateral - .45, end = lateral + .45;
            quad(tile.markings, roadside(center - 1.5, begin, .14), roadside(center - 1.5, end, .14),
              roadside(center + 1.5, end, .14), roadside(center + 1.5, begin, .14));
          }
          for (const side of [-1, 1]) {
            const pole = roadside(center, side * (r + 1.5), 0);
            const nearby = this.groundMap.roadIndex.query([pole[0] - 16, pole[2] - 16, pole[0] + 16, pole[2] + 16]);
            if (nearby.some(other => other !== edge && project({ x: pole[0], y: pole[2] },
              this.nodes[other.a], this.nodes[other.b]).distance < roadWidth(this.data.driving, other) / 2 + 1)) continue;
            const poleQuad = (width, bottom, top, buffer, across = side * (r + 1.5)) => quad(buffer,
              roadside(center - width, across, bottom), roadside(center + width, across, bottom),
              roadside(center + width, across, top), roadside(center - width, across, top));
            poleQuad(.06, .04, 4, tile.signal);
            poleQuad(.28, 3.2, 4, tile.signal);
            poleQuad(.12, 3.65, 3.85, tile.signalRed, side * (r + 1.48));
          }
        }
        const box = VERIFIED_YELLOW_BOXES.find(item => edge.name === item.road
          && item.nodes.includes(edge.a) && item.nodes.includes(edge.b)
          && item.nodes.every(node => junctions.get(node)?.some(other => other.name === item.crossing)));
        if (box) {
          const extension = Math.max(...box.nodes.flatMap(node => junctions.get(node)
            .filter(other => other.name === box.crossing)
            .map(other => roadWidth(this.data.driving, other) / 2)));
          const start = -extension, span = length + 2 * extension, low = -r + .3, high = r - .3;
          for (const direction of [-1, 1]) for (let offset = low - span; offset < high + span; offset += 3) {
            const first = direction > 0 ? Math.max(0, low - offset) : Math.max(0, offset - high);
            const last = direction > 0 ? Math.min(span, high - offset) : Math.min(span, offset - low);
            if (last <= first) continue;
            const across = t => offset + direction * t;
            quad(tile.box, roadside(start + first, across(first) - .07, .14),
              roadside(start + first, across(first) + .07, .14),
              roadside(start + last, across(last) + .07, .14),
              roadside(start + last, across(last) - .07, .14));
          }
        }
      }
      for (const kind of Object.keys(tile.roadRanges)) {
        const end = tile[kind].length / 3;
        if (end > starts[kind]) tile.roadRanges[kind].push({ edge, start: starts[kind], end });
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
    let curbs;
    if (this.curbWorkerPending) {
      while (!this.readyCurbs) yield;
      curbs = this.readyCurbs;
      this.readyCurbs = null; this.curbWorkerPending = false;
    } else curbs = yield* this.curbMarkings();
    const curbTiles = new Map();
    for (let i = 0; i < curbs.length; i += 18) {
      const key = `${Math.floor((curbs[i] + curbs[i + 6]) / 400)}:${Math.floor((curbs[i + 2] + curbs[i + 8]) / 400)}`;
      if (!curbTiles.has(key)) curbTiles.set(key, []);
      curbTiles.get(key).push(...curbs.slice(i, i + 18));
    }
    for (const yellow of curbTiles.values()) {
      this.addRoadTile({ yellow });
      yield;
    }
    const pilot = this.elevation.pilot;
    if (pilot.triangles?.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(
        pilot.triangles.flatMap(triangle => triangle.flatMap(([x, y, z]) =>
          [x, z + pilot.estimated_vertical_offset_m, y])), 3));
      geometry.computeVertexNormals(); geometry.computeBoundingSphere(); geometry.computeBoundingBox();
      const material = new THREE.MeshStandardMaterial({ color: "#8b9693", roughness: 1, side: THREE.DoubleSide });
      const faded = material.clone();
      faded.transparent = true; faded.opacity = .12; faded.depthWrite = false;
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = "official-LandsD-pilot-bridge-estimated-datum-alignment";
      this.scene.add(mesh);
      this.resources.push(material, faded);
      this.structures.push({ mesh, material, faded,
        edge: this.groundMap.unique.find(edge => edge.id === pilot.bridge) });
    }
    for (const node of elevatedNodes) nodeRadii.delete(node);
    const material = new THREE.MeshBasicMaterial({ vertexColors: true, map: this.asphaltTexture,
      side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    const faded = material.clone();
    faded.transparent = true; faded.opacity = .12; faded.depthWrite = false;
    this.resources.push(faded);
    const jointTiles = new Map();
    let nodeSteps = 0;
    for (const node of nodeRadii.keys()) {
      const [x, y] = this.nodes[node];
      const key = `${Math.floor(x / 200)}:${Math.floor(y / 200)}`;
      if (!jointTiles.has(key)) jointTiles.set(key, { positions: [], colors: [], ranges: [] });
      const edge = nodeSurfaces.get(node), { positions, colors, ranges } = jointTiles.get(key), tint = roadTint(edge);
      const start = positions.length / 3;
      const item = nodeData.get(node);
      const owners = overlappingRoads(edge, item.bounds).sort((a, b) => edgeOrder.get(a) - edgeOrder.get(b));
      addPolygons(positions, junctionPolygons(item, owners), edge, owners);
      for (let i = start; i < positions.length / 3; i++) colors.push(tint.r, tint.g, tint.b);
      if (positions.length / 3 > start) ranges.push({ edge, start, end: positions.length / 3 });
      if (++nodeSteps % 4 === 0) yield;
    }
    for (const { positions, colors, ranges } of jointTiles.values()) {
      if (!positions.length) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
      const uv = [];
      for (let i = 0; i < positions.length; i += 3) uv.push(positions[i] / 12, positions[i + 2] / 12);
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      geometry.computeVertexNormals(); geometry.computeBoundingSphere(); geometry.computeBoundingBox();
      const joints = new THREE.Mesh(geometry, material);
      joints.name = "continuous-shared-node-road-joints";
      this.scene.add(joints);
      this.addRoadFadeStructure(joints, material, faded, ranges);
      yield;
    }
  }
  addRoadFadeStructure(mesh, material, faded, ranges) {
    const geometry = mesh.geometry;
    geometry.setAttribute("roadFade", new THREE.BufferAttribute(
      new Float32Array(geometry.getAttribute("position").count), 1).setUsage(THREE.DynamicDrawUsage));
    this.roadFadeUniforms ??= {
      roadFadeSegment: { value: new THREE.Vector4() },
      roadFadeSize: { value: this.sceneSize },
    };
    const configure = (target, transparent) => {
      target.onBeforeCompile = shader => {
        Object.assign(shader.uniforms, this.roadFadeUniforms);
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", "#include <common>\nattribute float roadFade;\nvarying float vRoadFade;")
          .replace("#include <begin_vertex>", "#include <begin_vertex>\nvRoadFade = roadFade;");
        shader.fragmentShader = shader.fragmentShader
          .replace("#include <common>", `#include <common>
            varying float vRoadFade;
            uniform vec4 roadFadeSegment;
            uniform vec2 roadFadeSize;`)
          .replace("#include <opaque_fragment>", transparent ? `
            if (vRoadFade < 0.5) discard;
            vec2 p = gl_FragCoord.xy / roadFadeSize * 2.0 - 1.0;
            vec2 a = roadFadeSegment.xy, b = roadFadeSegment.zw, ab = b - a;
            float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 0.000001), 0.0, 1.0);
            vec2 origin = clamp(a + t * ab, vec2(-0.999), vec2(0.999));
            vec2 delta = p - origin;
            vec2 remaining = max(vec2(0.001), vec2(1.0) - sign(delta) * origin);
            float gradient = clamp(max(abs(delta.x) / remaining.x, abs(delta.y) / remaining.y), 0.0, 1.0);
            diffuseColor.a *= vRoadFade > 1.5 ? 0.12 : mix(0.12, 1.0, gradient);
            #include <opaque_fragment>` : `
            if (vRoadFade > 0.5) discard;
            #include <opaque_fragment>`);
      };
      target.customProgramCacheKey = () => transparent ? "road-fade-transparent" : "road-fade-solid";
    };
    configure(material, false);
    faded.opacity = 1;
    configure(faded, true);
    const overlay = new THREE.Mesh(geometry, faded);
    overlay.visible = false;
    this.scene.add(overlay);
    this.structures.push({ mesh, material, faded, overlay, ranges });
  }
  updateRoadFades(raycaster) {
    const sources = new Set();
    let nearest = null;
    for (const structure of this.structures || []) {
      const { mesh, material, faded, ranges, edge } = structure;
      if (raycaster) mesh.updateWorldMatrix(true, false);
      const hits = raycaster ? raycaster.intersectObject(mesh, false) : [];
      if (!ranges) {
        mesh.material = hits.length ? faded : material;
        if (edge && hits.length) {
          sources.add(edge);
          if (!nearest || hits[0].distance < nearest.distance) nearest = { ...hits[0], edge };
        }
        continue;
      }
      for (const hit of hits) {
        const range = ranges.find(item => hit.face.a >= item.start && hit.face.a < item.end);
        if (!range) throw new Error(`Missing road owner for ${mesh.name} vertex ${hit.face.a}`);
        sources.add(range.edge);
        if (!nearest || hit.distance < nearest.distance) nearest = { ...hit, edge: range.edge };
      }
    }
    const connected = new Set(sources);
    if (nearest) {
      this.lens.updateMatrixWorld();
      const frustum = new THREE.Frustum().setFromProjectionMatrix(
        new THREE.Matrix4().multiplyMatrices(this.lens.projectionMatrix, this.lens.matrixWorldInverse));
      const visible = edge => {
        const a = this.nodes[edge.a], b = this.nodes[edge.b];
        const heights = this.elevation.node_heights, margin = roadWidth(this.data.driving, edge) / 2 + 8;
        return frustum.intersectsBox(new THREE.Box3(
          new THREE.Vector3(Math.min(a[0], b[0]) - margin, Math.min(heights[edge.a], heights[edge.b]) - margin, Math.min(a[1], b[1]) - margin),
          new THREE.Vector3(Math.max(a[0], b[0]) + margin, Math.max(heights[edge.a], heights[edge.b]) + margin, Math.max(a[1], b[1]) + margin)));
      };
      const queue = [...sources];
      for (let i = 0; i < queue.length; i++) for (const node of [queue[i].a, queue[i].b]) {
        for (const edge of this.roadFadeNeighbors.get(node) ?? []) {
          if (!connected.has(edge) && visible(edge)) { connected.add(edge); queue.push(edge); }
        }
      }
      const edge = nearest.edge, a = this.nodes[edge.a], b = this.nodes[edge.b];
      const point = (node, coordinates) => new THREE.Vector3(coordinates[0],
        this.elevation.node_heights[node] + .08, coordinates[1]).applyMatrix4(this.lens.matrixWorldInverse);
      let first = point(edge.a, a), last = point(edge.b, b);
      const near = -this.lens.near;
      if (first.z >= near && last.z >= near) {
        first = nearest.point.clone().project(this.lens);
        last = first;
      } else {
        if (first.z >= near) first.lerp(last, (near - first.z) / (last.z - first.z));
        if (last.z >= near) last.lerp(first, (near - last.z) / (first.z - last.z));
        first.applyMatrix4(this.lens.projectionMatrix);
        last.applyMatrix4(this.lens.projectionMatrix);
      }
      this.roadFadeUniforms.roadFadeSegment.value.set(first.x, first.y, last.x, last.y);
    }
    if (!nearest && !this.roadFadeActive) return;
    this.roadFadeActive = Boolean(nearest);
    for (const { mesh, overlay, ranges } of this.structures || []) {
      if (!ranges) continue;
      const attribute = mesh.geometry.getAttribute("roadFade");
      let changed = false, active = false;
      for (const { edge, start, end } of ranges) {
        const value = sources.has(edge) ? 2 : connected.has(edge) ? 1 : 0;
        active ||= value > 0;
        if (attribute.array[start] !== value) {
          attribute.array.fill(value, start, end);
          changed = true;
        }
      }
      if (changed) attribute.needsUpdate = true;
      overlay.visible = active;
    }
  }
  buildTransport() {
    const features = this.data.transport ?? [];
    if (!features.length) return;
    this.groundMap.spatialIndexes();
    const placement = point => {
      const [x, y] = point;
      let nearest = null, distance = Infinity;
      for (const edge of this.groundMap.roadIndex.query([x - 20, y - 20, x + 20, y + 20])) {
        if (!isSurfaceRoad(edge)) continue;
        const candidate = project({ x, y }, this.nodes[edge.a], this.nodes[edge.b]).distance;
        if (candidate < distance) { nearest = edge; distance = candidate; }
      }
      let angle = 0;
      if (nearest) {
        const a = this.nodes[nearest.a], b = this.nodes[nearest.b];
        const closest = project({ x, y }, a, b);
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const side = (x - closest.x) * -dy + (y - closest.y) * dx < 0 ? -1 : 1;
        angle = Math.atan2(-dy * side, dx * side);
      }
      const height = nearest && distance <= roadWidth(this.data.driving, nearest) / 2 + 5
        ? surfacePose(this, nearest, { x, y }, 0).height : terrainHeight(this.elevation, x, y);
      return { height, angle };
    };
    const transform = new THREE.Object3D();
    for (const kind of Object.keys(TRANSPORT_STYLES)) {
      const items = features.filter(feature => feature.kind === kind)
        .map(feature => ({ ...feature, ...placement(feature.point) }));
      if (!items.length) continue;
      const material = color => new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
      const printed = (paint, width = 256, height = 128) => {
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        paint(canvas.getContext("2d"), width, height);
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        this.resources.push(texture);
        return new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
      };
      const text = (label, background, color = "#ffffff") => printed((c, w, h) => {
        c.fillStyle = background; c.fillRect(0, 0, w, h);
        c.fillStyle = color; c.font = "bold 64px sans-serif";
        c.textAlign = "center"; c.textBaseline = "middle"; c.fillText(label, w / 2, h / 2);
      });
      const instances = (name, geometry, paint, offsets, selected = items, rotation = 0) => {
        const mesh = new THREE.InstancedMesh(geometry, paint, selected.length * offsets.length);
        mesh.name = `transport-${kind}-${name}`;
        let index = 0;
        for (const { point: [x, y], height, angle } of selected) for (const [dx, dy, dz] of offsets) {
          transform.rotation.set(0, angle + rotation, 0);
          transform.position.set(x + dx * Math.cos(angle) + dz * Math.sin(angle), height + dy,
            y - dx * Math.sin(angle) + dz * Math.cos(angle));
          transform.updateMatrix(); mesh.setMatrixAt(index++, transform.matrix);
        }
        mesh.computeBoundingSphere(); this.scene.add(mesh);
      };
      const box = (name, size, paint, offsets, selected, rotation) =>
        instances(name, new THREE.BoxGeometry(...size), paint, offsets, selected, rotation);
      if (kind === "bus") {
        const roundel = printed((c, w, h) => {
          c.fillStyle = "#c92d35"; c.fillRect(0, 0, w, h);
          c.fillStyle = "#fff4d8"; c.beginPath(); c.arc(w / 2, h / 2, w * .41, 0, Math.PI * 2); c.fill();
          c.fillStyle = "#c92d35"; c.font = "bold 34px sans-serif"; c.textAlign = "center";
          c.fillText("巴士站", w / 2, 75);
          c.fillRect(86, 100, 84, 99);
          c.fillStyle = "#fff4d8";
          for (const y of [111, 143]) for (const x of [96, 133]) c.fillRect(x, y, 27, 21);
          c.fillStyle = "#303738"; c.fillRect(91, 194, 19, 13); c.fillRect(146, 194, 19, 13);
          c.fillStyle = "#c92d35"; c.font = "bold 19px sans-serif"; c.fillText("BUS STOP", w / 2, 226);
        }, 256, 256);
        const timetable = printed((c, w, h) => {
          c.fillStyle = "#f4edd8"; c.fillRect(0, 0, w, h);
          c.fillStyle = "#c92d35"; c.fillRect(0, 0, w, 52);
          c.fillStyle = "#ffffff"; c.font = "bold 22px sans-serif"; c.textAlign = "center";
          c.fillText("BUS", w / 2, 35);
          c.fillStyle = "#566269";
          for (let y = 75; y < h - 15; y += 20) c.fillRect(15, y, w - 30, 4);
        }, 128, 256);
        box("poles", [.1, 2.65, .1], material("#c92d35"), [[0, 1.325, 0]]);
        instances("signs", new THREE.CircleGeometry(.4, 24), roundel, [[-.065, 2.65, 0]], items, -Math.PI / 2);
        box("timetables", [.32, .85, .09], timetable, [[-.08, 1.65, 0]], items, -Math.PI / 2);
        box("bases", [.3, .12, .3], material("#686f69"), [[0, .06, 0]]);
      } else if (kind === "mtr") {
        const steel = material("#9caeaa"), stone = material("#b6b9ad");
        box("poles", [.1, 2.5, .1], steel, [[-1.25, 1.25, .15], [1.25, 1.25, .15],
          [-1.25, 1.25, 4.15], [1.25, 1.25, 4.15]]);
        const stations = new Map();
        for (const item of items) {
          if (!item.station?.name) throw new Error(`MTR entrance ${item.id} lacks a station name; rebuild tools/prepare_transport.py`);
          const key = item.station.id;
          if (!stations.has(key)) stations.set(key, []);
          stations.get(key).push(item);
        }
        const drawEmblem = (c, x, y, radius) => {
          c.fillStyle = "#cc3348"; c.beginPath(); c.arc(x, y, radius, 0, Math.PI * 2); c.fill();
          c.fillStyle = "#ffffff"; c.font = `bold ${radius * 1.5}px sans-serif`;
          c.textAlign = "center"; c.textBaseline = "middle"; c.fillText("M", x, y);
        };
        const signEdge = material("#26333f"), emblemEdge = material("#f0eee3");
        for (const selected of stations.values()) {
          const { name, zh } = selected[0].station;
          const banner = printed((c, w, h) => {
            c.fillStyle = "#26333f"; c.fillRect(0, 0, w, h);
            c.strokeStyle = "#a9b5b2"; c.lineWidth = 10; c.strokeRect(5, 5, w - 10, h - 10);
            drawEmblem(c, 105, h / 2, 67);
            c.fillStyle = "#ffffff"; c.textAlign = "center"; c.textBaseline = "middle";
            if (zh) {
              c.font = "bold 62px sans-serif";
              c.fillText(zh.endsWith("站") ? zh : `${zh}站`, w / 2, 59, w - 360);
            }
            c.font = "46px sans-serif";
            c.fillText(/station$/i.test(name) ? name : `${name} Station`, w / 2, zh ? 140 : h / 2, w - 360);
          }, 1024, 192);
          box("signs", [2.4, .45, .12], [signEdge, signEdge, signEdge, signEdge, banner, banner],
            [[0, 2.45, .1]], selected);
        }
        const emblem = printed((c, w, h) => {
          c.fillStyle = "#f0eee3"; c.fillRect(0, 0, w, h);
          drawEmblem(c, w / 2, h / 2, 105);
        }, 256, 256);
        box("emblem-posts", [.08, 1.1, .08], steel, [[-1.42, 2.65, .1]]);
        box("emblems", [.65, .65, .14], [emblemEdge, emblemEdge, emblemEdge, emblemEdge, emblem, emblem],
          [[-1.42, 3.2, .1]], items, -Math.PI / 2);
        box("parapets", [.18, .8, 4.3], stone, [[-1.3, .4, 2.1], [1.3, .4, 2.1]]);
        const exits = new Map();
        for (const item of items) {
          if (!item.ref) continue;
          if (!exits.has(item.ref)) exits.set(item.ref, []);
          exits.get(item.ref).push(item);
        }
        for (const [ref, selected] of exits) {
          const label = text(ref, "#e6bf55", "#17232a");
          box("exit-letters", [.24, .5, .9], [label, label, stone, stone, stone, stone],
            [[-1.3, 1.5, .7]], selected);
        }
        box("glazing", [.05, 1.3, 4.05], new THREE.MeshBasicMaterial({
          color: "#6d9d96", transparent: true, opacity: .35, depthWrite: false, side: THREE.DoubleSide,
        }), [[-1.3, 1.45, 2.15], [1.3, 1.45, 2.15]]);
        box("handrails", [.08, .08, 4.3], steel, [[-1.15, .95, 2.1], [1.15, .95, 2.1]]);
        // A dark street-level portal suggests the stairwell without cutting the terrain mesh.
        box("opening", [2.35, 2.1, .08], material("#101d23"), [[0, 1.05, 4.2]]);
        box("landing", [2.4, .06, 4.2], material("#303d40"), [[0, .04, 2.1]]);
        const steps = Array.from({ length: 5 }, (_, i) => [0, .07 + i * .025, 3.8 - i * .35]);
        box("stair-treads", [2.15, .035, .3], material("#7c8984"), steps);
        const roof = [];
        for (let i = 0; i < 16; i++) {
          const a = Math.PI * i / 16, b = Math.PI * (i + 1) / 16;
          const first = [Math.cos(a) * 1.5, 2.1 + Math.sin(a) * .8],
            last = [Math.cos(b) * 1.5, 2.1 + Math.sin(b) * .8];
          for (const [p, z] of [[first, -.15], [first, 4.5], [last, 4.5],
            [first, -.15], [last, 4.5], [last, -.15]]) roof.push(p[0], p[1], z);
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(roof, 3));
        instances("canopies", geometry, material("#4e736a"), [[0, 0, 0]]);
      } else {
        const sign = printed((c, w, h) => {
          c.fillStyle = "#237e6d"; c.fillRect(0, 0, w, h);
          c.strokeStyle = "#e8eee8"; c.lineWidth = 5; c.strokeRect(4, 4, w - 8, h - 8);
          c.fillStyle = "#ffffff"; c.textAlign = "center"; c.textBaseline = "middle";
          c.font = "bold 30px sans-serif"; c.fillText("TAXI STAND", w / 2, 39, w - 20);
          c.font = "bold 49px sans-serif"; c.fillText("的士站", w / 2, 91, w - 20);
        });
        box("poles", [.12, 2.2, .12], material("#a9b5b2"), [[0, 1.1, 0]]);
        box("signs", [1, .5, .08], sign, [[0, 2.2, 0]], items, -Math.PI / 2);
      }
    }
  }
  addRoadTile(tile) {
    const detailColors = { yellow: "#d3ac56", railing: "#b1bfba",
      signal: "#253438", signalRed: "#d36a5e" };
    const details = [], colors = [], ranges = {};
    for (const [kind, positions] of Object.entries(tile)) {
      if (!positions.length) continue;
      if (kind in detailColors) {
        ranges[kind] = [details.length / 3, positions.length / 3];
        for (const value of positions) details.push(value);
        const color = new THREE.Color(detailColors[kind]);
        for (let i = 0; i < positions.length; i += 3) colors.push(color.r, color.g, color.b);
        continue;
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      const roadColors = tile.colors?.[kind];
      if (roadColors?.length) geometry.setAttribute("color", new THREE.Float32BufferAttribute(roadColors, 3));
      geometry.computeVertexNormals(); geometry.computeBoundingSphere(); geometry.computeBoundingBox();
      if (kind === "deck" || kind === "elevatedDeck") {
        const uv = [];
        for (let i = 0; i < positions.length; i += 3) uv.push(positions[i] / 12, positions[i + 2] / 12);
        geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      }
      const material = new THREE.MeshBasicMaterial({
        color: roadColors?.length ? "#ffffff" : { deck: "#46545a", shell: "#788483",
          elevatedDeck: "#46545a", markings: "#c2d0bf", box: "#d3ac56" }[kind],
        vertexColors: Boolean(roadColors?.length),
        map: kind === "deck" || kind === "elevatedDeck" ? this.asphaltTexture : null, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = kind === "box" ? "yellow-box-markings" : kind === "deck" || kind === "elevatedDeck"
        ? "level-separated-solid-road-decks" : "bridge-and-tunnel-shells";
      this.scene.add(mesh);
      this.resources.push(material);
      if (["deck", "shell", "elevatedDeck", "markings"].includes(kind)) {
        const faded = material.clone();
        faded.transparent = true; faded.opacity = .12; faded.depthWrite = false;
        this.resources.push(faded);
        if (tile.roadRanges) this.addRoadFadeStructure(mesh, material, faded, tile.roadRanges[kind]);
        else this.structures.push({ mesh, material, faded });
      }
    }
    if (details.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(details, 3));
      geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
      geometry.computeBoundingSphere(); geometry.computeBoundingBox();
      const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = "street-details";
      mesh.userData.streetRanges = ranges;
      this.scene.add(mesh);
      this.resources.push(material);
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
    paint.fillStyle = "#596366"; paint.fillRect(0, 0, 64, 64);
    paint.fillStyle = "#87908a"; paint.fillRect(0, 0, 64, 3);
    for (let column = 0; column < 4; column++) {
      const x = 5 + column * 15, lit = (column * 7) % 4 !== 0;
      paint.fillStyle = "#293b40"; paint.fillRect(x, 12, 11, 33);
      paint.fillStyle = lit ? (column % 2 ? "#cfb77c" : "#7eabb2") : "#4d737d";
      paint.fillRect(x + 1, 13, 9, 30);
      paint.fillStyle = "#536064"; paint.fillRect(x + 1, 28, 9, 2);
    }
    paint.fillStyle = "#a9a18a"; paint.fillRect(0, 49, 64, 4);
    paint.fillStyle = "#37464a"; paint.fillRect(0, 59, 64, 5);
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
    const glass = document.createElement("canvas");
    glass.width = glass.height = 64;
    const glassPaint = glass.getContext("2d");
    glassPaint.fillStyle = "#8eaab0"; glassPaint.fillRect(0, 0, 64, 64);
    glassPaint.fillStyle = "#6e919c"; glassPaint.fillRect(2, 2, 60, 60);
    glassPaint.fillStyle = "#b5ced0"; glassPaint.fillRect(0, 0, 64, 3); glassPaint.fillRect(0, 0, 3, 64);
    glassPaint.fillStyle = "#9bb6bc"; glassPaint.fillRect(6, 6, 24, 45);
    const glassTexture = new THREE.CanvasTexture(glass);
    glassTexture.wrapS = glassTexture.wrapT = THREE.RepeatWrapping;
    glassTexture.colorSpace = THREE.SRGBColorSpace;
    glassTexture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.resources.push(glassTexture);
    this.landmarkMaterial = new THREE.MeshBasicMaterial({ map: glassTexture, vertexColors: true });
    this.fadedLandmarkMaterial = this.landmarkMaterial.clone();
    this.fadedLandmarkMaterial.transparent = true;
    this.fadedLandmarkMaterial.opacity = .12;
    this.fadedLandmarkMaterial.depthWrite = false;
    const adverts = document.createElement("canvas");
    adverts.width = 1280; adverts.height = 256;
    const poster = adverts.getContext("2d");
    const designs = [
      ["明亮眼鏡", "OPTICAL", "#efe9dc", "#a94e40"],
      ["日常茶室", "TEA HOUSE", "#e7dfc4", "#58735d"],
      ["生活百貨", "EVERYDAY GOODS", "#e7e2d7", "#476c78"],
      ["街坊良品", "LOCAL FAVOURITES", "#eee1cf", "#a45f4d"],
      ["朗豪坊", "LANGHAM PLACE", "#dce7e5", "#516d78"],
    ];
    designs.forEach(([title, subtitle, background, accent], index) => {
      const x = index * 256;
      poster.fillStyle = background; poster.fillRect(x, 0, 256, 256);
      poster.fillStyle = accent; poster.fillRect(x, 0, 256, 14); poster.fillRect(x, 210, 256, 46);
      poster.textAlign = "center"; poster.fillStyle = "#263b3b";
      poster.font = "bold 34px sans-serif"; poster.fillText(title, x + 128, 59, 238);
      poster.font = "bold 16px sans-serif"; poster.fillText(subtitle, x + 128, 84, 232);
      poster.strokeStyle = accent; poster.lineWidth = 6;
      if (index === 0) {
        poster.strokeRect(x + 54, 118, 58, 38); poster.strokeRect(x + 144, 118, 58, 38);
        poster.beginPath(); poster.moveTo(x + 112, 137); poster.lineTo(x + 144, 137); poster.stroke();
      } else {
        poster.fillStyle = accent; poster.fillRect(x + 100, 105, 56, 76);
        poster.fillStyle = background; poster.fillRect(x + 112, 118, 32, 35);
      }
      poster.fillStyle = "#fffdf2"; poster.font = "bold 14px sans-serif";
      poster.fillText(index === 4 ? "MONG KOK" : "旺角 · MONG KOK", x + 128, 239, 230);
    });
    const advertTexture = new THREE.CanvasTexture(adverts);
    advertTexture.colorSpace = THREE.SRGBColorSpace;
    advertTexture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.resources.push(advertTexture);
    this.advertMaterial = new THREE.MeshBasicMaterial({ map: advertTexture });
    this.fadedAdvertMaterial = this.advertMaterial.clone();
    this.fadedAdvertMaterial.transparent = true;
    this.fadedAdvertMaterial.opacity = .12;
    this.fadedAdvertMaterial.depthWrite = false;
    // The full-resolution road overlay samples scene depth, including translucent roofs.
    this.roofMaterial = new THREE.MeshBasicMaterial({ color: "#9cc2c5", transparent: true,
      opacity: .48, side: THREE.DoubleSide, forceSinglePass: true });
    this.roofPostMaterial = new THREE.MeshBasicMaterial({ color: "#647679" });
    this.parkMaterial = new THREE.MeshStandardMaterial({ color: "#355f48", roughness: 1, side: THREE.DoubleSide });
    this.fadedParkMaterial = new THREE.MeshStandardMaterial({ color: "#355f48", roughness: 1,
      side: THREE.DoubleSide, transparent: true, opacity: .18, depthWrite: false });
    this.resources.push(this.roofMaterial, this.roofPostMaterial, this.parkMaterial, this.fadedParkMaterial);
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
  buildCanopy(points, cover, posts) {
    const ring = points[0][0] === points.at(-1)[0] && points[0][1] === points.at(-1)[1]
      ? points.slice(0, -1) : points;
    let longest = 0, ux = 1, uz = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x, z] = ring[i], [nx, nz] = ring[(i + 1) % ring.length];
      const length = Math.hypot(nx - x, nz - z);
      if (length > longest) { longest = length; ux = (nx - x) / length; uz = (nz - z) / length; }
    }
    const local = ring.map(([x, z]) => new THREE.Vector2(x * ux + z * uz, z * ux - x * uz));
    const bounds = new THREE.Box2().setFromPoints(local);
    const { x: span, y: width } = bounds.getSize(new THREE.Vector2());
    if (span < .1 || width < .1) return;
    const triangles = THREE.ShapeUtils.triangulateShape(local, []);
    const world = (u, v) => ({ x: u * ux - v * uz, y: u * uz + v * ux });
    const cuts = u => {
      const intersections = [];
      for (let i = 0; i < local.length; i++) {
        const a = local[i], b = local[(i + 1) % local.length];
        if ((a.x > u) !== (b.x > u))
          intersections.push(a.y + (b.y - a.y) * (u - a.x) / (b.x - a.x));
      }
      return intersections.sort((a, b) => a - b);
    };
    const contains = ([x, z]) => {
      const v = z * ux - x * uz;
      return cuts(x * ux + z * uz).filter(crossing => crossing > v).length % 2 !== 0;
    };
    const xs = ring.map(p => p[0]), zs = ring.map(p => p[1]);
    const roads = this.groundMap.roadIndex.query([
      Math.min(...xs) - 12, Math.min(...zs) - 12, Math.max(...xs) + 12, Math.max(...zs) + 12,
    ]).filter(edge => !hasTunnelShell(edge));
    let eave = Math.max(...ring.map(([x, z]) => terrainHeight(this.elevation, x, z))) + 2.8;
    for (const edge of roads) {
      const a = this.nodes[edge.a], b = this.nodes[edge.b];
      const dx = b[0] - a[0], dz = b[1] - a[1], length = Math.hypot(dx, dz);
      if (!length) continue;
      const radius = roadWidth(this.data.driving, edge) / 2 + COLLISION_LINE_WIDTH / 2;
      const raiseEave = (x, y) => {
        eave = Math.max(eave, surfacePose(this, edge, { x, y }, 0).height + 5.2);
      };
      // Include short overlaps at footprint corners and the rounded ends of the road.
      for (const [x, y] of ring) {
        if (project({ x, y }, a, b).distance <= radius) raiseEave(x, y);
      }
      const count = Math.ceil(length / 2);
      for (let i = 0; i <= count; i++) {
        const x = a[0] + dx * i / count, y = a[1] + dz * i / count;
        for (const side of [-1, -.5, 0, .5, 1]) {
          const px = x - dz / length * radius * side, py = y + dx / length * radius * side;
          if (contains([px, py])) raiseEave(px, py);
        }
      }
    }
    const heightAt = v => eave + Math.min(1.8, width * .14) * (1 - (2 * (v - bounds.min.y) / width - 1) ** 2);
    const split = (a, b, c, depth) => {
      if (!depth) {
        for (const { x: u, y: v } of [a, b, c]) {
          const point = world(u, v);
          cover.push(point.x, heightAt(v), point.y);
        }
        return;
      }
      const ab = a.clone().lerp(b, .5), bc = b.clone().lerp(c, .5), ca = c.clone().lerp(a, .5);
      split(a, ab, ca, depth - 1); split(ab, b, bc, depth - 1);
      split(ca, bc, c, depth - 1); split(ab, bc, ca, depth - 1);
    };
    for (const [a, b, c] of triangles) split(local[a], local[b], local[c], 2);
    if (!triangles.length) return;
    const rows = Math.max(2, Math.min(20, Math.ceil(span / 12)));
    for (let row = 0; row < rows; row++) {
      const u = bounds.min.x + span * (row + .5) / rows, limits = cuts(u);
      if (limits.length < 2) continue;
      const first = limits[0], last = limits.at(-1);
      const inset = Math.min(.5, (last - first) * .14);
      for (const v of [first + inset, last - inset]) {
        const point = world(u, v);
        if (!contains([point.x, point.y]) || roads.some(edge =>
          project(point, this.nodes[edge.a], this.nodes[edge.b]).distance <= roadWidth(this.data.driving, edge) / 2 + .4)) continue;
        const base = terrainHeight(this.elevation, point.x, point.y);
        const height = heightAt(v) - base, size = Math.min(.45, Math.max(.12, width * .05));
        const geometry = new THREE.BoxGeometry(size, height, size);
        const positions = geometry.getAttribute("position");
        for (let i = 0; i < geometry.index.count; i++) {
          const j = geometry.index.getX(i);
          posts.push(point.x + positions.getX(j), base + height / 2 + positions.getY(j), point.y + positions.getZ(j));
        }
        geometry.dispose();
      }
    }
  }
  *cityGeometry(footprints) {
    const tiles = new Map();
    const cover = [], posts = [], parkPosts = [];
    const meshes = [];
    const buildingMetadata = new Map((this.elevation?.buildings || []).map(b => [b.index, b]));
    const parks = (this.data.backdrop ?? footprints).filter(shape => shape.kind === "park" && Number(shape.layer) > 0);
    const parkBottoms = new Map();
    const parkBottom = park => {
      if (!parkBottoms.has(park)) parkBottoms.set(park, elevatedParkBottom(this, park));
      return parkBottoms.get(park);
    };
    for (const [index, footprint] of footprints.entries()) {
      if (footprint.points.length < 3) continue;
      if (footprint.kind === "roof") {
        this.buildCanopy(footprint.points, cover, posts);
        yield;
        continue;
      }
      if (footprint.kind === "park" && Number(footprint.layer) > 0) {
        const points = footprint.points;
        const bottom = parkBottom(footprint);
        const roads = this.groundMap.roadIndex.query(pointBounds(points, 10));
        const openings = [];
        for (const edge of roads) {
          const level = Math.max(Number(edge.layer) || 0, isElevatedRoad(edge) ? 1 : 0);
          if (!isElevatedRoad(edge) || hasTunnelShell(edge) || level >= Number(footprint.layer)) continue;
          const road = roadFootprint(this, edge);
          if (!road) continue;
          const overlap = polygonClipping.intersection([points], [road]);
          if (overlap.some(polygon => polygon.some(ring => ring.some(([x, y]) =>
            surfacePose(this, edge, { x, y }, 0).height + 5.2 > bottom)))) openings.push([road]);
        }
        const polygons = openings.length ? polygonClipping.difference([points], ...openings) : [[points]];
        const shapes = polygons.map(polygon => {
          const shape = new THREE.Shape(polygon[0].map(([x, y]) => new THREE.Vector2(x, -y)));
          for (const ring of polygon.slice(1))
            shape.holes.push(new THREE.Path(ring.map(([x, y]) => new THREE.Vector2(x, -y))));
          return shape;
        });
        const geometry = new THREE.ExtrudeGeometry(shapes, { depth: .8, bevelEnabled: false });
        geometry.rotateX(-Math.PI / 2);
        geometry.translate(0, bottom, 0);
        geometry.computeBoundingSphere();
        const mesh = new THREE.Mesh(geometry, this.parkMaterial);
        mesh.name = "elevated-park";
        mesh.userData.cityCanopy = true;
        this.scene.add(mesh);
        meshes.push(mesh);
        const center = points.reduce((sum, p) => [sum[0] + p[0] / points.length, sum[1] + p[1] / points.length], [0, 0]);
        for (let i = 0; i < points.length; i++) {
          const a = points[i], b = points[(i + 1) % points.length], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (!length) continue;
          const count = Math.max(1, Math.floor(length / 12));
          for (let j = 0; j < count; j++) {
            const t = (j + .5) / count, x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
            const dx = center[0] - x, dy = center[1] - y, distance = Math.hypot(dx, dy);
            if (!distance) continue;
            const point = [x + 3 * dx / distance, y + 3 * dy / distance], size = .8;
            if (![[-size, -size], [-size, size], [size, -size], [size, size]]
              .every(([ox, oy]) => pointInFootprint([point[0] + ox, point[1] + oy], points))) continue;
            if (roads.some(edge => !hasTunnelShell(edge) && project({ x: point[0], y: point[1] },
              this.nodes[edge.a], this.nodes[edge.b]).distance <= roadWidth(this.data.driving, edge) / 2 + size)) continue;
            const base = terrainHeight(this.elevation, ...point), height = bottom - base;
            if (height <= 0) continue;
            const pillar = new THREE.BoxGeometry(size, height, size), positions = pillar.getAttribute("position");
            for (let k = 0; k < pillar.index.count; k++) {
              const vertex = pillar.index.getX(k);
              parkPosts.push(point[0] + positions.getX(vertex), base + height / 2 + positions.getY(vertex),
                point[1] + positions.getZ(vertex));
            }
            pillar.dispose();
          }
        }
        yield;
        continue;
      }
      if (footprint.kind !== "building") continue;
      const points = footprint.points;
      const cx = points.reduce((sum, p) => sum + p[0], 0) / points.length;
      const cy = points.reduce((sum, p) => sum + p[1], 0) / points.length;
      const metadata = footprint.building ?? buildingMetadata.get(footprint.id ?? index);
      const landmark = [65259283, 102411832].includes(metadata?.osm_way);
      const key = `${Math.floor(cx / 60)}:${Math.floor(cy / 60)}:${landmark}`;
      if (!tiles.has(key)) tiles.set(key, { landmark, positions: [], normals: [], colors: [], uvs: [], adverts: [], advertUvs: [] });
      const tile = tiles.get(key);
      const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, -y)));
      const seed = Math.abs(Math.round(cx * 13 + cy * 7));
      const height = metadata?.height ?? WORLD_SCALE.fallbackBuildingHeight;
      const minHeight = metadata?.min_height ?? 0;
      if (minHeight >= height) throw new Error(`Building ${metadata?.osm_way ?? footprint.id} has invalid height metadata`);
      const base = metadata?.base ?? 0;
      const openings = [];
      let openingTop = minHeight;
      // shortcut: openings use sampled road heights and estimated clearance until surveyed geometry is available.
      for (const edge of this.groundMap.roadIndex.query(pointBounds(points))) {
        const roadLevel = Math.max(Number(edge.layer) || 0, isElevatedRoad(edge) ? 1 : 0);
        if (!isSurfaceRoad(edge) && (hasTunnelShell(edge) || !isElevatedRoad(edge)
            || !(Number(metadata?.building_layer) > roadLevel))) continue;
        const road = roadFootprint(this, edge);
        if (!road) continue;
        const overlap = polygonClipping.intersection([points], [road]);
        if (!overlap.length) continue;
        openings.push([road]);
        for (const polygon of overlap) for (const ring of polygon) for (const [x, y] of ring)
          openingTop = Math.max(openingTop, surfacePose(this, edge, { x, y }, 0).height + 5.2 - base);
      }
      if (Number(metadata?.building_layer) > 0 && minHeight === 0) {
        for (const park of parks) {
          if (base + height > parkBottom(park) + .8) continue;
          if (!polygonClipping.intersection([points], [park.points]).length) continue;
          openings.push([park.points]);
          openingTop = height;
        }
      }
      openingTop = Math.min(height, openingTop);
      const parts = [];
      if (openings.length && openingTop > minHeight) {
        for (const polygon of polygonClipping.difference([points], ...openings)) {
          const lower = new THREE.Shape(polygon[0].map(([x, y]) => new THREE.Vector2(x, -y)));
          for (const ring of polygon.slice(1))
            lower.holes.push(new THREE.Path(ring.map(([x, y]) => new THREE.Vector2(x, -y))));
          parts.push({ shape: lower, bottom: minHeight, depth: openingTop - minHeight });
        }
      }
      if (height > openingTop) parts.push({ shape, bottom: openingTop, depth: height - openingTop });
      const buildingType = metadata?.building_type;
      const buildingUse = metadata?.building_use;
      const tint = BUILDING_TINTS[buildingType] ?? BUILDING_TINTS[buildingUse];
      const color = landmark ? new THREE.Color("#81a4ac") : tint
        ? new THREE.Color(tint).offsetHSL(0, 0, (seed % 5 - 2) * .012)
        : new THREE.Color().setHSL(0.10 + seed % 8 / 100, 0.10, 0.54 + seed % 8 / 100);
      for (const part of parts) {
        const geometry = new THREE.ExtrudeGeometry(part.shape, { depth: part.depth, bevelEnabled: false, steps: 1 });
        geometry.rotateX(-Math.PI / 2);
        const position = geometry.getAttribute("position"), normal = geometry.getAttribute("normal");
        for (let i = 0; i < position.count; i++) {
          tile.positions.push(position.getX(i), position.getY(i) + base + part.bottom + 0.05, position.getZ(i));
          tile.normals.push(normal.getX(i), normal.getY(i), normal.getZ(i));
          const shade = normal.getY(i) > 0.5 ? 0.7
            : 0.7 + 0.3 * Math.max(0, -normal.getX(i) * 0.5 - normal.getZ(i) * 0.8);
          tile.colors.push(color.r * shade, color.g * shade, color.b * shade);
          tile.uvs.push(normal.getY(i) > 0.5 ? 0.03
            : (Math.abs(normal.getX(i)) > 0.5 ? position.getZ(i) : position.getX(i)) / WORLD_SCALE.facadeBayWidth,
          normal.getY(i) > 0.5 ? 0.03 : (position.getY(i) + part.bottom - minHeight) / WORLD_SCALE.floorHeight);
        }
        geometry.dispose();
      }
      if ((seed % 3 === 0 || metadata?.osm_way === 102411832) && height - openingTop >= 7) {
        let best = null;
        for (let i = 0; i < points.length; i++) {
          const a = points[i], b = points[(i + 1) % points.length];
          const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
          if (length < 4) continue;
          const center = { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 };
          for (const edge of this.groundMap.roadIndex.query([center.x - 25, center.y - 25, center.x + 25, center.y + 25])) {
            if (!isSurfaceRoad(edge)) continue;
            const nearest = project(center, this.nodes[edge.a], this.nodes[edge.b]);
            if (nearest.distance > 25 || (best && nearest.distance >= best.distance)) continue;
            best = { center, dx: dx / length, dy: dy / length, length, nearest, distance: nearest.distance, edge };
          }
        }
        if (best) {
          const index = metadata?.osm_way === 102411832 ? 4 : seed % 4;
          const uvs = [[index / 5, 0], [(index + 1) / 5, 0], [(index + 1) / 5, 1], [index / 5, 1]];
          const reverseUvs = [[(index + 1) / 5, 0], [index / 5, 0], [index / 5, 1], [(index + 1) / 5, 1]];
          const direction = Math.sign(-best.dy * (best.nearest.x - best.center.x)
            + best.dx * (best.nearest.y - best.center.y));
          let projected = false;
          if (!landmark && seed % 2 === 0) {
            const nx = -best.dy * direction, ny = best.dx * direction;
            const depth = Math.min(3, best.distance - roadWidth(this.data.driving, best.edge) / 2 - .6);
            const tip = { x: best.center.x + nx * depth, y: best.center.y + ny * depth };
            const nearby = this.groundMap.roadIndex.query([tip.x - 20, tip.y - 20, tip.x + 20, tip.y + 20]);
            if (direction && depth >= 1.2 && nearby.every(edge => !isSurfaceRoad(edge)
                || project(tip, this.nodes[edge.a], this.nodes[edge.b]).distance
                  > roadWidth(this.data.driving, edge) / 2 + .5)) {
              const bottom = base + openingTop + 5.1;
              const top = Math.min(bottom + 3.2, (metadata?.base ?? 0) + height - .3);
              const corner = (distance, y) => [best.center.x + nx * distance, y, best.center.y + ny * distance];
              const points = [corner(.08, bottom), corner(depth, bottom), corner(depth, top), corner(.08, top)];
              for (const i of [0, 1, 2, 0, 2, 3]) {
                tile.adverts.push(...points[i]); tile.advertUvs.push(...uvs[i]);
              }
              for (const i of [0, 2, 1, 0, 3, 2]) {
                tile.adverts.push(...points[i]); tile.advertUvs.push(...reverseUvs[i]);
              }
              projected = true;
            }
          }
          if (!projected) {
            const width = Math.min(metadata?.osm_way === 102411832 ? 8 : 3.5, best.length - .5);
            const bottom = base + openingTop + 3.2, top = Math.min(bottom + 3.2, base + height - .3);
            const offsetX = best.distance ? (best.nearest.x - best.center.x) / best.distance * .08 : 0;
            const offsetY = best.distance ? (best.nearest.y - best.center.y) / best.distance * .08 : 0;
            const corner = (side, y) => [best.center.x + offsetX + best.dx * width * side,
              y, best.center.y + offsetY + best.dy * width * side];
            const points = [corner(-.5, bottom), corner(.5, bottom), corner(.5, top), corner(-.5, top)];
            for (const i of direction < 0 ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3]) {
              tile.adverts.push(...points[i]); tile.advertUvs.push(...(direction < 0 ? reverseUvs[i] : uvs[i]));
            }
          }
        }
      }
      yield;
    }
    for (const tile of tiles.values()) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(tile.positions, 3));
      geometry.setAttribute("normal", new THREE.Float32BufferAttribute(tile.normals, 3));
      geometry.setAttribute("color", new THREE.Float32BufferAttribute(tile.colors, 3));
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(tile.uvs, 2));
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, tile.landmark ? this.landmarkMaterial : this.cityMaterial);
      mesh.name = "building-block";
      mesh.userData.cityLandmark = tile.landmark;
      this.scene.add(mesh);
      meshes.push(mesh);
      if (tile.adverts.length) {
        const advertGeometry = new THREE.BufferGeometry();
        advertGeometry.setAttribute("position", new THREE.Float32BufferAttribute(tile.adverts, 3));
        advertGeometry.setAttribute("uv", new THREE.Float32BufferAttribute(tile.advertUvs, 2));
        advertGeometry.computeBoundingSphere();
        const advert = new THREE.Mesh(advertGeometry, this.advertMaterial);
        advert.name = "city-advertisements";
        advert.userData.cityAdvertisement = true;
        this.scene.add(advert);
        meshes.push(advert);
      }
    }
    for (const [positions, material, name] of [[posts, this.roofPostMaterial, "canopy-pillars"],
      [parkPosts, this.roofPostMaterial, "park-pillars"],
      [cover, this.roofMaterial, "canopy-cover"]]) {
      if (!positions.length) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = name;
      mesh.userData.cityCanopy = true;
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
        if ((shape.kind !== "building" && shape.kind !== "roof"
            && !(shape.kind === "park" && Number(shape.layer) > 0)) || shape.points.length < 3) continue;
        const cx = shape.points.reduce((sum, p) => sum + p[0], 0) / shape.points.length;
        const cy = shape.points.reduce((sum, p) => sum + p[1], 0) / shape.points.length;
        const radius = Math.max(...shape.points.map(([x, y]) => Math.hypot(x - cx, y - cy)));
        if (Math.hypot(cx - this.camera.x, cy - this.camera.y) > 512 + radius) continue;
        const key = `${Math.floor(cx / 60)}:${Math.floor(cy / 60)}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(shape);
      }
      const parks = this.data.backdrop.filter(shape => shape.kind === "park" && Number(shape.layer) > 0);
      const signatureFor = shapes => {
        const relevant = parks.filter(park => shapes.some(shape => {
          if (shape.kind !== "building" || !(Number(shape.building?.building_layer) > 0)) return false;
          const a = pointBounds(shape.points), b = pointBounds(park.points);
          return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
        }));
        return `${shapes.map(shape => shape.id).join(",")}|${relevant.map(park => park.id).join(",")}`;
      };
      this.cityTask = null;
      this.cityQueue = [];
      for (const [key, group] of this.cityGroups) {
        const signature = groups.has(key) ? signatureFor(groups.get(key)) : null;
        if (signature !== group.signature) {
          for (const mesh of group.meshes) { this.scene.remove(mesh); mesh.geometry.dispose(); }
          this.cityGroups.delete(key);
        }
      }
      for (const [key, shapes] of groups) {
        if (!this.cityGroups.has(key)) this.cityQueue.push({ key, shapes, signature: signatureFor(shapes) });
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
        this.cityGroups.set(group.key, { signature: group.signature,
          meshes: next.value, count: group.shapes.filter(shape => shape.kind === "building").length });
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
    this.propBox = new THREE.BoxGeometry(1, 1, 1);
    this.propBall = new THREE.SphereGeometry(1, 6, 6);
    this.propWheel = new THREE.TorusGeometry(1, .1, 4, 10);
    this.propMaterials = Object.fromEntries(Object.entries({
      luggage: "#bb8556", handbag: "#c48bb3", backpack: "#729b80",
      frame: "#91a4aa", tire: "#253039", dog: "#a9794f", cat: "#cfb4a1", bird: "#f5c65a",
    }).map(([key, color]) => [key, new THREE.MeshStandardMaterial({ color })]));
    this.resources.push(this.propBox, this.propBall, this.propWheel, ...Object.values(this.propMaterials));
    this.door = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.8, 0.08),
      new THREE.MeshStandardMaterial({ color: "#f7cc65" }));
    this.door.position.set(-0.4, 0.9, (this.data.driving.taxi_width ?? 2.6) / 2 + 0.45);
    this.door.rotation.y = Math.PI / 3;
    this.door.visible = false;
    this.taxi.add(this.door);
  }
  citizenAccessories(traits) {
    const group = new THREE.Group(), wheels = [], animalLegs = [];
    const box = (parent, material, position, scale, geometry = this.propBox) => {
      const mesh = new THREE.Mesh(geometry, this.propMaterials[material]);
      mesh.position.set(...position); mesh.scale.set(...scale); parent.add(mesh);
      return mesh;
    };
    const wheel = (x, y, z, radius) => {
      const rolling = new THREE.Group();
      rolling.position.set(x, y, z);
      box(rolling, "tire", [0, 0, 0], [radius, radius, radius], this.propWheel);
      box(rolling, "frame", [0, 0, 0], [radius * 1.8, .025, .025]);
      group.add(rolling); wheels.push(rolling);
    };
    if (traits.wheelchair) {
      box(group, "backpack", [0, .6, 0], [.65, .12, .7]);
      box(group, "backpack", [-.3, .95, 0], [.1, .65, .7]);
      for (const z of [-.48, .48]) {
        wheel(-.15, .43, z, .4); wheel(.6, .14, z, .12);
        box(group, "frame", [.1, .85, z], [.7, .04, .04]);
        box(group, "frame", [-.3, .65, z], [.04, 1, .04]);
      }
      box(group, "frame", [.6, .22, 0], [.3, .05, .65]);
    }
    for (let i = 0; i < (traits.luggage ?? 0); i++) {
      const z = i === 0 ? -.75 : .75;
      box(group, "luggage", [-.2, .45, z], [.38, .75, .35]);
      box(group, "frame", [-.2, .95, z], [.04, .3, .04]);
      box(group, "frame", [-.2, 1.1, z], [.24, .04, .04]);
      wheel(-.2, .1, z - .18, .075);
      wheel(-.2, .1, z + .18, .075);
    }
    if (traits.bag === "backpack") {
      box(group, "backpack", [-.3, traits.wheelchair ? .9 : 1, 0], [.3, .55, .45]);
      for (const z of [-.2, .2]) box(group, "frame", [0, 1.1, z], [.5, .04, .04]);
    } else if (traits.bag === "handbag") {
      const x = traits.luggage === 2 ? .25 : .1;
      box(group, "handbag", [x, .65, .65], [.3, .3, .18]);
      box(group, "frame", [x, .88, .65], [.2, .18, .025], this.propWheel);
    }
    if (traits.animal === "bird") {
      const cage = new THREE.Group();
      cage.position.set(traits.luggage === 2 ? .25 : .1, .6, traits.bag === "handbag" ? 1.1 : .8);
      group.add(cage);
      for (const y of [0, .5]) box(cage, "frame", [0, y, 0], [.42, .03, .42]);
      for (const offset of [-.2, 0, .2]) for (const side of [-.2, .2]) {
        box(cage, "frame", [offset, .25, side], [.015, .5, .015]);
        box(cage, "frame", [side, .25, offset], [.015, .5, .015]);
      }
      box(cage, "frame", [0, .1, 0], [.4, .025, .025]);
      box(cage, "bird", [0, .22, 0], [.1, .13, .08], this.propBall);
      box(cage, "bird", [.06, .34, 0], [.07, .07, .07], this.propBall);
      box(cage, "luggage", [.14, .34, 0], [.08, .025, .025]);
      box(cage, "frame", [0, .58, 0], [.12, .08, .02], this.propWheel);
    } else if (traits.animal) {
      const animal = new THREE.Group(), cat = traits.animal === "cat";
      animal.position.set(-.1, 0, 1.15); group.add(animal);
      if (cat) animal.scale.setScalar(.75);
      box(animal, traits.animal, [0, .35, 0], [.65, .28, .26]);
      box(animal, traits.animal, [.35, .55, 0], [.18, .18, .16], this.propBall);
      box(animal, traits.animal, [.5, .5, 0], [cat ? .08 : .2, .1, .14]);
      for (const z of [-.12, .12]) {
        const ear = box(animal, traits.animal, [.3, cat ? .75 : .55, z], [.08, .22, .07]);
        ear.rotation.z = cat ? -.2 : .3;
        for (const x of [-.23, .23]) {
          animalLegs.push(box(animal, traits.animal, [x, .15, z], [.065, .3, .065]));
        }
      }
      const tail = box(animal, traits.animal, [-.4, cat ? .5 : .4, 0], [.06, cat ? .4 : .25, .06]);
      tail.rotation.z = cat ? -.3 : -.9;
      const leash = box(group, "frame", [0, .7, .75], [.015, .015, .8]);
      leash.rotation.x = .7;
    }
    return { group, wheels, animalLegs };
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
      this.people.push({ group, body, head, arm, otherArm, legs, bubble });
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
      const traits = person.traits ?? {};
      const appearance = `${traits.luggage ?? 0}:${traits.bag ?? ""}:${traits.animal ?? ""}:${Boolean(traits.wheelchair)}`;
      if (item.appearance !== appearance) {
        if (item.accessories) item.group.remove(item.accessories.group);
        item.accessories = this.citizenAccessories(traits);
        item.group.add(item.accessories.group);
        item.appearance = appearance;
      }
      item.body.position.y = traits.wheelchair ? .9 : 1;
      item.head.position.y = traits.wheelchair ? 1.5 : 1.65;
      item.body.material = person.hailing ? this.hailMaterial : this.personMaterial;
      item.arm.position.set(0, person.hailing ? 1.7 : 1, 0.5);
      const walking = person.walking ?? !person.hailing;
      const swing = walking ? Math.sin(state.elapsed * (person.walkSpeed ?? 1.1)
        * (traits.wheelchair ? 4 : 7) + index) * (traits.wheelchair ? .25 : .45) : 0;
      item.arm.rotation.x = person.hailing ? -.7 + Math.sin(state.elapsed * 5 + index) * .25 : 0;
      item.arm.rotation.z = person.hailing ? 0 : -swing;
      item.otherArm.rotation.z = swing;
      item.legs.forEach((leg, side) => {
        leg.position.set(traits.wheelchair ? .35 : 0, traits.wheelchair ? .5 : .35, side ? .16 : -.16);
        leg.rotation.z = traits.wheelchair ? Math.PI / 2 : side ? swing : -swing;
      });
      item.accessories.wheels.forEach(wheel => {
        if (walking) wheel.rotation.z -= delta * (person.walkSpeed ?? 1.1) / .4;
      });
      item.accessories.animalLegs.forEach((leg, side) => {
        leg.rotation.z = side % 2 ? swing : -swing;
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
  trafficGeometry(edges, height) {
    const positions = [], coordinates = [], coverage = [];
    for (const edge of edges) {
      const a = this.nodes[edge.a], b = this.nodes[edge.b];
      const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
      if (!length) continue;
      const width = roadWidth(this.data.driving, edge);
      const nx = -dy / length, ny = dx / length;
      const vertex = (point, side) => {
        const x = point[0] + nx * side, y = point[1] + ny * side;
        positions.push(x, surfacePose(this, edge, { x, y }, 0).height + height + .08, y);
        coordinates.push(((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length, side);
        coverage.push(1, 1, 1);
      };
      for (const [first, last] of roadMarkingRanges(this.data, edge)) {
        const from = [a[0] + dx * first, a[1] + dy * first], to = [a[0] + dx * last, a[1] + dy * last];
        for (const [start, end] of surfaceSegments(this, edge, from, to)) {
          vertex(start, -width / 2); vertex(end, -width / 2); vertex(end, width / 2);
          vertex(start, -width / 2); vertex(end, width / 2); vertex(start, width / 2);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("trafficCoord", new THREE.Float32BufferAttribute(coordinates, 2));
    geometry.setAttribute("boundaryCoord", new THREE.Float32BufferAttribute(coverage, 3));
    return geometry;
  }
  trafficMaterial(color) {
    const material = this.smoothLineMaterial(color);
    const compile = material.onBeforeCompile;
    material.onBeforeCompile = shader => {
      compile(shader);
      shader.vertexShader = `attribute vec2 trafficCoord;\nvarying vec2 vTrafficCoord;\n${shader.vertexShader}`
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvTrafficCoord = trafficCoord;");
      shader.fragmentShader = `varying vec2 vTrafficCoord;\n${shader.fragmentShader}`
        .replace("#include <opaque_fragment>", `
          float chevron = abs(mod(vTrafficCoord.x + abs(vTrafficCoord.y) * 0.8 + 4.0, 8.0) - 4.0);
          float hatch = abs(mod(vTrafficCoord.x + vTrafficCoord.y * 1.1 + 1.0, 2.0) - 1.0);
          float mark = 1.0 - smoothstep(0.13, 0.13 + max(fwidth(chevron), 0.001), chevron);
          float stripe = 1.0 - smoothstep(0.07, 0.07 + max(fwidth(hatch), 0.001), hatch);
          diffuseColor.a *= max(mark, 0.08 + stripe * 0.14);
          #include <opaque_fragment>`);
    };
    return material;
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
      const mesh = new THREE.Mesh(geometry, name === "traffic" ? this.trafficMaterial(color) : this.smoothLineMaterial(color));
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
      const edges = ids.map(id => this.edges.get(id));
      replaceLayer(name, ids, color, height, ids.length
        ? name === "traffic" ? this.trafficGeometry(edges, height) : this.ribbonGeometry(edges, width, height)
        : null);
    };
    const closed = new Set(state.closed);
    updateLayer("closed", [...this.edges.values()].filter(e => closed.has(e.way)).map(e => e.id), "#ed8879", 3, 0.12);
    const seenTraffic = new Set();
    const traffic = [...this.edges.values()].filter(edge => {
      if (closed.has(edge.way) || !state.traffic[edge.way]) return false;
      const key = `${edge.way}:${[edge.a, edge.b].sort().join(":")}`;
      if (seenTraffic.has(key)) return false;
      seenTraffic.add(key);
      return true;
    });
    updateLayer("traffic", traffic.map(edge => edge.id), "#ff975e", 0, 0.14);
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
  clearSkids() {
    this.skids.length = 0;
    this.skidStart = null;
    this.skidMesh.geometry.setDrawRange(0, 0);
  }
  recordSkid(before, car, skidding) {
    if (!skidding || before.edge !== car.edge) {
      this.skidStart = null;
      return;
    }
    const saved = this.skidStart;
    const start = saved?.edge === before.edge && Math.hypot(saved.x - before.x, saved.y - before.y) < .35
      ? saved : before;
    if (Math.hypot(car.x - start.x, car.y - start.y) < .35) {
      this.skidStart = start;
      return;
    }
    const vertices = [];
    const edge = this.edges.get(car.edge);
    const halfTrack = (this.data.driving.taxi_width - WORLD_SCALE.wheelWidth) / 2;
    for (const side of [-1, 1]) {
      const corners = [start, car].flatMap(pose => [-.09, .09].map(offset => {
        const lateral = side * halfTrack + offset;
        const rear = this.data.driving.taxi_length * .32;
        const x = pose.x - Math.cos(pose.heading) * rear - Math.sin(pose.heading) * lateral;
        const y = pose.y - Math.sin(pose.heading) * rear + Math.cos(pose.heading) * lateral;
        return [x, surfacePose(this, edge, { x, y }, pose.heading).height + .12, y];
      }));
      for (const index of [0, 1, 2, 1, 3, 2]) vertices.push(...corners[index]);
    }
    this.skids.push({ vertices, expires: performance.now() / 1000 + SKID_LIFETIME + SKID_FADE_TIME });
    this.skidStart = { ...car };
  }
  updateSkids(now) {
    while (this.skids[0]?.expires <= now) this.skids.shift();
    const geometry = this.skidMesh.geometry;
    if (this.skids.length * 12 > geometry.attributes.position.count) {
      const capacity = Math.max(this.skids.length * 12, geometry.attributes.position.count * 2);
      geometry.dispose();
      geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage));
    }
    const { position, color } = geometry.attributes;
    for (const [index, skid] of this.skids.entries()) {
      position.array.set(skid.vertices, index * 36);
      const alpha = .62 * Math.min(1, (skid.expires - now) / SKID_FADE_TIME);
      for (let vertex = index * 12; vertex < (index + 1) * 12; vertex++) color.setXYZW(vertex, .025, .02, .018, alpha);
    }
    geometry.setDrawRange(0, this.skids.length * 12);
    if (this.skids.length) position.needsUpdate = color.needsUpdate = true;
  }
  render(car, state, lang, approach, previewExit = null, preparing = false) {
    // Use the animation-frame time the taxi was stepped with; performance.now() jitters with prior work.
    const now = document.timeline?.currentTime ?? performance.now();
    const dt = this.lastRender ? Math.min((now - this.lastRender) / 1000, 0.1) : 1;
    this.updateCameraHeading(car.heading, dt);
    if (!this.cameraDrag) {
      const remaining = this.reducedMotion ? 0 : Math.exp(-5 * dt);
      this.orbitYaw *= remaining;
      this.orbitPitch = CHASE_PITCH + (this.orbitPitch - CHASE_PITCH) * remaining;
    }
    this.updateSkids(performance.now() / 1000);
    this.camera.x = car.x; this.camera.y = car.y;
    if (this.roadBuildTask) {
      const deadline = performance.now() + (preparing ? 100 : 6);
      let steps = 0;
      try {
        while (performance.now() < deadline && steps++ < (preparing ? 1024 : 48)) {
          if (this.roadBuildTask.next().done) { this.roadBuildTask = null; break; }
        }
      } catch (error) {
        console.error("3D road construction failed", error);
        this.canvas.dispatchEvent(new CustomEvent("renderererror", { detail: error.message }));
        return;
      }
    }
    this.updateStreamedCity();
    this.ground.material.map = this.overview ? this.overviewTexture : this.chaseTexture;
    this.ground.visible = this.overview || !this.elevation;
    for (const tile of this.terrainTiles) tile.visible = !this.overview;
    this.updateGroundDetail(car);
    this.boundaryOutline.visible = true;
    this.directionLines.visible = !this.overview && !this.elevation;
    const pose = surfacePose(this, this.edges.get(car.edge), car, car.heading);
    const position = new THREE.Vector3(car.x, pose.height + (this.elevation ? .08 : 0), car.y);
    for (const tile of this.boundaryOutline.children) {
      const sphere = tile.geometry.boundingSphere;
      tile.visible = this.overview || sphere.center.distanceTo(position) < 240 + sphere.radius;
    }
    this.taxi.position.copy(position);
    this.taxi.rotation.set(0, -car.heading, pose.pitch, "YXZ");
    const distance = Math.min(150 * 5 / 7, DEFAULT_CHASE_DISTANCE * 1.65 / this.zoom) * this.chaseDistanceScale;
    const target = position.clone();
    target.y = pose.height + 1;
    const inTunnel = this.elevation && hasTunnelShell(this.edges.get(car.edge));
    const heading = this.cameraHeading + this.orbitYaw;
    const radius = inTunnel ? Math.min(5.9, 3.3 / Math.sin(this.orbitPitch)) : distance * Math.hypot(.9, .6);
    const rise = radius * Math.sin(this.orbitPitch);
    const horizontal = Math.min(radius * Math.cos(this.orbitPitch),
      inTunnel ? (rise - 1.4) / MIN_CHASE_GRADE : Infinity);
    const eye = new THREE.Vector3(position.x - Math.cos(heading) * horizontal,
      position.y + rise, position.z - Math.sin(heading) * horizontal);
    if (inTunnel && !this.overview) target.set(position.x, position.y + 1.4, position.z);
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
    const smoothCamera = this.cameraReady && !inTunnel && !this.reducedMotion && this.cameraSmoothness > 0;
    this.chaseCameraSmoothed = smoothCamera && !this.overview;
    this.lens.position.lerp(eye, smoothCamera ? positionEase : 1);
    this.lookAt.lerp(target, this.overview && smoothCamera ? targetEase : 1);
    if (!this.overview && !inTunnel) {
      const eye = this.lens.position;
      eye.y = Math.max(eye.y, this.lookAt.y + Math.hypot(eye.x - this.lookAt.x, eye.z - this.lookAt.z) * MIN_CHASE_GRADE);
    }
    this.lens.lookAt(this.lookAt);
    const viewOffset = innerHeight * 0.04;
    this.lens.setViewOffset(innerWidth, innerHeight, 0, viewOffset, innerWidth, innerHeight);
    if (!this.overview && Number.isFinite(this.dashboardTop)) {
      this.lens.updateMatrixWorld();
      this.taxiBounds ??= new THREE.Box3();
      this.taxiProjection ??= new THREE.Vector3();
      const bounds = this.taxiBounds.setFromObject(this.taxi);
      let bottom = -Infinity;
      if (!bounds.isEmpty()) {
        for (let corner = 0; corner < 8; corner++) {
          const point = this.taxiProjection.set(
            corner & 1 ? bounds.max.x : bounds.min.x,
            corner & 2 ? bounds.max.y : bounds.min.y,
            corner & 4 ? bounds.max.z : bounds.min.z,
          ).project(this.lens);
          bottom = Math.max(bottom, (1 - point.y) * innerHeight / 2);
        }
        const adjustment = Math.max(0, bottom + 8 - this.dashboardTop);
        if (adjustment) this.lens.setViewOffset(innerWidth, innerHeight, 0, viewOffset + adjustment, innerWidth, innerHeight);
      }
    }
    this.cameraReady = true;
    this.camera.x = car.x; this.camera.y = car.y;
    // Fade entire small blocks intersecting the camera sightline, keeping the taxi visible.
    const line = new THREE.Line3(this.lens.position, position.clone().add(new THREE.Vector3(0, 1, 0)));
    const closest = new THREE.Vector3();
    const sightDirection = line.delta(new THREE.Vector3());
    const raycaster = this.overview ? null
      : new THREE.Raycaster(line.start, sightDirection.clone().normalize(), 0, sightDirection.length());
    for (const building of this.buildings) {
      const sphere = building.geometry.boundingSphere;
      building.visible = this.overview || sphere.center.distanceTo(position) < 220 + sphere.radius;
      if (building.name === "elevated-park") {
        building.material = raycaster && building.visible && raycaster.intersectObject(building).length
          ? this.fadedParkMaterial : this.parkMaterial;
        continue;
      }
      if (!building.visible || building.userData.cityCanopy) continue;
      line.closestPointToPoint(sphere.center, true, closest);
      const obstructs = closest.distanceTo(sphere.center) < sphere.radius + 6
        && sphere.center.distanceTo(position) < distance + sphere.radius;
      building.material = building.userData.cityAdvertisement
        ? (!this.overview && obstructs ? this.fadedAdvertMaterial : this.advertMaterial)
        : building.userData.cityLandmark
          ? (!this.overview && obstructs ? this.fadedLandmarkMaterial : this.landmarkMaterial)
          : (!this.overview && obstructs ? this.fadedCityMaterial : this.cityMaterial);
    }
    this.updateRoadFades(raycaster);
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
    const edge = this.edges.get(car.edge);
    const segment = edge && this.nodes[edge.a] && this.nodes[edge.b]
      ? [this.nodes[edge.a], this.nodes[edge.b]] : [[car.x, car.y], [car.x, car.y]];
    const labels = this.mapLabelIndex?.query(pointBounds(segment)) ?? this.data.mapLabels;
    this.roadLabel.textContent = roadAreaLabel(edge, segment, labels, lang);
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
    this.cameraEvents.abort();
    this.unsubscribeStream?.();
    this.detailWorker?.terminate();
    window.removeEventListener("resize", this.onResize);
    this.label?.remove();
    this.roadLabel?.remove();
    const geometries = new Set(), materials = new Set();
    this.scene.traverse(object => {
      if (object.geometry) geometries.add(object.geometry);
      if (object.material) for (const material of [].concat(object.material)) materials.add(material);
    });
    this.boundaryScene.traverse(object => {
      if (object.geometry) geometries.add(object.geometry);
      if (object.material) for (const material of [].concat(object.material)) materials.add(material);
    });
    this.bubbleScene.clear();
    geometries.forEach(geometry => geometry.dispose());
    if (this.cityMaterial) materials.add(this.cityMaterial);
    if (this.fadedCityMaterial) materials.add(this.fadedCityMaterial);
    if (this.landmarkMaterial) materials.add(this.landmarkMaterial);
    if (this.fadedLandmarkMaterial) materials.add(this.fadedLandmarkMaterial);
    if (this.advertMaterial) materials.add(this.advertMaterial);
    if (this.fadedAdvertMaterial) materials.add(this.fadedAdvertMaterial);
    materials.forEach(material => material.dispose());
    this.resources.forEach(resource => resource.dispose());
    this.renderer.dispose();
  }
}
