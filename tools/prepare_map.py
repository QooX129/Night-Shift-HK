"""Download one bounded OSM extract and build the game's attributed road graph."""

import argparse
import datetime as dt
import hashlib
import json
import math
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BOUNDS = (22.304, 114.161, 22.324, 114.178)
LAT, LON = 22.314, 114.1695
SCALE_X = 111_320 * math.cos(math.radians(LAT))
SCALE_Y = 111_320
ROAD_TYPES = {
    "primary", "secondary", "tertiary", "unclassified", "residential",
    "living_street", "service", "primary_link", "secondary_link", "tertiary_link",
}
QUERY = """
[out:json][timeout:90];
(
 way["highway"~"^(primary|secondary|tertiary|unclassified|residential|living_street|service|primary_link|secondary_link|tertiary_link)$"](22.304,114.161,22.324,114.178);
 way["building"](22.304,114.161,22.324,114.178);
 way["leisure"="park"](22.304,114.161,22.324,114.178);
 relation["type"="restriction"](22.304,114.161,22.324,114.178);
);
out body;
>;
out skel qt;
"""


def xy(lat: float, lon: float) -> list[float]:
    return [round((lon - LON) * SCALE_X, 2), round((LAT - lat) * SCALE_Y, 2)]


def download(destination: Path) -> None:
    payload = urllib.parse.urlencode({"data": QUERY}).encode()
    failures = []
    for endpoint in (
        "https://overpass-api.de/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter",
    ):
        request = urllib.request.Request(
            endpoint, data=payload,
            headers={"User-Agent": "HongKongTaxiPrototype/0.1 (bounded offline map preparation)"},
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                raw = response.read()
            parsed = json.loads(raw)
            if parsed.get("remark") or not parsed.get("elements"):
                raise ValueError(f"Incomplete Overpass response: {parsed.get('remark')}")
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(raw)
            return
        except (urllib.error.URLError, TimeoutError, ValueError) as error:
            failures.append(f"{endpoint}: {error}")
            print(f"Map source failed: {failures[-1]}")
    raise RuntimeError("No map extract downloaded. " + "; ".join(failures))


def build(raw_path: Path, output: Path) -> None:
    source = json.loads(raw_path.read_text(encoding="utf-8"))
    elements = source["elements"]
    osm_nodes = {e["id"]: e for e in elements if e["type"] == "node"}
    points = {str(k): xy(v["lat"], v["lon"]) for k, v in osm_nodes.items()}
    south, west, north, east = BOUNDS
    top_left, bottom_right = xy(north, west), xy(south, east)
    edges = []
    backdrop = []
    used_nodes = set()
    way_ids = set()
    for way in (e for e in elements if e["type"] == "way"):
        tags = way.get("tags", {})
        ids = [str(n) for n in way.get("nodes", [])]
        if any(n not in points for n in ids):
            raise ValueError(f"Missing geometry for OSM way {way['id']}")
        if "building" in tags or tags.get("leisure") == "park":
            backdrop.append({
                "kind": "park" if tags.get("leisure") == "park" else "building",
                "points": [points[n] for n in ids],
            })
        if tags.get("highway") not in ROAD_TYPES:
            continue
        if tags.get("area") == "yes":
            continue
        access = tags.get("motorcar", tags.get("motor_vehicle", tags.get("vehicle", tags.get("access", "yes"))))
        if access in {"no", "private"}:
            continue
        if tags.get("service") in {"parking_aisle", "driveway"}:
            continue
        oneway = tags.get("oneway", "yes" if tags.get("junction") == "roundabout" else "no")
        for index, (a, b) in enumerate(zip(ids, ids[1:])):
            pa, pb = points[a], points[b]
            if not all(top_left[0] <= p[0] <= bottom_right[0] and top_left[1] <= p[1] <= bottom_right[1] for p in (pa, pb)):
                continue
            length = math.dist(pa, pb)
            if length < 0.5:
                continue
            pairs = [(a, b)] if oneway in {"yes", "1", "true"} else [(b, a)] if oneway == "-1" else [(a, b), (b, a)]
            for start, end in pairs:
                edges.append({
                    "id": f"{way['id']}:{index}:{start}",
                    "a": start, "b": end, "way": way["id"],
                    "length": round(length, 2), "name": tags.get("name:en", tags.get("name", "Local road")),
                    "zh": tags.get("name:zh", tags.get("name", "支路")),
                    "kind": tags["highway"], "oneway": len(pairs) == 1,
                    "layer": tags.get("layer", "0"),
                    "bridge": tags.get("bridge", "no"), "tunnel": tags.get("tunnel", "no"),
                })
                used_nodes.update((start, end))
                way_ids.add(way["id"])
    restrictions, omitted, conditional_notes = [], [], []
    for relation in (e for e in elements if e["type"] == "relation"):
        tags = relation.get("tags", {})
        members = relation.get("members", [])
        if tags.get("type") != "restriction":
            continue
        if any(mode in tags.get("except", "").split(";") for mode in ("motorcar", "motor_vehicle", "taxi")):
            continue
        origins = [m["ref"] for m in members if m["role"] == "from" and m["type"] == "way"]
        targets = [m["ref"] for m in members if m["role"] == "to" and m["type"] == "way"]
        if not any(w in way_ids for w in origins + targets):
            continue
        vias = [str(m["ref"]) for m in members if m["role"] == "via" and m["type"] == "node"]
        via_ways = [m["ref"] for m in members if m["role"] == "via" and m["type"] == "way"]
        rule = tags.get("restriction:motorcar", tags.get("restriction", ""))
        conditional = tags.get("restriction:conditional", "")
        if not rule and conditional in {"no_left_turn @ length > 8", "no_right_turn @ length>8"}:
            conditional_notes.append({"id": relation["id"], "reason": "Length > 8m condition does not apply to the prototype taxi"})
            continue
        if len(origins) == len(targets) == 1 and (len(vias) == 1 or via_ways) and rule.startswith(("no_", "only_")):
            restrictions.append({
                "from": origins[0], "to": targets[0], "via": vias[0] if vias else None,
                "via_ways": via_ways, "rule": rule,
            })
        else:
            omitted.append({"id": relation["id"], "tags": tags, "members": members})
    nodes = {k: points[k] for k in sorted(used_nodes)}
    if len(edges) < 50:
        raise ValueError("Extract has too few drivable edges")
    # Keep the largest weak component to avoid offering isolated service-road jobs.
    neighbors: dict[str, set[str]] = {n: set() for n in nodes}
    for edge in edges:
        neighbors[edge["a"]].add(edge["b"])
        neighbors[edge["b"]].add(edge["a"])
    remaining = set(nodes)
    components = []
    while remaining:
        component = set()
        stack = [next(iter(remaining))]
        while stack:
            n = stack.pop()
            if n in component:
                continue
            component.add(n)
            stack.extend(neighbors[n] - component)
        remaining -= component
        components.append(component)
    largest = max(components, key=len)
    nodes = {k: v for k, v in nodes.items() if k in largest}
    edges = [e for e in edges if e["a"] in largest and e["b"] in largest]
    result = {
        "version": hashlib.sha256(raw_path.read_bytes() + b"|district-schema-2").hexdigest()[:12],
        "source": "OpenStreetMap contributors", "license": "ODbL-1.0",
        "downloaded": dt.datetime.now(dt.timezone.utc).isoformat(),
        "origin": [LAT, LON], "bounds": top_left + bottom_right,
        "nodes": nodes, "edges": edges, "backdrop": backdrop,
        "restrictions": restrictions, "unsupported_restrictions": omitted,
        "conditional_notes": conditional_notes,
        "source_timestamp": source.get("osm3s", {}).get("timestamp_osm_base"),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Prepared {len(nodes)} nodes, {len(edges)} directed edges, {len(backdrop)} backdrop shapes")
    print(f"Restrictions: {len(restrictions)} supported; {len(omitted)} require audit")
    print(f"Dataset version: {result['version']}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download", action="store_true", help="Fetch a new bounded extract")
    args = parser.parse_args()
    raw_file = ROOT / "data" / "source.osm.json"
    if args.download:
        download(raw_file)
    if not raw_file.exists():
        parser.error("No source extract. Run with --download first.")
    build(raw_file, ROOT / "data" / "district.json")
