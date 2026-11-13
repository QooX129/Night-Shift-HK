import math
import random
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from game import Game
from pedestrians import Sidewalks, advance_walk, path_pose, segment_distance
from roads import Edge


class SidewalkTests(unittest.TestCase):
    def roads(self, buildings=()):
        edge = Edge("ab", "a", "b", 1, 100, "Street", "Street", "residential",
                    False, "0", "no", "no", width=10)
        return SimpleNamespace(
            bounds=[-20, -40, 120, 40], nodes={"a": (0, 0), "b": (100, 0)},
            edges={"ab": edge}, document={"backdrop": [
                {"kind": "building", "points": points} for points in buildings
            ]},
        )

    def test_paths_stay_outside_roads_and_split_at_buildings(self):
        sidewalks = Sidewalks(self.roads([[(40, 6), (60, 6), (60, 15), (40, 15)]]))
        paths = sidewalks.paths(sidewalks.edges[0])
        self.assertEqual({side for side, _ in paths}, {-1, 1})
        self.assertGreater(len(paths), 2)
        for side, points in paths:
            self.assertTrue(sidewalks.safe(*points))
            self.assertTrue(all(abs(p[1]) > 5 for p in points))
        self.assertFalse(sidewalks.safe((30, 7), (70, 7)))
        self.assertFalse(sidewalks.safe((30, 7), (30, -7)))
        self.assertFalse(sidewalks.safe((50, 8), (51, 8)))

    def test_narrow_buildings_between_samples_cannot_be_crossed(self):
        sidewalks = Sidewalks(self.roads([[(40.8, 6), (41.2, 6), (41.2, 9), (40.8, 9)]]))
        for _, points in sidewalks.paths(sidewalks.edges[0]):
            self.assertTrue(sidewalks.safe(*points))
            if points[0][1] > 0:
                self.assertFalse(points[0][0] < 41 < points[1][0])

    def test_spawned_citizens_and_their_paths_avoid_flyovers(self):
        roads = self.roads()
        roads.nodes.update({"c": (50, -30), "d": (50, 30)})
        flyover = Edge("cd", "c", "d", 2, 60, "Flyover", "Flyover", "primary",
                       False, "1", "yes", "no", width=10)
        roads.edges[flyover.id] = flyover
        game = Game.__new__(Game)
        game.roads, game.sidewalks, game.stops = roads, Sidewalks(roads), {}
        session = SimpleNamespace(point=(50, 0), rng=random.Random(2026), elapsed=0, citizens=[])
        for _ in range(100):
            game.spawn_citizen(session)
        self.assertEqual(len(session.citizens), 100)
        for citizen in session.citizens:
            self.assertTrue(game.sidewalks.safe(*citizen.path))
            self.assertGreaterEqual(
                segment_distance(*citizen.path, roads.nodes["c"], roads.nodes["d"]), 5.35
            )
            self.assertLessEqual(math.dist(session.point, game.citizen_point(citizen)), 220)

    def test_motorways_and_trunk_roads_are_not_spawn_paths(self):
        for kind in ("motorway", "trunk"):
            roads = self.roads()
            edge = roads.edges["ab"]
            roads.edges["ab"] = Edge(edge.id, edge.a, edge.b, edge.way, edge.length,
                                     edge.name, edge.zh, kind, False, "0", "no", "no", width=10)
            game = Game.__new__(Game)
            game.roads, game.sidewalks, game.stops = roads, Sidewalks(roads), {}
            session = SimpleNamespace(point=(50, 0), rng=random.Random(2026), elapsed=0, citizens=[])
            game.spawn_citizen(session)
            self.assertEqual(session.citizens, [], kind)

    def test_bridges_block_sidewalks_but_tunnels_do_not(self):
        for layer, bridge, tunnel, blocked in [
            ("0", "yes", "no", True),
            ("1", "no", "no", True),
            ("-1", "no", "yes", False),
        ]:
            roads = self.roads()
            roads.nodes.update({"c": (50, -30), "d": (50, 30)})
            roads.edges["cd"] = Edge("cd", "c", "d", 2, 60, "Other", "Other", "primary",
                                     False, layer, bridge, tunnel, width=10)
            sidewalks = Sidewalks(roads)
            self.assertEqual(sidewalks.safe((50, 7), (50, 7)), not blocked)

    def test_spawning_does_not_fall_back_when_flyover_blocks_all_paths(self):
        roads = self.roads()
        roads.nodes.update({"c": (50, -30), "d": (50, 30)})
        roads.edges["cd"] = Edge("cd", "c", "d", 2, 60, "Flyover", "Flyover", "primary",
                                 False, "1", "yes", "no", width=200)
        game = Game.__new__(Game)
        game.roads, game.sidewalks, game.stops = roads, Sidewalks(roads), {}
        session = SimpleNamespace(point=(50, 0), rng=random.Random(2026), elapsed=0, citizens=[])
        game.spawn_citizen(session)
        self.assertEqual(session.citizens, [])

    def test_entering_new_areas_uses_prepared_geometry(self):
        sidewalks = Sidewalks(self.roads())
        self.assertEqual(set(sidewalks.cache), {edge.id for edge in sidewalks.edges})
        with patch.object(sidewalks, "safe", side_effect=AssertionError("Geometry rebuilt during movement")):
            for point in ((0, 0), (50, 0), (100, 0)):
                self.assertTrue(sidewalks.nearby(point, 20))

    def test_path_sampling_and_bounce_preserve_arbitrary_timestep(self):
        self.assertEqual(path_pose(((0, 0), (10, 0), (10, 10)), 15), (10, 5))
        self.assertEqual(advance_walk(9, 1, 2, 10), (9, -1))
        self.assertEqual(advance_walk(1, -1, 2, 10), (1, 1))
        self.assertEqual(advance_walk(3, 1, 40, 10), (3, 1))


if __name__ == "__main__":
    unittest.main()
