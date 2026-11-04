import unittest
from types import SimpleNamespace
from unittest.mock import patch

from pedestrians import Sidewalks, advance_walk, path_pose
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
