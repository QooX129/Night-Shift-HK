import json
import math
from pathlib import Path
import tempfile
import unittest

from roads import DRIVING, RoadMap
from tools.prepare_map import xy
from tools.prepare_road_widths import GAP, MIN_WIDTH, parallel_spacing, prepare, tagged_width

ROOT = Path(__file__).resolve().parents[1]


class RoadScaleTests(unittest.TestCase):
    def test_waterloo_short_slip_road_cannot_block_main_road(self):
        roads = RoadMap(ROOT / "data/district.json")
        side = roads.edges["102640421:1:6357916725"]
        main = roads.edges["1212555896:1:6357916726"]
        point = (448.7525, -274.046)
        heading = roads.angle(main)
        self.assertTrue(roads.body_fits(point, heading, main))
        self.assertTrue(roads.body_fits(point, heading, side))
        match = roads.corridor_match(point, heading, side)
        self.assertIsNotNone(match)
        self.assertEqual(match.edge.way, main.way)

    def test_width_tags_and_lane_estimates(self):
        self.assertEqual(tagged_width({"highway": "primary", "lanes": "2"}), (6, "estimated-osm-lanes-times-3m"))
        self.assertEqual(tagged_width({"highway": "residential", "lanes": "1", "oneway": "yes"})[0], 3)
        self.assertEqual(tagged_width({"highway": "residential", "width": "4.5 m", "lanes": "2"}), (4.5, "osm-width"))
        self.assertAlmostEqual(tagged_width({"highway": "service", "width": "10 ft"})[0], 3.048)
        for invalid in ("NaN", "-3", "100", "3;4"):
            self.assertEqual(tagged_width({"highway": "service", "width": invalid})[1], "estimated-road-class")

    def test_parallel_roads_shrink_but_junctions_and_stacked_crossings_do_not(self):
        nodes = {"a": [0, 0], "b": [100, 0], "c": [0, 4.6], "d": [100, 4.6]}
        first = dict(a="a", b="b", way=1, layer="0", bridge="no", tunnel="no")
        second = dict(a="c", b="d", way=2, layer="0", bridge="no", tunnel="no")
        self.assertEqual(parallel_spacing(first, second, nodes, set()), 4.6)
        self.assertIsNone(parallel_spacing(first, dict(second, layer="1", bridge="yes"), nodes, set()))
        self.assertIsNone(parallel_spacing(first, dict(second, a="b"), nodes, {"b"}))
        document = {"version": "fixture", "nodes": nodes, "edges": [
            dict(first, id="one", kind="residential"), dict(second, id="two", kind="primary"),
        ]}
        source = {"elements": [
            {"type": "way", "id": 1, "tags": {"highway": "residential", "lanes": "1"}},
            {"type": "way", "id": 2, "tags": {"highway": "primary", "lanes": "2"}},
            {"type": "way", "id": 1},  # Overpass repeats untagged skeletons.
        ]}
        result = prepare(document, source)
        widths = [item["width"] for item in result["values"].values()]
        self.assertTrue(all(width >= MIN_WIDTH for width in widths))
        self.assertLessEqual(sum(widths) / 2 + GAP, 4.6)
        self.assertEqual(result["conflicts"], [])
        nodes["c"][1] = nodes["d"][1] = 2
        self.assertEqual(len(prepare(document, source)["conflicts"]), 1)

    def test_packaged_widths_are_reproducible_and_every_constraint_has_clearance(self):
        document = json.loads((ROOT / "data/district.json").read_text())
        source = json.loads((ROOT / "data/source.osm.json").read_text())
        package = json.loads((ROOT / "data/road-widths.json").read_text())
        regenerated = prepare(document, source)
        for field in ("values", "spacing_checks", "audit", "conflicts", "warnings"):
            self.assertEqual(package[field], regenerated[field])
        self.assertEqual(package["conflicts"], [])
        self.assertGreater(package["audit"]["spacing_constrained"], 50)
        for check in package["spacing_checks"]:
            first, second = (package["values"][check[key]]["width"] for key in ("first", "second"))
            self.assertLessEqual((first + second) / 2 + GAP, check["spacing_m"] + 1e-8)

    def test_real_ferry_ching_ping_gap_taxi_fit_and_reverse_width(self):
        roads = RoadMap(ROOT / "data/district.json")
        side = roads.edges["485635353:2:6505945379"]
        main = roads.edges["1067815827:9:13108528146"]
        nodes = roads.document["nodes"]
        spacing = parallel_spacing(vars_edge(side), vars_edge(main), nodes, set())
        self.assertAlmostEqual(spacing, 4.5979747153)
        self.assertLessEqual(roads.radius(side) + roads.radius(main) + GAP, spacing)
        self.assertLess(side.width, 3.01)
        self.assertLess(main.width, 6.01)
        for edge in (side, main):
            reverse = roads.edges[f"~{edge.id}"]
            self.assertEqual(reverse.width, edge.width)
            a, b = roads.nodes[edge.a], roads.nodes[edge.b]
            point = tuple((x + y) / 2 for x, y in zip(a, b))
            heading = math.atan2(b[1] - a[1], b[0] - a[0])
            self.assertTrue(roads.body_fits(point, heading, edge))
        self.assertGreater(DRIVING["taxi_length"], DRIVING["taxi_width"])
        self.assertLess(DRIVING["taxi_width"], min(side.width, main.width))

    def test_geographic_metres_are_unchanged(self):
        document = json.loads((ROOT / "data/district.json").read_text())
        source = json.loads((ROOT / "data/source.osm.json").read_text())
        raw_nodes = {str(item["id"]): item for item in source["elements"] if item["type"] == "node"}
        for key in ("6505945379", "13108528146", "7121972975"):
            raw = raw_nodes[key]
            self.assertEqual(document["nodes"][key], xy(raw["lat"], raw["lon"]))
        roads = RoadMap(ROOT / "data/district.json")
        for edge in roads.edges.values():
            self.assertLess(abs(math.dist(roads.nodes[edge.a], roads.nodes[edge.b]) - edge.length), .006)

    def test_stale_package_is_an_explicit_error(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "map.json"
            path.write_text('{"version":"new"}')
            path.with_name("road-widths.json").write_text('{"map_version":"old"}')
            with self.assertRaisesRegex(ValueError, "Road-width package is stale"):
                RoadMap(path)


def vars_edge(edge):
    return {name: getattr(edge, name) for name in ("a", "b", "way", "layer", "bridge", "tunnel")}
