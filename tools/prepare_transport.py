"""Download public transport locations for the offline district map."""

import datetime as dt
import json
import math
from pathlib import Path
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

if __package__:
    from .prepare_map import BOUNDS, LAT, LON, xy
else:
    from prepare_map import BOUNDS, LAT, LON, xy


ROOT = Path(__file__).resolve().parents[1]


def extract(payload: bytes) -> list[dict]:
    root = ET.fromstring(payload)
    nodes = {node.attrib["id"]: (float(node.attrib["lat"]), float(node.attrib["lon"]))
             for node in root.findall("node")}
    rail_stations = {}
    entrances = set()
    for element in root:
        tags = {tag.attrib["k"]: tag.attrib["v"] for tag in element.findall("tag")}
        key = (element.tag, element.get("id"))
        if tags.get("railway") == "station":
            rail_stations[key] = tags
        elif tags.get("railway") == "subway_entrance":
            entrances.add(key)
    stations = {}
    for relation in root.findall("relation"):
        tags = {tag.attrib["k"]: tag.attrib["v"] for tag in relation.findall("tag")}
        members = relation.findall("member")
        station_tags = next((rail_stations[(member.attrib["type"], member.attrib["ref"])]
                             for member in members
                             if (member.attrib["type"], member.attrib["ref"]) in rail_stations), {})
        has_entrance = any((member.attrib["type"], member.attrib["ref"]) in entrances
                           and member.get("role", "") in {"", "entrance", "subway_entrance"}
                           for member in members)
        if (tags.get("public_transport") != "stop_area"
                or not (tags.get("subway") == "yes" or tags.get("station") == "subway" or has_entrance)
                or not (tags.get("name:en") or tags.get("name"))):
            continue
        station = {
            "id": f"osm-relation-{relation.attrib['id']}",
            "name": tags.get("name:en") or station_tags.get("name:en", ""),
            "zh": tags.get("name:zh") or station_tags.get("name:zh", ""),
        }
        for member in relation.findall("member"):
            stations[f"osm-{member.attrib['type']}-{member.attrib['ref']}"] = station
    features = []
    for element in root:
        if element.tag not in {"node", "way"}:
            continue
        tags = {tag.attrib["k"]: tag.attrib["v"] for tag in element.findall("tag")}
        if tags.get("access") in {"no", "private"}:
            continue
        if tags.get("railway") == "subway_entrance" and tags.get("subway") != "no":
            if (tags.get("level") not in {None, "0", "0.0"}
                    or tags.get("location") in {"underground", "podium", "roof"}
                    or tags.get("indoor") == "yes"):
                continue
            kind = "mtr"
        elif tags.get("amenity") == "taxi" or tags.get("taxi") in {"stand", "station", "rank"}:
            kind = "taxi"
        elif (tags.get("highway") == "bus_stop" or tags.get("amenity") == "bus_station"
              or (tags.get("public_transport") == "platform" and tags.get("bus") == "yes")):
            kind = "bus"
        else:
            continue
        if element.tag == "node":
            coordinates = [nodes[element.attrib["id"]]]
        else:
            coordinates = [nodes[ref.attrib["ref"]] for ref in element.findall("nd")]
            if not coordinates:
                raise ValueError(f"Transport way {element.attrib['id']} has no geometry")
        lat = (min(point[0] for point in coordinates) + max(point[0] for point in coordinates)) / 2
        lon = (min(point[1] for point in coordinates) + max(point[1] for point in coordinates)) / 2
        south, west, north, east = BOUNDS
        if south <= lat <= north and west <= lon <= east:
            feature = {
                "id": f"osm-{element.tag}-{element.attrib['id']}", "kind": kind, "point": xy(lat, lon),
                "name": tags.get("name:en") or tags.get("name", ""),
                "zh": tags.get("name:zh") or tags.get("name", ""),
                "ref": tags.get("ref", ""),
            }
            if kind == "mtr" and feature["id"] in stations:
                feature["station"] = stations[feature["id"]]
            features.append(feature)
    return features


def download(output: Path) -> None:
    south, west, north, east = BOUNDS
    step = .004
    rows = math.ceil((north - south) / step - 1e-9)
    columns = math.ceil((east - west) / step - 1e-9)
    features = {}
    for row in range(rows):
        for column in range(columns):
            bottom, left = south + row * step, west + column * step
            bbox = f"{left:.6f},{bottom:.6f},{min(left + step, east):.6f},{min(bottom + step, north):.6f}"
            url = "https://api.openstreetmap.org/api/0.6/map?" + urllib.parse.urlencode({"bbox": bbox})
            request = urllib.request.Request(url, headers={"User-Agent": "NightShiftHK/1.0 (offline map preparation)"})
            with urllib.request.urlopen(request, timeout=90) as response:
                for feature in extract(response.read()):
                    features[feature["id"]] = {**features.get(feature["id"], {}), **feature}
            print(f"Downloaded transport tile {row * columns + column + 1}/{rows * columns}", flush=True)
    if not features:
        raise ValueError("No transport features found in the OSM map")
    incomplete_stations = {feature["station"]["id"] for feature in features.values()
                           if "station" in feature
                           and not (feature["station"]["name"] and feature["station"]["zh"])}
    for station in sorted(incomplete_stations):
        relation_id = station.removeprefix("osm-relation-")
        url = f"https://api.openstreetmap.org/api/0.6/relation/{relation_id}/full"
        request = urllib.request.Request(url, headers={"User-Agent": "NightShiftHK/1.0 (offline map preparation)"})
        with urllib.request.urlopen(request, timeout=90) as response:
            for feature in extract(response.read()):
                if feature["id"] in features:
                    features[feature["id"]] = {**features[feature["id"]], **feature}
    missing_stations = [feature["id"] for feature in features.values()
                        if feature["kind"] == "mtr" and not feature.get("station", {}).get("name")]
    if missing_stations:
        raise ValueError(f"MTR entrances lack named OSM station relations: {missing_stations}")
    data = {
        "source": "OpenStreetMap contributors", "license": "ODbL-1.0",
        "downloaded": dt.datetime.now(dt.timezone.utc).isoformat(),
        "origin": [LAT, LON], "bounds": list(BOUNDS),
        "features": sorted(features.values(), key=lambda feature: feature["id"]),
    }
    output.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Prepared {len(features)} transport features")


if __name__ == "__main__":
    download(ROOT / "data/transport.json")
