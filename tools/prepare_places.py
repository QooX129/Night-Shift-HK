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
PLACE_POPULARITY = {
    "tourism=attraction": 3.0, "tourism=hotel": 2.2, "tourism=hostel": 1.7,
    "tourism=museum": 2.6, "tourism=gallery": 2.2, "tourism=guest_house": 1.6,
    "amenity=arts_centre": 2.1, "amenity=cinema": 2.5, "amenity=community_centre": 1.6,
    "amenity=hospital": 2.0, "amenity=clinic": 1.5, "amenity=library": 1.8,
    "amenity=marketplace": 2.5, "amenity=restaurant": 2.1, "amenity=school": 1.4,
    "amenity=theatre": 2.4, "amenity=university": 2.3, "amenity=place_of_worship": 1.8,
    "shop=department_store": 2.7, "shop=mall": 3.0, "shop=supermarket": 2.2,
    "leisure=park": 2.3, "leisure=sports_centre": 2.2, "leisure=stadium": 2.8,
    "leisure=garden": 1.8, "railway=station": 2.8,
}


def build(source_path: Path, map_path: Path, output_path: Path) -> None:
    source = json.loads(source_path.read_text(encoding="utf-8"))
    district = json.loads(map_path.read_text(encoding="utf-8"))
    elements = {}
    for element in source["elements"]:
        key = (element["type"], element["id"])
        if key not in elements or element.get("tags"):
            elements[key] = element
    nodes = {key[1]: element for key, element in elements.items() if key[0] == "node"}
    left, top, right, bottom = district["bounds"]
    places = {}

    def feature_point(element: dict) -> list[float] | None:
        if element["type"] == "node":
            coordinates = [element]
        elif element["type"] == "way":
            ids = element.get("nodes", [])
            if not ids or any(node not in nodes for node in ids):
                raise ValueError(f"Missing geometry for place way {element['id']}")
            coordinates = [nodes[node] for node in dict.fromkeys(ids)]
        else:
            return None
        points = [xy(node["lat"], node["lon"]) for node in coordinates]
        point = [(min(p[i] for p in points) + max(p[i] for p in points)) / 2 for i in range(2)]
        if left <= point[0] <= right and top <= point[1] <= bottom:
            return point
        return None

    for element in elements.values():
        tags = element.get("tags", {})
        if (
            tags.get("access") in {"no", "private"}
            or not any(tags.get(key) in values for key, values in PLACE_TAGS.items())
        ):
            continue
        point = feature_point(element)
        name = tags.get("name:en") or tags.get("name")
        zh = tags.get("name:zh") or tags.get("name")
        if point is None or not name or not zh:
            continue
        category = next(
            f"{key}={tags[key]}"
            for key, values in PLACE_TAGS.items()
            if tags.get(key) in values
        )
        places[(element["type"], element["id"])] = {
            "id": f"osm-{element['type']}-{element['id']}",
            "name": name, "zh": zh, "point": point,
            "category": category, "popularity": PLACE_POPULARITY[category],
            "parking_entrances": [],
        }

    parking = {
        key: element for key, element in elements.items()
        if element.get("tags", {}).get("amenity") == "parking"
        and element.get("tags", {}).get("access") not in {"no", "private"}
    }
    for relation in elements.values():
        if relation["type"] != "relation" or relation.get("tags", {}).get("type") != "site":
            continue
        members = relation.get("members", [])
        place_refs = [places[(m["type"], m["ref"])] for m in members
                      if (m["type"], m["ref"]) in places]
        parking_refs = [parking[(m["type"], m["ref"])] for m in members
                        if (m["type"], m["ref"]) in parking]
        if not place_refs or not parking_refs:
            continue
        entrance_points = []
        for member in members:
            if member["type"] != "node" or member.get("role") not in {"entrance", "access"}:
                continue
            entrance = nodes.get(member["ref"])
            point = feature_point(entrance) if entrance else None
            if point:
                entrance_points.append(point)
        for carpark in parking_refs:
            if carpark["type"] == "way":
                for node_id in carpark.get("nodes", []):
                    node = nodes[node_id]
                    if node.get("tags", {}).get("entrance") or node.get("tags", {}).get("highway") == "entrance":
                        point = feature_point(node)
                        if point:
                            entrance_points.append(point)
        for place in place_refs:
            place["parking_entrances"] = sorted({
                tuple(point) for point in entrance_points
            })
            place["parking_entrances"] = [list(point) for point in place["parking_entrances"]]

    taxi_stands = []
    no_stopping_ways = []
    no_stopping_points = []
    for element in elements.values():
        tags = element.get("tags", {})
        if element["type"] == "way" and "highway" in tags and any(
            ("parking" in key or "stopping" in key)
            and "no_stopping" in value
            for key, value in tags.items()
        ):
            no_stopping_ways.append(element["id"])
        if element["type"] == "node" and (
            tags.get("highway") in {"crossing", "traffic_signals", "bus_stop"}
            or tags.get("public_transport") in {"stop_position", "platform"}
        ):
            point = feature_point(element)
            if point:
                no_stopping_points.append(point)
        if (
            tags.get("amenity") != "taxi"
            and tags.get("taxi") not in {"stand", "station", "rank"}
        ) or tags.get("access") in {"no", "private"}:
            continue
        point = feature_point(element)
        if point is None:
            continue
        taxi_stands.append({
            "id": f"osm-{element['type']}-{element['id']}",
            "name": tags.get("name:en") or tags.get("name") or "Taxi stand",
            "zh": tags.get("name:zh") or tags.get("name") or "的士站",
            "point": point,
        })

    places = sorted(places.values(), key=lambda place: place["id"])
    taxi_stands.sort(key=lambda stop: stop["id"])
    output = {"map_version": district["version"], "source": "OpenStreetMap contributors",
              "license": "ODbL-1.0", "source_timestamp": source.get("osm3s", {}).get("timestamp_osm_base"),
              "places": places, "taxi_stands": taxi_stands,
              "no_stopping_ways": sorted(no_stopping_ways),
              "no_stopping_points": no_stopping_points}
    if not places:
        raise ValueError("No named destinations found in the OSM extract")
    output_path.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Prepared {len(places)} named places from the retained OSM extract")


if __name__ == "__main__":
    build(ROOT / "data/source.osm.json", ROOT / "data/district.json", ROOT / "data/places.json")
