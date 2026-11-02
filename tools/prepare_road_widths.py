"""Build reproducible metric road widths without moving OSM centre lines."""

import argparse
import hashlib
import json
import math
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
MIN_WIDTH = 2.2
GAP = 0.3
DEFAULT_WIDTHS = {
    "primary": 12.8, "secondary": 12, "tertiary": 6.4,
    "unclassified": 5.6, "residential": 5.6, "living_street": 3,
    "service": 3, "primary_link": 3.2, "secondary_link": 3.2, "tertiary_link": 3.2,
}


def tagged_width(tags: dict) -> tuple[float, str]:
    """Widths are carriageway totals; do not halve a two-way lane count."""
    raw = tags.get("width", "")
    match = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*(m|metres?|meters?|ft|')?\s*", raw)
    if match:
        width = float(match[1]) * (0.3048 if match[2] in {"ft", "'"} else 1)
        if MIN_WIDTH <= width <= 40:
            return width, "osm-width"
    lanes = tags.get("lanes", "")
    if re.fullmatch(r"[1-9]\d?", lanes) and int(lanes) <= 12:
        return int(lanes) * 3, "estimated-osm-lanes-times-3m"
    kind = tags["highway"]
    width = DEFAULT_WIDTHS.get(kind, 5.6)
    if tags.get("oneway") in {"yes", "1", "true", "-1"}:
        width = 6.4 if kind in {"primary", "secondary"} else 3.2
    return width, "estimated-road-class"


def projection(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    fraction = max(0, min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
    nearest = (a[0] + fraction * dx, a[1] + fraction * dy)
    return math.dist(p, nearest), fraction


def parallel_spacing(first: dict, second: dict, nodes: dict, junctions: set) -> float | None:
    if first["way"] == second["way"] or {first["a"], first["b"]} & {second["a"], second["b"]}:
        return None
    if any(first.get(tag, default) != second.get(tag, default)
           for tag, default in (("layer", "0"), ("bridge", "no"), ("tunnel", "no"))):
        return None
    a, b, c, d = (nodes[e[n]] for e, n in ((first, "a"), (first, "b"), (second, "a"), (second, "b")))
    ab, cd = (b[0] - a[0], b[1] - a[1]), (d[0] - c[0], d[1] - c[1])
    dot = sum(x * y for x, y in zip(ab, cd)) / math.hypot(*ab) / math.hypot(*cd)
    if abs(dot) < 0.9:
        return None
    cross = lambda p, q, r: (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    if cross(a, b, c) * cross(a, b, d) <= 0 and cross(c, d, a) * cross(c, d, b) <= 0:
        return None
    # Ends of adjoining roads and merging slip lanes intentionally overlap.
    # Only constrain sections with a genuine longitudinal overlap.
    samples = [(projection(p, u, v), p) for p, u, v in ((a, c, d), (b, c, d), (c, a, b), (d, a, b))]
    length = math.hypot(*ab)
    positions = [sum((p[k] - a[k]) * ab[k] for k in (0, 1)) / length for p in (c, d)]
    if min(length, max(positions)) - max(0, min(positions)) < .5:
        return None
    distance, point = min(((value[0], p) for value, p in samples), key=lambda item: item[0])
    if any(math.dist(point, nodes[node]) < 15 for node in junctions):
        return None
    return distance


def prepare(document: dict, source: dict) -> dict:
    tags_by_way = {element["id"]: element.get("tags", {})
                   for element in source["elements"] if element["type"] == "way" and "highway" in element.get("tags", {})}
    nodes = document["nodes"]
    physical = {}
    for edge in document["edges"]:
        key = (edge["way"], *sorted((edge["a"], edge["b"])))
        physical.setdefault(key, edge)
    edges = list(physical.values())
    ways = {}
    for edge in edges:
        ways.setdefault(edge["way"], set()).update((edge["a"], edge["b"]))
    widths, origins, warnings = [], [], []
    for edge in edges:
        tags = tags_by_way[edge["way"]]
        width, origin = tagged_width(tags)
        widths.append(width)
        origins.append(origin)
        if tags.get("width") and origin != "osm-width":
            warnings.append({"way": edge["way"], "width": tags["width"], "reason": "Unsupported or out-of-range width; used lane/class estimate"})
    # A spatial index keeps the district audit local rather than all-pairs.
    cells, pairs = {}, set()
    for index, edge in enumerate(edges):
        a, b = nodes[edge["a"]], nodes[edge["b"]]
        for x in range(math.floor((min(a[0], b[0]) - 20) / 50), math.floor((max(a[0], b[0]) + 20) / 50) + 1):
            for y in range(math.floor((min(a[1], b[1]) - 20) / 50), math.floor((max(a[1], b[1]) + 20) / 50) + 1):
                bucket = cells.setdefault((x, y), [])
                pairs.update((other, index) for other in bucket)
                bucket.append(index)
    constraints = []
    for i, j in sorted(pairs):
        first, second = edges[i], edges[j]
        spacing = parallel_spacing(first, second, nodes, ways[first["way"]] & ways[second["way"]])
        if spacing is not None and spacing < (widths[i] + widths[j]) / 2 + GAP:
            constraints.append((i, j, spacing))
    requested = widths[:]
    conflicts = []
    for i, j, spacing in constraints:
        budget = 2 * (spacing - GAP)
        if budget < MIN_WIDTH * 2:
            conflicts.append({"edges": [edges[i]["id"], edges[j]["id"]],
                              "spacing_m": round(spacing, 4), "reason": "Insufficient separation for two drivable carriageways"})
            continue
        excess = widths[i] + widths[j] - budget
        if excess <= 0:
            continue
        available = widths[i] + widths[j] - MIN_WIDTH * 2
        for index in (i, j):
            widths[index] -= excess * (widths[index] - MIN_WIDTH) / available
    values = {}
    for index, edge in enumerate(edges):
        # Round down so serialization cannot reintroduce a spacing overlap.
        width = math.floor(widths[index] * 10000) / 10000
        values[":".join(map(str, (edge["way"], *sorted((edge["a"], edge["b"])))))] = {
            "width": width, "requested_width": requested[index], "source": origins[index],
            "spacing_constrained": width < requested[index] - .001,
        }
    return {
        "map_version": document["version"], "units": "metres", "minimum_width_m": MIN_WIDTH,
        "source": "OpenStreetMap contributors", "license": "ODbL-1.0",
        "parallel_gap_m": GAP, "lane_width_estimate_m": 3,
        "values": values, "conflicts": conflicts,
        "spacing_checks": [{
            "first": ":".join(map(str, (edges[i]["way"], *sorted((edges[i]["a"], edges[i]["b"]))))),
            "second": ":".join(map(str, (edges[j]["way"], *sorted((edges[j]["a"], edges[j]["b"]))))),
            "spacing_m": spacing,
        } for i, j, spacing in constraints],
        "warnings": list({json.dumps(item, sort_keys=True): item for item in warnings}.values()),
        "audit": {"physical_segments": len(edges), "parallel_constraints": len(constraints),
                  "spacing_constrained": sum(item["spacing_constrained"] for item in values.values()),
                  "unresolved_pairs": len(conflicts)},
    }


def build(district: Path, source: Path, output: Path) -> dict:
    result = prepare(json.loads(district.read_text()), json.loads(source.read_text()))
    result["source_sha256"] = hashlib.sha256(source.read_bytes()).hexdigest()
    output.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"Road-width audit: {json.dumps(result['audit'])}")
    if result["conflicts"]:
        print(f"WARNING: {len(result['conflicts'])} unresolved close-road pairs recorded in {output}")
    for warning in result["warnings"]:
        print(f"WARNING: {warning}")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    build(ROOT / "data/district.json", ROOT / "data/source.osm.json", ROOT / "data/road-widths.json")
