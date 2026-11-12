"""Extract named destinations from the retained district OpenStreetMap data."""

import json
from pathlib import Path

if __package__:
    from .prepare_map import xy
else:
    from prepare_map import xy


ROOT = Path(__file__).resolve().parents[1]
PLACE_TAGS = {
    "tourism": {"attraction", "hotel", "hostel", "museum", "gallery", "guest_house"},
    "amenity": {"arts_centre", "cinema", "community_centre", "hospital", "clinic", "library",
                "marketplace", "restaurant", "school", "theatre", "university", "place_of_worship"},
    "shop": {"department_store", "mall", "supermarket"},
    "leisure": {"park", "sports_centre", "stadium", "garden"},
    "railway": {"station"},
}


def build(source_path: Path, map_path: Path, output_path: Path) -> None:
    source = json.loads(source_path.read_text(encoding="utf-8"))
    district = json.loads(map_path.read_text(encoding="utf-8"))
    nodes = {e["id"]: e for e in source["elements"] if e["type"] == "node"}
    left, top, right, bottom = district["bounds"]
    places = []
    for element in source["elements"]:
        tags = element.get("tags", {})
        if not any(tags.get(key) in values for key, values in PLACE_TAGS.items()):
            continue
        if tags.get("access") in {"no", "private"}:
            continue
        name = tags.get("name:en") or tags.get("name")
        zh = tags.get("name:zh") or tags.get("name")
        if not name or not zh:
            continue
        if element["type"] == "node":
            coordinates = [element]
        elif element["type"] == "way":
            ids = element.get("nodes", [])
            if not ids or any(node not in nodes for node in ids):
                raise ValueError(f"Missing geometry for place way {element['id']}")
            coordinates = [nodes[node] for node in dict.fromkeys(ids)]
        else:
            continue
        points = [xy(node["lat"], node["lon"]) for node in coordinates]
        point = [(min(p[i] for p in points) + max(p[i] for p in points)) / 2 for i in range(2)]
        if not (left <= point[0] <= right and top <= point[1] <= bottom):
            continue
        places.append({"id": f"osm-{element['type']}-{element['id']}",
                       "name": name, "zh": zh, "point": point})
    places.sort(key=lambda place: place["id"])
    output = {"map_version": district["version"], "source": "OpenStreetMap contributors",
              "license": "ODbL-1.0", "source_timestamp": source.get("osm3s", {}).get("timestamp_osm_base"),
              "places": places}
    if not places:
        raise ValueError("No named destinations found in the OSM extract")
    output_path.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Prepared {len(places)} named places from the retained OSM extract")


if __name__ == "__main__":
    build(ROOT / "data/source.osm.json", ROOT / "data/district.json", ROOT / "data/places.json")
