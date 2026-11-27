// Throwaway prototype: compare three Olympian Park support layouts with ?variant=A, B or C.
import * as THREE from "./vendor/three/three.module.min.js";
import polygonClipping from "./vendor/polygon-clipping/polygon-clipping.mjs";
import { surfacePose, terrainHeight, isElevatedRoad } from "./elevation.mjs?v=tunnel-clearance-1";
import { roadWidth } from "./road-width.mjs";

const variants = [
  { key: "A", name: "Perimeter columns", description: "Columns follow the park edge, leaving the interior open." },
  { key: "B", name: "Regular grid", description: "An even grid supports the slab; columns are omitted where roads or buildings occupy the space." },
  { key: "C", name: "Road-side supports", description: "Columns cluster beside roads, with beams spanning across the road." },
];
const canvas = document.querySelector("#scene");
const status = document.querySelector("#status");
const error = document.querySelector("#error");
const clearance = 5.2;
const pillarSize = 1.4;

function inPolygon(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x, y] = ring[i], [px, py] = ring[j];
    if ((y > point[1]) !== (py > point[1])
        && point[0] < (px - x) * (point[1] - y) / (py - y) + x) inside = !inside;
  }
  return inside;
}

function distanceToSegment(point, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy;
  if (!length2) return Math.hypot(point[0] - a[0], point[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2));
  return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy);
}

function footprint(edge, nodes, driving) {
  const a = nodes[edge.a], b = nodes[edge.b];
  const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
  if (!length) return null;
  const r = roadWidth(driving, edge) / 2 + .05, nx = -dy / length * r, ny = dx / length * r;
  const ex = dx / length * r, ey = dy / length * r;
  const points = [[a[0] - ex - nx, a[1] - ey - ny], [a[0] - ex + nx, a[1] - ey + ny],
    [b[0] + ex + nx, b[1] + ey + ny], [b[0] + ex - nx, b[1] + ey - ny]];
  return [...points, points[0]];
}

function shapeFromPolygon(polygon, center) {
  const path = ring => ring.map(([x, y]) => new THREE.Vector2(x - center[0], -(y - center[1])));
  const shape = new THREE.Shape(path(polygon[0]));
  for (const ring of polygon.slice(1)) shape.holes.push(new THREE.Path(path(ring)));
  return shape;
}

function extrude(scene, polygon, center, bottom, depth, material) {
  if (depth <= 0) return;
  const geometry = new THREE.ExtrudeGeometry(shapeFromPolygon(polygon, center),
    { depth, bevelEnabled: false });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, bottom, 0);
  scene.add(new THREE.Mesh(geometry, material));
}

function box(scene, x, y, z, width, height, depth, material, angle = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
  mesh.position.set(x, y, z);
  mesh.rotation.y = angle;
  scene.add(mesh);
}

async function main() {
  const response = await fetch("/api/map");
  if (!response.ok) throw new Error(`Map request failed: HTTP ${response.status}`);
  const data = await response.json();
  const park = data.backdrop.find(item => item.osm_way === 185084371);
  if (!park || !data.elevation) throw new Error("Olympian Park or elevation data is missing.");
  const xs = park.points.map(p => p[0]), ys = park.points.map(p => p[1]);
  const bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const center = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
  const near = ([x, y]) => x >= bounds[0] - 45 && x <= bounds[2] + 45
    && y >= bounds[1] - 45 && y <= bounds[3] + 45;
  const metadata = new Map(data.elevation.buildings.map(item => [item.index, item]));
  const buildings = data.backdrop.flatMap((item, index) =>
    item.kind === "building" && item.points.some(near) ? [{ ...item, metadata: metadata.get(index) }] : []);
  const seen = new Set();
  const roads = data.edges.filter(edge => {
    const key = `${edge.way}:${[edge.a, edge.b].sort().join(":")}`;
    if (seen.has(key) || (!near(data.nodes[edge.a]) && !near(data.nodes[edge.b]))) return false;
    seen.add(key);
    return true;
  }).map(edge => ({ edge, a: data.nodes[edge.a], b: data.nodes[edge.b],
    width: roadWidth(data.driving, edge), polygon: footprint(edge, data.nodes, data.driving) }))
    .filter(road => road.polygon);
  const groundRoads = roads.filter(road => !isElevatedRoad(road.edge)
    && (road.edge.tunnel === "no" || road.edge.tunnel === "building_passage"));
  const roadContext = { nodes: data.nodes, elevation: data.elevation };
  let slabBottom = Math.max(...park.points.map(([x, y]) => terrainHeight(data.elevation, x, y)));
  for (const road of groundRoads) {
    const overlap = polygonClipping.intersection([park.points], [road.polygon]);
    for (const polygon of overlap) for (const ring of polygon) for (const [x, y] of ring)
      slabBottom = Math.max(slabBottom, surfacePose(roadContext, road.edge, { x, y }, 0).height);
  }
  slabBottom += clearance + .4;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor("#15282d");
  const scene = new THREE.Scene();
  const buildingGroup = new THREE.Group();
  buildingGroup.visible = false;
  scene.add(buildingGroup);
  const camera = new THREE.PerspectiveCamera(42, 1, .1, 2000);
  scene.add(new THREE.HemisphereLight("#e1f4ef", "#40534e", 2));
  const sun = new THREE.DirectionalLight("#fff1d3", 2);
  sun.position.set(-100, 220, 100);
  scene.add(sun);
  const materials = {
    ground: new THREE.MeshLambertMaterial({ color: "#354b43" }),
    park: new THREE.MeshLambertMaterial({ color: "#739d72" }),
    building: new THREE.MeshLambertMaterial({ color: "#d7c6a4", transparent: true, opacity: .48, depthWrite: false }),
    road: new THREE.MeshLambertMaterial({ color: "#5d737c" }),
    support: new THREE.MeshLambertMaterial({ color: "#f3bd55" }),
  };
  const groundHeight = terrainHeight(data.elevation, ...center);
  const floorHeight = Math.min(groundHeight, ...roads.flatMap(road => [road.a, road.b].map(([x, y]) =>
    surfacePose(roadContext, road.edge, { x, y }, 0).height)));
  box(scene, 0, floorHeight - .35, 0, bounds[2] - bounds[0] + 100, .5,
    bounds[3] - bounds[1] + 100, materials.ground);
  for (const road of roads) {
    const dx = road.b[0] - road.a[0], dy = road.b[1] - road.a[1], length = Math.hypot(dx, dy);
    const aHeight = surfacePose(roadContext, road.edge, { x: road.a[0], y: road.a[1] }, 0).height;
    const bHeight = surfacePose(roadContext, road.edge, { x: road.b[0], y: road.b[1] }, 0).height;
    const geometry = new THREE.BufferGeometry();
    const nx = -dy / length * road.width / 2, ny = dx / length * road.width / 2;
    const point = (p, side, height) => [p[0] + nx * side - center[0], height + .08,
      p[1] + ny * side - center[1]];
    const vertices = [point(road.a, -1, aHeight), point(road.b, -1, bHeight), point(road.b, 1, bHeight),
      point(road.a, -1, aHeight), point(road.b, 1, bHeight), point(road.a, 1, aHeight)];
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices.flat(), 3));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, materials.road);
    mesh.material.side = THREE.DoubleSide;
    scene.add(mesh);
  }
  extrude(scene, [park.points], center, slabBottom, .8, materials.park);
  for (const building of buildings) {
    const info = building.metadata;
    const base = info?.base ?? groundHeight, height = info?.height ?? 18, bottom = info?.min_height ?? 0;
    building.openedUnderPark = base + height <= slabBottom + .8;
    const footprint = building.openedUnderPark
      ? polygonClipping.difference([building.points], [park.points]) : [[building.points]];
    const overlaps = groundRoads.filter(road =>
      polygonClipping.intersection([building.points], [road.polygon]).length);
    let openingTop = base + bottom;
    for (const road of overlaps) {
      const overlap = polygonClipping.intersection([building.points], [road.polygon]);
      for (const polygon of overlap) for (const ring of polygon) for (const [x, y] of ring)
        openingTop = Math.max(openingTop, surfacePose(roadContext, road.edge, { x, y }, 0).height + clearance);
    }
    openingTop = Math.min(base + height, openingTop);
    if (overlaps.length && openingTop > base + bottom && footprint.length) {
      const lower = polygonClipping.difference(footprint, ...overlaps.map(road => [road.polygon]));
      for (const polygon of lower) extrude(buildingGroup, polygon, center, base + bottom, openingTop - base - bottom, materials.building);
    }
    for (const polygon of footprint) extrude(buildingGroup, polygon, center, openingTop, base + height - openingTop, materials.building);
  }

  const supportGroup = new THREE.Group();
  scene.add(supportGroup);
  function safe(point) {
    const r = pillarSize / Math.sqrt(2) + .5;
    return [[-r, -r], [-r, r], [r, -r], [r, r]].every(([x, y]) =>
      inPolygon([point[0] + x, point[1] + y], park.points))
      && !buildings.some(building => !building.openedUnderPark && (inPolygon(point, building.points)
        || building.points.some((a, i) => distanceToSegment(point, a,
          building.points[(i + 1) % building.points.length]) < r)))
      && groundRoads.every(road => distanceToSegment(point, road.a, road.b) > road.width / 2 + r);
  }
  function clearSupports() {
    while (supportGroup.children.length) {
      const child = supportGroup.children[0];
      supportGroup.remove(child);
      child.geometry.dispose();
    }
  }
  function column(point) {
    const base = terrainHeight(data.elevation, ...point);
    if (slabBottom <= base) return;
    box(supportGroup, point[0] - center[0], (base + slabBottom) / 2, point[1] - center[1],
      pillarSize, slabBottom - base, pillarSize, materials.support);
  }
  function buildVariant(index) {
    clearSupports();
    const candidates = [], beams = [];
    if (index === 0) {
      for (let i = 1; i < park.points.length; i++) {
        const a = park.points[i - 1], b = park.points[i], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const count = Math.max(1, Math.floor(length / 12));
        for (let j = 0; j < count; j++) {
          const t = (j + .5) / count, p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
          const dx = center[0] - p[0], dy = center[1] - p[1], distance = Math.hypot(dx, dy);
          candidates.push([p[0] + dx / distance * 3, p[1] + dy / distance * 3]);
        }
      }
    } else if (index === 1) {
      for (let x = bounds[0] + 5; x < bounds[2]; x += 16)
        for (let y = bounds[1] + 5; y < bounds[3]; y += 16) candidates.push([x, y]);
    } else {
      for (const road of groundRoads) {
        const dx = road.b[0] - road.a[0], dy = road.b[1] - road.a[1], length = Math.hypot(dx, dy);
        const count = Math.max(1, Math.floor(length / 18));
        for (let j = 0; j < count; j++) {
          const t = (j + .5) / count, x = road.a[0] + dx * t, y = road.a[1] + dy * t;
          const offset = road.width / 2 + pillarSize + 1;
          const pair = [[x - dy / length * offset, y + dx / length * offset],
            [x + dy / length * offset, y - dx / length * offset]];
          if (pair.every(safe)) {
            candidates.push(...pair);
            beams.push({ x, y, offset, dx, dy, pair });
          }
        }
      }
    }
    const accepted = [];
    for (const point of candidates) {
      if (safe(point) && accepted.every(other => Math.hypot(point[0] - other[0], point[1] - other[1]) > 4)) {
        accepted.push(point);
        column(point);
      }
    }
    for (const beam of beams) {
      if (beam.pair.every(point => accepted.some(other => Math.hypot(point[0] - other[0], point[1] - other[1]) < .01)))
        box(supportGroup, beam.x - center[0], slabBottom - .2, beam.y - center[1],
          beam.offset * 2, .4, .55, materials.support, -Math.atan2(beam.dx, -beam.dy));
    }
    document.querySelector("#variant").textContent = `${variants[index].key} · ${variants[index].name}`;
    document.querySelector("#description").textContent = variants[index].description;
    status.textContent = `${accepted.length} proposed columns · target road clearance ${clearance} m (estimated)`;
    document.body.dataset.variant = variants[index].key;
    document.body.dataset.columns = String(accepted.length);
  }

  let index = Math.max(0, variants.findIndex(variant => variant.key === new URLSearchParams(location.search).get("variant")));
  function select(next) {
    index = (next + variants.length) % variants.length;
    const url = new URL(location.href);
    url.searchParams.set("variant", variants[index].key);
    history.replaceState(null, "", url);
    buildVariant(index);
  }
  document.querySelector("#previous").addEventListener("click", () => select(index - 1));
  document.querySelector("#next").addEventListener("click", () => select(index + 1));
  document.addEventListener("keydown", event => {
    if (event.target.matches("input, textarea, [contenteditable]")) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      select(index + (event.key === "ArrowLeft" ? -1 : 1));
    }
  });
  select(index);

  let azimuth = .5, elevation = .3, distance = 320, dragging = false, previous;
  function render() {
    const width = canvas.clientWidth, height = canvas.clientHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    camera.position.set(Math.sin(azimuth) * Math.cos(elevation) * distance,
      slabBottom - 1 + Math.sin(elevation) * distance, Math.cos(azimuth) * Math.cos(elevation) * distance);
    camera.lookAt(0, slabBottom - 1, 0);
    renderer.render(scene, camera);
  }
  document.querySelector("#buildings").addEventListener("click", event => {
    buildingGroup.visible = !buildingGroup.visible;
    event.currentTarget.setAttribute("aria-pressed", String(buildingGroup.visible));
    event.currentTarget.textContent = buildingGroup.visible ? "Hide surrounding buildings" : "Show surrounding buildings";
    render();
  });
  document.querySelector("#street-view").addEventListener("click", () => {
    elevation = -.04;
    distance = 220;
    render();
  });
  canvas.addEventListener("pointerdown", event => {
    dragging = true;
    previous = [event.clientX, event.clientY];
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", event => {
    if (!dragging) return;
    azimuth -= (event.clientX - previous[0]) * .008;
    elevation = Math.max(-.06, Math.min(1.45, elevation + (event.clientY - previous[1]) * .008));
    previous = [event.clientX, event.clientY];
    render();
  });
  canvas.addEventListener("pointerup", () => { dragging = false; });
  canvas.addEventListener("pointercancel", () => { dragging = false; });
  canvas.addEventListener("wheel", event => {
    event.preventDefault();
    distance = Math.max(90, Math.min(600, distance * Math.exp(event.deltaY * .001)));
    render();
  }, { passive: false });
  window.addEventListener("resize", render);
  const redraw = () => render();
  document.querySelector("#previous").addEventListener("click", redraw);
  document.querySelector("#next").addEventListener("click", redraw);
  document.addEventListener("keydown", event => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") render();
  });
  render();
}

main().catch(reason => {
  error.textContent = `Prototype could not load: ${reason.message}`;
  status.textContent = "";
});
