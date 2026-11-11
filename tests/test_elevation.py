import math
from pathlib import Path
import unittest

from elevation import road_profiles, road_junctions, surface_pose, slope_speed_limit
from game import Game, RuleError, Session
from roads import DRIVING, Edge, RoadMap, project
from tools.prepare_elevation import building_height, road_layer_offset

ROOT = Path(__file__).resolve().parents[1]


class ElevationTests(unittest.TestCase):
    def junction(self):
        nodes = {"a": (-100, 0), "b": (0, 0), "c": (100, 0), "d": (0, 100)}
        heights = {"a": 0, "b": 5, "c": 10, "d": 15}
        edges = [Edge(key, a, b, way, 100, "", "", kind, False, "0", "no", "no", width=width)
                 for key, a, b, way, kind, width in [
                     ("ab", "a", "b", 1, "primary", 16), ("bc", "b", "c", 1, "primary", 16),
                     ("bd", "b", "d", 2, "residential", 8)]]
        profiles = road_profiles(nodes, heights, edges)
        junctions = road_junctions(nodes, edges, profiles, DRIVING["widths"])
        return nodes, heights, edges, profiles, junctions

    def test_main_road_keeps_grade_and_side_road_matches_entire_overlap(self):
        nodes, heights, edges, profiles, junctions = self.junction()
        self.assertEqual(profiles["ab"], [.05, .05])
        self.assertEqual(profiles["bc"], [.05, .05])
        self.assertNotIn("ab", junctions)
        self.assertNotIn("bc", junctions)
        for x in (-4, -2, 0, 2, 4):
            main = edges[0] if x < 0 else edges[1]
            for y in (0, 2, 4, 6, 8):
                a = surface_pose(nodes, heights, main, (x, y), 0, profiles, junctions)
                b = surface_pose(nodes, heights, edges[2], (x, y), 0, profiles, junctions)
                self.assertAlmostEqual(a["height"], b["height"])
                self.assertAlmostEqual(a["grade"], b["grade"])
        at = lambda y: surface_pose(nodes, heights, edges[2], (2, y), math.pi / 2, profiles, junctions)
        for y in (8.2, 16.2):
            self.assertLess(abs(at(y - 1e-5)["height"] - at(y + 1e-5)["height"]), 1e-4)
            self.assertLess(abs(at(y - 1e-5)["grade"] - at(y + 1e-5)["grade"]), 1e-4)
        y, h = 12, 1e-5
        self.assertAlmostEqual(at(y)["grade"], (at(y + h)["height"] - at(y - h)["height"]) / (2 * h), places=7)
        self.assertEqual(junctions, road_junctions(nodes, list(reversed(edges)), profiles, DRIVING["widths"]))

    def test_priority_blends_respect_actual_width_reverse_edges_and_separate_levels(self):
        from dataclasses import replace
        nodes, heights, edges, profiles, _ = self.junction()
        reverse = replace(edges[2], id="db", a="d", b="b")
        nodes.update({"u": nodes["b"], "v": nodes["d"]})
        heights.update({"u": 30, "v": 40})
        deck = replace(edges[2], id="bridge", a="u", b="v", way=3, bridge="yes", layer="1")
        all_edges = [*edges, reverse, deck]
        profiles = road_profiles(nodes, heights, all_edges)
        junctions = road_junctions(nodes, all_edges, profiles, DRIVING["widths"])
        self.assertNotIn("bridge", junctions)
        for y in (0, 4, 8, 12, 16, 20, 50):
            self.assertAlmostEqual(
                surface_pose(nodes, heights, edges[2], (2, y), 0, profiles, junctions)["height"],
                surface_pose(nodes, heights, reverse, (2, y), 0, profiles, junctions)["height"])

    def test_smooth_ramp_preserves_heights_and_continuous_grade(self):
        nodes = {"a": (0, 0), "b": (100, 0), "c": (200, 0), "d": (300, 0)}
        heights = {"a": 0, "b": 0, "c": 10, "d": 10}
        edges = [Edge(key, a, b, 1, 100, "", "", "primary", False, "0", "no", "no")
                 for key, a, b in [("ab", "a", "b"), ("bc", "b", "c"), ("cd", "c", "d")]]
        profiles = road_profiles(nodes, heights, edges)
        at = lambda edge, x: surface_pose(nodes, heights, edge, (x, 0), 0, profiles)
        self.assertEqual(at(edges[1], 125)["height"], 1.5625)
        self.assertEqual(at(edges[1], 125)["grade"], .1125)
        for before, after in zip(edges, edges[1:]):
            x = nodes[before.b][0]
            self.assertEqual(at(before, x)["height"], at(after, x)["height"])
            self.assertEqual(at(before, x)["grade"], at(after, x)["grade"])
            self.assertLess(abs(at(before, x - .001)["pitch"] - at(after, x + .001)["pitch"]), .0001)
        for x in range(101):
            self.assertTrue(0 <= at(edges[1], 100 + x)["height"] <= 10)
        reverse = Edge("reverse", "c", "b", 1, 100, "", "", "primary", False, "0", "no", "no")
        reverse_profiles = road_profiles(nodes, heights, [*edges, reverse])
        for x in (100, 125, 150, 175, 200):
            self.assertAlmostEqual(surface_pose(nodes, heights, reverse, (x, 0), 0, reverse_profiles)["height"],
                                   at(edges[1], x)["height"])
        self.assertEqual(profiles, road_profiles(nodes, heights, list(reversed(edges))))

    def test_junctions_flatten_and_disconnected_levels_do_not_blend(self):
        nodes = {"a": (0, 0), "b": (100, 0), "c": (200, 0), "d": (100, 100),
                 "u": (0, 0), "v": (100, 0)}
        heights = {"a": 0, "b": 5, "c": 15, "d": 5, "u": 30, "v": 40}
        edge = lambda key, a, b: Edge(key, a, b, 1, 100, "", "", "primary", False, "0", "no", "no")
        edges = [edge("ab", "a", "b"), edge("bc", "b", "c")]
        profiles = road_profiles(nodes, heights, edges)
        self.assertAlmostEqual(profiles["ab"][1], 1 / 15)
        self.assertAlmostEqual(profiles["bc"][0], 1 / 15)
        fork = road_profiles(nodes, heights, [*edges, edge("bd", "b", "d"), edge("uv", "u", "v")])
        self.assertEqual(fork["ab"][1], 0)
        self.assertEqual(fork["bc"][0], 0)
        self.assertEqual(fork["uv"], [.1, .1])

    def test_shared_surface_equations(self):
        edge = Edge("ab", "a", "b", 1, 100, "", "", "primary", False, "0", "no", "no")
        nodes, heights = {"a": (0, 0), "b": (100, 0)}, {"a": 5, "b": 15}
        self.assertEqual(surface_pose(nodes, heights, edge, (50, 2), 0),
                         {"height": 10, "grade": .1, "pitch": math.atan(.1)})
        self.assertEqual(surface_pose(nodes, heights, edge, (50, 0), math.pi)["grade"], -.1)
        self.assertEqual(slope_speed_limit(40, .1), 32)
        self.assertEqual(surface_pose(nodes, None, edge, (50, 0), 0)["height"], 0)

    def test_building_height_provenance(self):
        self.assertEqual(building_height({"height": "255"})[0], 255)
        self.assertEqual(building_height({"building:levels": "10"}), (32, "estimated-levels-times-3.2m"))
        for value in ("NaN", "-1", "bad", "10000"):
            self.assertEqual(building_height({"height": value}), (18, "estimated-default-18m"))

    def test_road_layer_offsets_apply_without_bridge_or_tunnel_tags(self):
        edge = {"layer": "1", "bridge": "no", "tunnel": "no"}
        self.assertEqual(road_layer_offset(edge), 6)
        edge["layer"] = "2"
        self.assertEqual(road_layer_offset(edge), 12)
        edge["layer"] = "-1"
        self.assertEqual(road_layer_offset(edge), -6)
        edge.update(layer="0", bridge="yes")
        self.assertEqual(road_layer_offset(edge), 6)
        edge.update(bridge="no", tunnel="yes")
        self.assertEqual(road_layer_offset(edge), -6)
        edge.update(tunnel="building_passage")
        self.assertEqual(road_layer_offset(edge), 0)

    def test_packaged_curves_preserve_unblended_heights_and_all_junctions_connect(self):
        roads = RoadMap(ROOT / "data/district.json")
        node_surfaces = {}
        for edge in roads.edges.values():
            a, b = roads.nodes[edge.a], roads.nodes[edge.b]
            low, high = sorted(roads.elevation["node_heights"][node] for node in (edge.a, edge.b))
            for t in (0, .1, .25, .5, .75, .9, 1):
                point = tuple(a[i] + (b[i] - a[i]) * t for i in range(2))
                height = roads.surface(edge, point, 0)["height"]
                self.assertTrue(math.isfinite(height), edge.id)
                if (edge.id not in roads.elevation["road_junctions"]
                        and edge.id not in roads.elevation["tunnel_profiles"]):
                    self.assertGreaterEqual(height, low - 1e-9, edge.id)
                    self.assertLessEqual(height, high + 1e-9, edge.id)
            for node, point in ((edge.a, a), (edge.b, b)):
                height = roads.surface(edge, point, 0)["height"]
                self.assertAlmostEqual(height, node_surfaces.setdefault(node, height), places=6, msg=node)
                if edge.id not in roads.elevation["road_junctions"]:
                    self.assertAlmostEqual(height, roads.elevation["node_heights"][node])

    def test_connected_forks_require_compatible_surface_heights(self):
        roads = RoadMap(ROOT / "data/district.json")
        roads.nodes = {"a": (0, 0), "b": (100, 0), "c": (200, 0), "d": (200, 0)}
        roads.elevation = {"node_heights": {"a": 5, "b": 5, "c": 5, "d": 17}}
        ground = Edge("ground", "b", "c", 1, 100, "", "", "primary", False, "0", "no", "no")
        deck = Edge("deck", "b", "d", 2, 100, "", "", "primary", False, "1", "yes", "no")
        roads.outgoing = {"b": [ground, deck]}
        roads.bounds = [-100, -100, 300, 100]
        match = roads.corridor_match((108, 0), 0, ground, check_body=False)
        self.assertEqual(match.edge.id, "ground")
        self.assertEqual(roads.surface(ground, (100, 0), 0)["height"],
                         roads.surface(deck, (100, 0), 0)["height"])

    def test_packaged_side_road_overlaps_match_the_highest_priority_surface(self):
        roads = RoadMap(ROOT / "data/district.json")
        samples = 0
        for key, owners in roads.elevation["road_junctions"].items():
            if key.startswith("~"):
                continue
            edge = roads.edges[key]
            a, b = roads.nodes[edge.a], roads.nodes[edge.b]
            length = math.dist(a, b)
            for t in (0, .025, .05, .1, .25, .5, .75, .9, .95, .975, 1):
                for side in (-.45, 0, .45):
                    offset = (edge.width or 10) * side / length
                    point = (a[0] + (b[0] - a[0]) * t - (b[1] - a[1]) * offset,
                             a[1] + (b[1] - a[1]) * t + (b[0] - a[0]) * offset)
                    covering = [owner for owner in owners if project(
                        point, roads.nodes[owner["a"]], roads.nodes[owner["b"]])[1] <= owner["radius"]]
                    if not covering:
                        continue
                    owner = min(covering, key=lambda o: (o["priority"], project(
                        point, roads.nodes[o["a"]], roads.nodes[o["b"]])[1] - o["radius"], o["id"]))
                    difference = abs(roads.surface(edge, point, 0)["height"] -
                                     roads.surface(roads.edges[owner["id"]], point, 0)["height"])
                    self.assertLessEqual(difference, .005, (key, owner["id"], point))
                    samples += 1
        self.assertGreater(samples, 10000)

    def test_pilot_level_and_server_speed_validation(self):
        roads = RoadMap(ROOT / "data/district.json")
        game = Game(roads)
        pilot = roads.elevation["pilot"]
        bridge, ground = roads.edges[pilot["bridge"]], roads.edges[pilot["ground"]]
        point = tuple(pilot["point"])
        heading = math.atan2(roads.nodes[bridge.b][1] - roads.nodes[bridge.a][1],
                             roads.nodes[bridge.b][0] - roads.nodes[bridge.a][0])
        self.assertGreater(roads.surface(bridge, point, heading)["height"]
                           - roads.surface(ground, point, heading)["height"], 4)
        self.assertNotIn(ground.id, [e.id for e in roads.corridor_edges(point, bridge)])
        # Select a steep real packaged edge, so the server rejects a flat-road cap.
        edge = max(roads.edges.values(), key=lambda e: abs(roads.surface(e, roads.nodes[e.a],
                   math.atan2(roads.nodes[e.b][1] - roads.nodes[e.a][1],
                              roads.nodes[e.b][0] - roads.nodes[e.a][0]))["grade"]))
        heading = math.atan2(roads.nodes[edge.b][1] - roads.nodes[edge.a][1],
                             roads.nodes[edge.b][0] - roads.nodes[edge.a][0])
        point = tuple((a + b) / 2 for a, b in zip(roads.nodes[edge.a], roads.nodes[edge.b]))
        session = Session("elevation-test", point, heading, edge.id, (edge.way,), paused=False)
        session.next_offer = session.next_citizen = math.inf
        payload = dict(x=point[0], y=point[1], heading=heading, speed=DRIVING["max_speed"], dt=0)
        with self.assertRaisesRegex(RuleError, "slope limit"):
            game.update_position(session, payload)
        payload["speed"] = roads.speed_limit(edge, point, heading)
        game.update_position(session, payload)
        self.assertEqual(session.speed, payload["speed"])

    def test_gascoigne_flyover_crosses_drivable_nathan_road(self):
        roads = RoadMap(ROOT / "data/district.json")
        upper = roads.edges["452590572:1:1172166368"]
        lower = roads.edges["102506132:4:4353485231"]
        point = (174.75, 539.13)
        self.assertEqual((upper.kind, upper.layer, upper.bridge), ("trunk", "1", "yes"))
        self.assertGreater(roads.surface(upper, point, 0)["height"]
                           - roads.surface(lower, point, 0)["height"], 5.65)
        for current, other in ((upper, lower), (lower, upper)):
            self.assertTrue(roads.body_fits(point, roads.angle(current), current))
            self.assertNotIn(other.id, {edge.id for edge in roads.corridor_edges(point, current)})


if __name__ == "__main__":
    unittest.main()
