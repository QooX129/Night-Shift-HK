"""Clip one public LandsD infrastructure tile; retain source-model heights."""

import hashlib
import json
import math
import heapq
from pathlib import Path
import struct
import urllib.request

from pyproj import Transformer

ROOT = Path(__file__).resolve().parents[1]
URL = ("https://data.map.gov.hk/api/3d-data/3dsd/WGS84/infrastructure/"
       "Data/F_Tile_+3_1_0/F_Tile_+3_1_0+R0_67.b3dm"
       "?key=3967f8f365694e0798af3e7678509421")


def accessor(gltf, binary, index):
    spec = gltf["accessors"][index]
    view = gltf["bufferViews"][spec["bufferView"]]
    if spec.get("sparse") or spec.get("normalized"):
        raise ValueError("Unsupported accessor")
    count = {"SCALAR": 1, "VEC3": 3}[spec["type"]]
    fmt = "<" + {5123: "H", 5125: "I", 5126: "f"}[spec["componentType"]] * count
    offset = view.get("byteOffset", 0) + spec.get("byteOffset", 0)
    stride = view.get("byteStride", struct.calcsize(fmt))
    return [struct.unpack_from(fmt, binary, offset + i * stride) for i in range(spec["count"])]


def build():
    document = json.loads((ROOT / "data/district.json").read_text())
    with urllib.request.urlopen(URL, timeout=120) as response:
        raw = response.read(5_000_001)
    if len(raw) > 5_000_000:
        raise ValueError("Pilot tile exceeds 5 MB request budget")
    header = struct.unpack_from("<4s6I", raw)
    if header[0] != b"b3dm" or header[1] != 1 or header[2] != len(raw):
        raise ValueError("Unexpected official tile")
    offset = 28 + sum(header[3:7])
    json_size = struct.unpack_from("<I", raw, offset + 12)[0]
    gltf = json.loads(raw[offset + 20:offset + 20 + json_size])
    binary = raw[offset + 28 + json_size:]
    if any("matrix" in n or "translation" in n or "rotation" in n or "scale" in n for n in gltf["nodes"]):
        raise ValueError("Unimplemented node transforms; refusing incorrect coordinates")
    ecef = Transformer.from_crs(4978, 4979, always_xy=True)
    lat0, lon0 = document["origin"]
    sx = 111320 * math.cos(math.radians(lat0))
    left, top, right, bottom = document["bounds"]
    triangles = []
    for mesh in gltf["meshes"]:
        for primitive in mesh["primitives"]:
            if primitive.get("mode", 4) != 4:
                raise ValueError("Only triangle model supported")
            vertices = accessor(gltf, binary, primitive["attributes"]["POSITION"])
            world = []
            for x, y, z in vertices:
                # Official root ECEF translation; glTF Y-up -> tileset Z-up.
                lon, lat, height = ecef.transform(x - 2414000, -z + 5380000, y + 2419000)
                world.append([round((lon - lon0) * sx, 3), round((lat0 - lat) * 111320, 3),
                              round(height, 3)])
            indices = [v[0] for v in accessor(gltf, binary, primitive["indices"])]
            for i in range(0, len(indices), 3):
                tri = [world[j] for j in indices[i:i + 3]]
                if all(left <= p[0] <= right and top <= p[1] <= bottom for p in tri):
                    triangles.append(tri)
    if not triangles:
        raise ValueError("Official tile has no district geometry")
    # Pick an OSM bridge/ground crossing actually covered by this source tile.
    elevation = json.loads((ROOT / "data/elevation.json").read_text())
    def model_height(x, y):
        found = []
        for a, b, c in triangles:
            denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
            if abs(denominator) < .01:
                continue
            u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / denominator
            v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / denominator
            if u >= 0 and v >= 0 and u + v <= 1:
                found.append(u * a[2] + v * b[2] + (1 - u - v) * c[2])
        return max(found) if found else None
    seen, edges = set(), []
    for edge in document["edges"]:
        key = (edge["way"], *sorted((edge["a"], edge["b"])))
        if key not in seen:
            edges.append(edge)
            seen.add(key)
    crossings = []
    for bridge in (e for e in edges if e["bridge"] != "no"):
        a, b = document["nodes"][bridge["a"]], document["nodes"][bridge["b"]]
        for ground in (e for e in edges if e["bridge"] == "no" and e["tunnel"] == "no"):
            if {bridge["a"], bridge["b"]} & {ground["a"], ground["b"]}:
                continue
            c, d = document["nodes"][ground["a"]], document["nodes"][ground["b"]]
            dx, dy, ex, ey = b[0] - a[0], b[1] - a[1], d[0] - c[0], d[1] - c[1]
            det = dx * ey - dy * ex
            if abs(det) < .01:
                continue
            u = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / det
            v = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / det
            if not 0 < u < 1 or not 0 < v < 1:
                continue
            x, y = a[0] + u * dx, a[1] + u * dy
            z = model_height(x, y)
            if z is not None:
                crossings.append({"point": [round(x, 3), round(y, 3)],
                                  "bridge": bridge["id"], "ground": ground["id"],
                                  "bridge_name": bridge["name"], "ground_name": ground["name"],
                                  "source_model_wgs84_ellipsoidal_height": round(z, 3)})
    if not crossings:
        raise ValueError("No bridge/ground crossing verified against model in this tile")
    pilot = crossings[0]
    x, y = pilot["point"]
    clipped = [t for t in triangles if all(abs(p[0] - x) <= 100 and abs(p[1] - y) <= 100 for p in t)]
    bridge = next(e for e in edges if e["id"] == pilot["bridge"])
    a, b = document["nodes"][bridge["a"]], document["nodes"][bridge["b"]]
    fraction = math.dist(a, (x, y)) / math.dist(a, b)
    existing = elevation["node_heights"]
    # Relative model geometry is retained. No verified geoid transformation is
    # supplied by this importer: align the pilot to the estimated district deck.
    bias = existing[bridge["a"]] * (1 - fraction) + existing[bridge["b"]] * fraction - model_height(x, y)
    anchors = {}
    for edge in edges:
        if edge["bridge"] == "no":
            continue
        for n in (edge["a"], edge["b"]):
            point = document["nodes"][n]
            if abs(point[0] - x) > 100 or abs(point[1] - y) > 100:
                continue
            z = model_height(*point)
            if z is not None:
                anchors[n] = z + bias
    # Keep the documented simulation grade limit without inventing jumps.
    for _ in range(100):
        changed = False
        for edge in edges:
            a, b = edge["a"], edge["b"]
            if a not in anchors or b not in anchors:
                continue
            limit = math.dist(document["nodes"][a], document["nodes"][b]) * .12
            if anchors[a] > anchors[b] + limit:
                anchors[a], changed = anchors[b] + limit, True
            elif anchors[b] > anchors[a] + limit:
                anchors[b], changed = anchors[a] + limit, True
        if not changed:
            break
    neighbors = {n: [] for n in existing}
    for edge in edges:
        limit = math.dist(document["nodes"][edge["a"]], document["nodes"][edge["b"]]) * .12
        neighbors[edge["a"]].append((edge["b"], limit))
        neighbors[edge["b"]].append((edge["a"], limit))
    def envelope(sign):
        costs = {n: sign * z for n, z in anchors.items()}
        queue = [(z, n) for n, z in costs.items()]
        heapq.heapify(queue)
        while queue:
            cost, n = heapq.heappop(queue)
            if cost != costs[n]:
                continue
            for nxt, length in neighbors[n]:
                candidate = cost + length
                if candidate < costs.get(nxt, math.inf):
                    costs[nxt] = candidate
                    heapq.heappush(queue, (candidate, nxt))
        return costs
    upper, lower = envelope(1), envelope(-1)
    for n in existing:
        existing[n] = round(max(-lower[n], min(upper[n], existing[n])), 6)
    elevation["node_quality"] = {n: "official-model-relative-profile; estimated-datum-alignment; grade-limited"
                                 for n in anchors}
    pilot.update({"status": "OSM disconnected crossing confirmed by official infrastructure model footprint",
                  "height_status": "source-model-derived; NOT survey verified; vertical datum alignment estimated",
                  "source": URL, "sha256": hashlib.sha256(raw).hexdigest(), "triangles": clipped,
                  "estimated_vertical_offset_m": round(bias, 6), "profile_nodes": sorted(anchors),
                  "source_lod": "R0, highest-detail source tile",
                  "license_terms": "https://portal.csdi.gov.hk/csdi-webpage/apidoc/3d-spatial-data-api"})
    elevation["pilot"] = pilot
    (ROOT / "data/elevation.json").write_text(json.dumps(elevation, separators=(",", ":")))
    print(f"Pilot {pilot['bridge_name']} over {pilot['ground_name']}: {pilot['point']}; {len(clipped)} clipped model triangles")


if __name__ == "__main__":
    build()
