import unittest

from roads import Edge, RoadMap


class JunctionOverlapTests(unittest.TestCase):
    def roads(self, separated=False):
        roads = RoadMap.__new__(RoadMap)
        roads.nodes = {"a": (0, 0), "b": (100, 0), "c": (100, 30), "d": (0, 0)}
        narrow = Edge("narrow", "a", "b", 1, 100, "", "", "residential", False, "0", "no", "no", width=3)
        wide = Edge("wide", "d" if separated else "a", "c", 2, 104.4, "", "", "primary", False, "0", "no", "no", width=12)
        roads.edges = {edge.id: edge for edge in (narrow, wide)}
        roads.max_radius = max(roads.radius(edge) for edge in roads.edges.values())
        roads.outgoing = {"a": [narrow] + ([] if separated else [wide]), "d": [wide] if separated else []}
        roads.bounds = [-200, -200, 200, 200]
        roads.elevation = None
        return roads, narrow, wide

    def test_connected_opening_uses_overlapping_surface_not_just_node_distance(self):
        roads, narrow, wide = self.roads()
        point = (15, 2)
        self.assertIn(wide, roads.corridor_edges(point, narrow))
        self.assertTrue(roads.body_fits(point, 0, narrow))
        self.assertIsNotNone(roads.corridor_match(point, 0, narrow))
        self.assertNotIn(wide, roads.corridor_edges(point, narrow, "narrow", "a"))

    def test_disconnected_crossing_stays_blocked(self):
        roads, narrow, wide = self.roads(separated=True)
        self.assertNotIn(wide, roads.corridor_edges((15, 2), narrow))
        self.assertFalse(roads.body_fits((15, 2), 0, narrow))
