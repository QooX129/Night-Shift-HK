"""Build a small offline district package; never mistake a DTM for bare earth."""

import argparse
import datetime as dt
import hashlib
import json
import math
from pathlib import Path
import urllib.request
import zlib

ROOT = Path(__file__).resolve().parents[1]
DTM_URL = "https://www.landsd.gov.hk/landsd_psi_data/SMO/data/Whole_HK_DTM_5m.zip"
DTM_PAGE = "https://data.gov.hk/en-data/dataset/hk-landsd-openmap-5m-grid-dtm"
TERMS = "https://portal.csdi.gov.hk/csdi-webpage/apidoc/3d-spatial-data-api"


def request(start, end):
    req = urllib.request.Request(DTM_URL, headers={"Range": f"bytes={start}-{end}"})
    response = urllib.request.urlopen(req, timeout=120)
    if response.status != 206:
        response.close()
        raise ValueError("Server must support range requests; refusing unbounded download")
    return response


def district_dtm(document):
    """Stream one 28 MB compressed ASC; retain only district rows, not whole HK."""
    import struct
    from pyproj import Transformer
    with request(0, 255) as response:
        header = response.read(256)
    if header[:4] != b"PK\x03\x04":
        raise ValueError("Unexpected DTM archive")
    fields = struct.unpack_from("<4s5H3L2H", header)
    method, compressed = fields[3], fields[7]
    offset = 30 + fields[9] + fields[10]
    if method != 8 or compressed > 40_000_000:
        raise ValueError("Unexpected archive size/compression")
    lonlat = Transformer.from_crs(4326, 2326, always_xy=True)
    lat, lon = document["origin"]
    sx, sy = 111320 * math.cos(math.radians(lat)), 111320
    left, top, right, bottom = document["bounds"]
    corners = [lonlat.transform(lon + x / sx, lat - y / sy)
               for x in (left - 30, right + 30) for y in (top - 30, bottom + 30)]
    xmin, xmax = min(p[0] for p in corners), max(p[0] for p in corners)
    ymin, ymax = min(p[1] for p in corners), max(p[1] for p in corners)
    decoder, pending, metadata, rows = zlib.decompressobj(-15), b"", {}, []
    row_index = 0
    digest = hashlib.sha256()
    with request(offset, offset + compressed - 1) as response:
        while chunk := response.read(65536):
            digest.update(chunk)
            pending += decoder.decompress(chunk)
            lines = pending.split(b"\n")
            pending = lines.pop()
            for line in lines:
                if len(metadata) < 6:
                    key, value = line.split()
                    metadata[key.decode().lower()] = float(value)
                    continue
                cell = metadata["cellsize"]
                y = metadata["yllcorner"] + (metadata["nrows"] - row_index - .5) * cell
                if ymin <= y <= ymax:
                    first = max(0, math.floor((xmin - metadata["xllcorner"]) / cell))
                    last = min(int(metadata["ncols"]) - 1, math.ceil((xmax - metadata["xllcorner"]) / cell))
                    values = line.split()
                    rows.append([float(v) for v in values[first:last + 1]])
                    if len(rows) == 1:
                        x0, y0 = metadata["xllcorner"] + (first + .5) * cell, y
                row_index += 1
    if not rows or any(len(r) != len(rows[0]) for r in rows):
        raise ValueError("No complete district DTM")
    # Resample HK1980 grid to the game's metric coordinate system, retaining datum.
    origin, spacing = [left, top], 10
    width, height = math.ceil((right - left) / spacing) + 1, math.ceil((bottom - top) / spacing) + 1
    result = []
    for j in range(height):
        for i in range(width):
            east, north = lonlat.transform(lon + (left + i * spacing) / sx, lat - (top + j * spacing) / sy)
            col, row = round((east - x0) / cell), round((y0 - north) / cell)
            value = rows[max(0, min(len(rows) - 1, row))][max(0, min(len(rows[0]) - 1, col))]
            if value == metadata["nodata_value"]:
                raise ValueError("DTM has missing data in district")
            result.append(value)
    return {"origin": origin, "spacing": spacing, "width": width, "height": height,
            "values": result, "source_grid_m": cell, "compressed_sha256": digest.hexdigest()}


def sample(grid, point):
    x = max(0, min(grid["width"] - 1, (point[0] - grid["origin"][0]) / grid["spacing"]))
    y = max(0, min(grid["height"] - 1, (point[1] - grid["origin"][1]) / grid["spacing"]))
    i, j = min(int(x), grid["width"] - 2), min(int(y), grid["height"] - 2)
    u, v = x - i, y - j
    a, b = j * grid["width"] + i, (j + 1) * grid["width"] + i
    values = grid["values"]
    return ((1 - u) * values[a] + u * values[a + 1]) * (1 - v) + ((1 - u) * values[b] + u * values[b + 1]) * v


def building_height(tags):
    try:
        height = float(tags.get("height", "").removesuffix(" m"))
        if 2 <= height <= 500:
            return height, "osm-tagged-height-not-survey-verified"
    except ValueError:
        pass
    try:
        levels = float(tags.get("building:levels", ""))
        if 1 <= levels <= 150:
            return round(levels * 3.2, 2), "estimated-levels-times-3.2m"
    except ValueError:
        pass
    return 18, "estimated-default-18m"


def road_layer_offset(edge):
    try:
        layer = int(edge["layer"])
    except (TypeError, ValueError):
        layer = 0
    bridge = edge["bridge"] not in ("no", "0", "")
    tunnel = edge["tunnel"] not in ("no", "0", "", "building_passage")
    if bridge:
        return max(1, layer) * 6
    if tunnel:
        return min(-1, layer) * 6
    return layer * 6


def build(refresh=False):
    document = json.loads((ROOT / "data/district.json").read_text())
    cache = ROOT / "data/elevation.json"
    grid = district_dtm(document) if refresh or not cache.exists() else json.loads(cache.read_text())["dtm"]
    # DTM includes decks and vegetation. A smoothed local lower envelope is an
    # explicitly estimated ground surface, not another claimed measurement.
    ground = {**grid, "values": []}
    for j in range(grid["height"]):
        for i in range(grid["width"]):
            values = [grid["values"][y * grid["width"] + x]
                      for y in range(max(0, j - 3), min(grid["height"], j + 4))
                      for x in range(max(0, i - 3), min(grid["width"], i + 4))]
            ground["values"].append(round(sorted(values)[len(values) // 5], 2))
    nodes = document["nodes"]
    incident = {n: [] for n in nodes}
    for edge in document["edges"]:
        incident[edge["a"]].append(edge)
        incident[edge["b"]].append(edge)
    heights = {}
    for n, edges in incident.items():
        offsets = []
        for e in edges:
            offsets.append(road_layer_offset(e))
        heights[n] = sample(ground, nodes[n]) + sum(offsets) / len(offsets)
    # Shared graph nodes guarantee ramp continuity. Bound grades to 12%; lower
    # high endpoints instead of inventing physical jumps at bridge/tunnel tags.
    for _ in range(200):
        changed = False
        for edge in document["edges"]:
            a, b = edge["a"], edge["b"]
            limit = math.dist(nodes[a], nodes[b]) * .12
            if heights[a] > heights[b] + limit:
                heights[a], changed = heights[b] + limit, True
            elif heights[b] > heights[a] + limit:
                heights[b], changed = heights[a] + limit, True
        if not changed:
            break
    source = json.loads((ROOT / "data/source.osm.json").read_text())
    osm_nodes = {e["id"]: e for e in source["elements"] if e["type"] == "node"}
    lat, lon = document["origin"]
    sx = 111320 * math.cos(math.radians(lat))
    footprints = {}
    for e in source["elements"]:
        if e["type"] != "way" or "building" not in e.get("tags", {}):
            continue
        points = [[round((osm_nodes[n]["lon"] - lon) * sx, 2),
                   round((lat - osm_nodes[n]["lat"]) * 111320, 2)] for n in e["nodes"]]
        footprints[json.dumps(points, separators=(",", ":"))] = (e["id"], *building_height(e["tags"]))
    buildings = []
    for index, footprint in enumerate(document["backdrop"]):
        if footprint["kind"] != "building":
            continue
        osm_id, height, quality = footprints.get(json.dumps(footprint["points"], separators=(",", ":")),
                                                 (None, 18, "estimated-default-18m"))
        buildings.append({"index": index, "osm_way": osm_id, "height": height, "quality": quality,
                          "base": round(sample(ground, footprint["points"][0]), 3)})
    package = {
        "schema": 1, "map_version": document["version"], "built": dt.datetime.now(dt.timezone.utc).isoformat(),
        "datum": "Hong Kong Principal Datum (DTM); road/building bases estimated in same datum",
        "dtm": grid, "terrain": ground, "node_heights": {n: round(z, 6) for n, z in heights.items()},
        "buildings": buildings,
        "road_quality": "estimated-ground-envelope-plus-6m-per-OSM-layer-grade-limited",
        "max_grade": .12, "pilot": {"status": "topology-only; heights estimated, not survey verified"},
        "sources": [
            {"name": "Lands Department, HKSAR Government", "url": DTM_URL, "description": DTM_PAGE,
             "terms": "https://data.gov.hk/en/terms-and-conditions",
             "copyright": "© Hong Kong SAR Government, Lands Department; DATA.GOV.HK", "accuracy_m": 5,
             "warning": "5m DTM includes elevated roads/bridges and vegetation. NOT bare earth."},
            {"name": "OpenStreetMap contributors", "license": "ODbL-1.0",
             "timestamp": document.get("source_timestamp"),
             "warning": "Layer/bridge/tunnel and height tags are not survey measurements."},
        ],
    }
    cache.write_text(json.dumps(package, separators=(",", ":")), encoding="utf-8")
    print(f"Packaged {len(grid['values'])} district DTM samples, {len(heights)} road nodes, {len(buildings)} buildings")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="Stream up to 40 MB official compressed DTM, retain district only")
    build(parser.parse_args().refresh)
