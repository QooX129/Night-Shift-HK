import json
import unittest

from fastapi.testclient import TestClient

from app import app, roads, visual_map
from map_streaming import VisualMap


class MapStreamingTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_bootstrap_preserves_all_driving_and_elevation_data(self):
        response = self.client.get("/api/map?stream=true")
        self.assertEqual(response.status_code, 200)
        core = response.json()
        self.assertEqual(core["backdrop"], [])
        for key in ("nodes", "edges", "driving", "restrictions", "branch_levels"):
            self.assertEqual(core[key], json.loads(json.dumps(roads.document[key])))
        for key, value in roads.document["elevation"].items():
            if key != "buildings":
                self.assertEqual(core["elevation"][key], json.loads(json.dumps(value)))
        self.assertEqual(core["elevation"]["buildings"], [])
        self.assertLess(len(response.content), len(json.dumps(roads.document).encode()))
        self.assertEqual(self.client.get("/api/map").json()["backdrop"],
                         json.loads(json.dumps(roads.document["backdrop"])))

    def test_chunks_reconstruct_every_shape_and_building_metadata(self):
        shapes = {}
        for content in visual_map.chunks.values():
            chunk = json.loads(content)
            self.assertEqual(chunk["version"], visual_map.version)
            for shape in chunk["backdrop"]:
                shapes[shape["id"]] = shape
        self.assertEqual(len(shapes), len(roads.document["backdrop"]))
        metadata = {item["index"]: item for item in roads.document["elevation"]["buildings"]}
        for index, original in enumerate(roads.document["backdrop"]):
            self.assertEqual(shapes[index]["points"], json.loads(json.dumps(original["points"])))
            self.assertEqual(shapes[index]["kind"], original["kind"])
            if index in metadata:
                self.assertEqual(shapes[index]["building"], metadata[index])

    def test_elevated_park_layer_survives_overview_and_chunks(self):
        index, park = next((index, shape) for index, shape in enumerate(roads.document["backdrop"])
                           if shape.get("osm_way") == 185084371)
        core = json.loads(visual_map.core)
        self.assertEqual(park["layer"], "2")
        self.assertEqual(core["overview"][index]["layer"], park["layer"])
        chunks = [shape for content in visual_map.chunks.values()
                  for shape in json.loads(content)["backdrop"] if shape["id"] == index]
        self.assertTrue(chunks)
        self.assertTrue(all(shape["layer"] == park["layer"] for shape in chunks))

    def test_versioned_chunks_revalidate_and_reject_missing_or_stale_data(self):
        key = next(iter(visual_map.chunks))
        x, y = key.split(":")
        url = f"/api/map/chunks/{visual_map.version}/{x}/{y}"
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        self.assertIn("immutable", response.headers["cache-control"])
        self.assertEqual(self.client.get(url, headers={"If-None-Match": response.headers["etag"]}).status_code, 304)
        self.assertEqual(self.client.get(f"/api/map/chunks/outdated/{x}/{y}").status_code, 409)
        self.assertEqual(self.client.get(f"/api/map/chunks/{visual_map.version}/99999/99999").status_code, 404)
        core = self.client.get("/api/map?stream=true")
        self.assertEqual(self.client.get("/api/map?stream=true",
                                        headers={"If-None-Match": core.headers["etag"]}).status_code, 304)

    def test_chunk_membership_includes_cross_boundary_footprints_and_negative_coordinates(self):
        document = {"backdrop": [{"kind": "building", "points": [[-10, -10], [270, -10], [270, 10]]}]}
        first = VisualMap(document)
        self.assertEqual(set(first.chunks), {"-1:-1", "0:-1", "1:-1", "-1:0", "0:0", "1:0"})
        second = VisualMap(document)
        self.assertEqual(first.version, second.version)
        document["backdrop"][0]["points"][0][0] = -11
        self.assertNotEqual(first.version, VisualMap(document).version)
