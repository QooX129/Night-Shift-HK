import math
import unittest
from dataclasses import replace
from pathlib import Path

from elevation import surface_pose
from roads import DRIVING, Edge, RoadMap, project
from tunnel_clearance import _ground, _interval, _portal_approaches, _underground, correct_tunnel_clearance


ROOT = Path(__file__).resolve().parents[1]


def edge(key, a, b, way, length, *, tunnel="no", layer="0", width=10):
    return Edge(key, a, b, way, length, "", "", "primary", False, layer, "no", tunnel, width=width)


class TunnelClearanceTests(unittest.TestCase):
    def test_oblique_overlap_reverse_profile_and_smooth_ramps(self):
        nodes = {"a": (0, 0), "b": (200, 0), "c": (75, -30), "d": (125, 30)}
        heights = {"a": 5, "b": 5, "c": 8, "d": 12}
        tunnel = edge("t", "a", "b", 1, 200, tunnel="yes", layer="-1")
        reverse = replace(tunnel, id="reverse", a="b", b="a")
        ground = edge("g", "c", "d", 2, math.dist(nodes["c"], nodes["d"]), width=14)
        heights, profiles, junctions, pieces = correct_tunnel_clearance(
            nodes, heights, [tunnel, reverse, ground], DRIVING["widths"])
        at = lambda e, p, heading=0: surface_pose(nodes, heights, e, p, heading, profiles, junctions, pieces)
        for x in range(60, 141):
            for y in range(-5, 6):
                p = (x, y)
                if project(p, nodes["c"], nodes["d"])[1] <= 7:
                    self.assertGreaterEqual(at(ground, p)["height"] - at(tunnel, p)["height"], 6)
                self.assertAlmostEqual(at(tunnel, p)["height"], at(reverse, p)["height"], places=9)
        for t, _ in pieces["t"][1:-1]:
            x = t * 200
            self.assertLess(abs(at(tunnel, (x - 1e-5, 0))["grade"]
                                - at(tunnel, (x + 1e-5, 0))["grade"]), 1e-4)
        for x in (20, 50, 80, 120, 150, 180):
            numerical = (at(tunnel, (x + 1e-4, 0))["height"]
                         - at(tunnel, (x - 1e-4, 0))["height"]) / .0002
            self.assertAlmostEqual(at(tunnel, (x, 0))["grade"], numerical, places=6)
        for x in range(201):
            self.assertLessEqual(abs(at(tunnel, (x, 0))["grade"]), .120001)

    def test_connected_portal_approach_is_exempt_and_building_passage_unchanged(self):
        nodes = {"a": (-20, 0), "b": (-2, 0), "c": (0, 0), "d": (3, 0), "e": (15, 0),
                 "f": (0, 30), "g": (20, 30)}
        heights = {node: 5 for node in nodes}
        edges = [edge("g1", "a", "b", 1, 18), edge("g2", "b", "c", 1, 2),
                 edge("t1", "c", "d", 2, 3, tunnel="yes", layer="-1"),
                 edge("t2", "d", "e", 2, 12, tunnel="yes", layer="-1"),
                 edge("passage", "f", "g", 3, 20, tunnel="building_passage")]
        corrected, profiles, junctions, pieces = correct_tunnel_clearance(nodes, heights, edges, DRIVING["widths"])
        self.assertEqual(corrected, heights)
        self.assertNotIn("t1", pieces)
        self.assertNotIn("t2", pieces)
        self.assertNotIn("passage", pieces)
        for e in edges:
            for node in (e.a, e.b):
                self.assertAlmostEqual(surface_pose(nodes, corrected, e, nodes[node], 0,
                                                    profiles, junctions, pieces)["height"], 5)

    def test_district_footprints_and_central_kowloon_bypass(self):
        roads = RoadMap(ROOT / "data/district.json")
        physical = {}
        for e in roads.edges.values():
            physical.setdefault((e.way, *sorted((e.a, e.b))), e)
        tunnel = [e for e in physical.values() if _underground(e)]
        ground = [e for e in physical.values() if _ground(e)]
        exempt = _portal_approaches(tunnel, ground)
        samples, bypass_samples = 0, 0
        for e in tunnel:
            a, b = roads.nodes[e.a], roads.nodes[e.b]
            dx, dy = b[0] - a[0], b[1] - a[1]
            length = math.hypot(dx, dy)
            for surface in ground:
                if surface.id in exempt[e.id]:
                    continue
                c, d = roads.nodes[surface.a], roads.nodes[surface.b]
                reach = roads.radius(e) + roads.radius(surface)
                if (max(a[0], b[0]) + reach < min(c[0], d[0]) or
                    max(c[0], d[0]) + reach < min(a[0], b[0]) or
                    max(a[1], b[1]) + reach < min(c[1], d[1]) or
                    max(c[1], d[1]) + reach < min(a[1], b[1])):
                    continue
                overlap = _interval(a, b, c, d, reach)
                if overlap is None:
                    continue
                for i in range(11):
                    t = overlap[0] + (overlap[1] - overlap[0]) * i / 10
                    for j in range(-4, 5):
                        side = roads.radius(e) * j / 4
                        point = (a[0] + dx * t - dy * side / length,
                                 a[1] + dy * t + dx * side / length)
                        if project(point, c, d)[1] > roads.radius(surface) + 1e-8:
                            continue
                        difference = roads.surface(surface, point, 0)["height"] - roads.surface(e, point, 0)["height"]
                        self.assertGreaterEqual(difference, 6, (e.id, surface.id, point))
                        samples += 1
                        if e.id == "504423499:2:13108582004" and surface.id == "1389172580:0:12859244962":
                            bypass_samples += 1
        self.assertGreater(samples, 500)
        self.assertGreater(bypass_samples, 0)


if __name__ == "__main__":
    unittest.main()
