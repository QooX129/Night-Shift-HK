import math
from pathlib import Path
import unittest

from elevation import surface_pose, slope_speed_limit
from game import Game, RuleError, Session
from roads import DRIVING, Edge, RoadMap
from tools.prepare_elevation import building_height

ROOT = Path(__file__).resolve().parents[1]


class ElevationTests(unittest.TestCase):
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
        payload = dict(x=point[0], y=point[1], heading=heading, speed=DRIVING["max_speed"], dt=0)
        with self.assertRaisesRegex(RuleError, "slope limit"):
            game.update_position(session, payload)
        payload["speed"] = roads.speed_limit(edge, point, heading)
        game.update_position(session, payload)
        self.assertEqual(session.speed, payload["speed"])


if __name__ == "__main__":
    unittest.main()
