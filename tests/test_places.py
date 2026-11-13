import json
import math
from pathlib import Path
import random
import tempfile
import unittest

from fastapi.testclient import TestClient

from app import app
from game import Game
from roads import RoadMap
from tools.prepare_places import build


ROOT = Path(__file__).resolve().parents[1]


class PlaceTests(unittest.TestCase):
    def test_extract_named_nodes_and_ways_filters_private_and_outside(self):
        source = {"osm3s": {"timestamp_osm_base": "2026-01-01"}, "elements": [
            {"type": "node", "id": 1, "lat": 22.314, "lon": 114.1695,
             "tags": {"tourism": "museum", "name:en": "Museum", "name:zh": "博物館"}},
            {"type": "node", "id": 2, "lat": 22.3141, "lon": 114.1696},
            {"type": "way", "id": 3, "nodes": [1, 2, 1],
             "tags": {"leisure": "park", "name": "Park"}},
            {"type": "node", "id": 4, "lat": 22.314, "lon": 114.1695,
             "tags": {"tourism": "hotel", "name": "Private", "access": "private"}},
            {"type": "node", "id": 5, "lat": 23, "lon": 114,
             "tags": {"tourism": "hotel", "name": "Outside"}},
        ]}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "source.json").write_text(json.dumps(source), encoding="utf-8")
            (path / "map.json").write_text(json.dumps({"version": "test", "bounds": [-50, -50, 50, 50]}))
            build(path / "source.json", path / "map.json", path / "places.json")
            result = json.loads((path / "places.json").read_text(encoding="utf-8"))
        self.assertEqual(result["map_version"], "test")
        self.assertEqual(result["source_timestamp"], "2026-01-01")
        self.assertEqual([p["id"] for p in result["places"]], ["osm-node-1", "osm-way-3"])
        self.assertEqual((result["places"][0]["name"], result["places"][0]["zh"]), ("Museum", "博物館"))
        self.assertEqual(result["places"][1]["zh"], "Park")

    def test_packaged_places_are_reproducible(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "places.json"
            build(ROOT / "data/source.osm.json", ROOT / "data/district.json", output)
            self.assertEqual(output.read_bytes(), (ROOT / "data/places.json").read_bytes())

    def test_extracts_popularity_taxi_stands_and_explicit_parking_entrances(self):
        source = {"elements": [
            {"type": "node", "id": 1, "lat": 22.314, "lon": 114.1695,
             "tags": {"shop": "mall", "name": "Mall"}},
            {"type": "node", "id": 2, "lat": 22.3141, "lon": 114.1696,
             "tags": {"entrance": "yes", "highway": "crossing"}},
            {"type": "node", "id": 3, "lat": 22.3142, "lon": 114.1695,
             "tags": {"amenity": "taxi"}},
            {"type": "way", "id": 4, "nodes": [1, 2, 1],
             "tags": {"amenity": "parking"}},
            {"type": "way", "id": 5, "nodes": [1, 2],
             "tags": {"highway": "residential", "parking:left:restriction:conditional":
                      "no_stopping @ (07:00-19:00)"}},
            {"type": "relation", "id": 6, "tags": {"type": "site"}, "members": [
                {"type": "node", "ref": 1, "role": ""},
                {"type": "way", "ref": 4, "role": ""},
            ]},
            {"type": "node", "id": 2, "lat": 22.3141, "lon": 114.1696},
        ]}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "source.json").write_text(json.dumps(source), encoding="utf-8")
            (path / "map.json").write_text(json.dumps({"version": "test", "bounds": [-50, -50, 50, 50]}))
            build(path / "source.json", path / "map.json", path / "places.json")
            result = json.loads((path / "places.json").read_text(encoding="utf-8"))
        self.assertEqual(result["places"][0]["category"], "shop=mall")
        self.assertGreater(result["places"][0]["popularity"], 1)
        self.assertEqual(len(result["places"][0]["parking_entrances"]), 1)
        self.assertEqual([stand["id"] for stand in result["taxi_stands"]], ["osm-node-3"])
        self.assertEqual(result["no_stopping_ways"], [5])
        self.assertEqual(len(result["no_stopping_points"]), 1)

    def test_stale_place_package_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "map.json").write_text(json.dumps({"version": "new"}))
            (path / "places.json").write_text(json.dumps({"map_version": "old", "places": []}))
            with self.assertRaisesRegex(ValueError, "Place package is stale"):
                RoadMap(path / "map.json")

    def test_place_package_without_stop_metadata_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "map.json").write_text(json.dumps({"version": "test"}))
            (path / "places.json").write_text(json.dumps({"map_version": "test", "places": []}))
            with self.assertRaisesRegex(ValueError, "lacks stop metadata"):
                RoadMap(path / "map.json")

    def test_place_source_download(self):
        response = TestClient(app).get("/api/places")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), json.loads((ROOT / "data/places.json").read_text(encoding="utf-8")))

    def test_real_places_generate_reachable_random_destinations(self):
        roads = RoadMap(ROOT / "data/district.json")
        game = Game(roads)
        place_stops = [s for s in game.destination_stops if s.id.startswith("osm-")]
        self.assertGreater(len(place_stops), 40)
        self.assertTrue(any("Langham Place" in s.name for s in place_stops))
        self.assertTrue(any("朗豪坊" in s.zh for s in place_stops))
        self.assertFalse(any(s.id.startswith("osm-") for s in game.street_stops))
        data = game.create()
        session = game.sessions[data["id"]]
        session.rng = random.Random(2026)
        named = set()
        for _ in range(50):
            order = game.make_order(session)
            destination = game.stops[order.destination]
            origin = game.stops[order.pickup]
            self.assertGreaterEqual(math.dist(order.pickup_point, order.destination_point), 60)
            edge = roads.edges[origin.edge]
            self.assertTrue(roads.route(edge, roads.edges[destination.edge], (edge.way,), set(), {}))
            if destination.id.startswith("osm-"):
                named.add(destination.id)
        self.assertGreaterEqual(len(named), 3)


if __name__ == "__main__":
    unittest.main()
