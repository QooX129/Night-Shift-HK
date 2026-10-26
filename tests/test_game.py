import json
import math
from pathlib import Path
import tempfile
import unittest

from fastapi.testclient import TestClient

from app import app
from game import Game, RuleError
from roads import RoadMap

ROOT = Path(__file__).resolve().parents[1]


class RoadTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        nodes = {"a": [0, 0], "b": [40, 0], "c": [80, 0], "d": [80, 40], "e": [120, 0], "f": [40, 40]}
        edges = []
        for key, start, end, way in [("ab", "a", "b", 1), ("bc", "b", "c", 2), ("cd", "c", "d", 3), ("ce", "c", "e", 4), ("bf", "b", "f", 5)]:
            edges.append(dict(id=key, a=start, b=end, way=way, length=40, name=key, zh=key, kind="residential", oneway=True, layer="0", bridge="no", tunnel="no"))
        self.data = dict(version="test", bounds=[-10, -10, 200, 200], nodes=nodes, edges=edges, restrictions=[])

    def road_map(self):
        path = Path(self.directory.name) / "map.json"
        path.write_text(json.dumps(self.data), encoding="utf-8")
        return RoadMap(path)

    def test_node_restriction_and_closure(self):
        self.data["restrictions"] = [{"from": 1, "to": 5, "via": "b", "via_ways": [], "rule": "no_right_turn"}]
        r = self.road_map()
        self.assertIsNone(r.route(r.edges["ab"], r.edges["bf"], (1,), set(), {}))
        self.assertEqual(r.route(r.edges["ab"], r.edges["cd"], (1,), set(), {}), ["ab", "bc", "cd"])
        self.assertIsNone(r.route(r.edges["ab"], r.edges["cd"], (1,), {2}, {}))

    def test_via_way_no_turn(self):
        self.data["restrictions"] = [{"from": 1, "to": 3, "via": None, "via_ways": [2], "rule": "no_right_turn"}]
        r = self.road_map()
        self.assertIsNone(r.route(r.edges["ab"], r.edges["cd"], (1,), set(), {}))
        self.assertEqual(r.route(r.edges["ab"], r.edges["ce"], (1,), set(), {}), ["ab", "bc", "ce"])

    def test_via_way_only_turn_applies_at_entry_and_exit(self):
        self.data["restrictions"] = [{"from": 1, "to": 3, "via": None, "via_ways": [2], "rule": "only_right_turn"}]
        r = self.road_map()
        self.assertIsNone(r.route(r.edges["ab"], r.edges["bf"], (1,), set(), {}))
        self.assertIsNone(r.route(r.edges["ab"], r.edges["ce"], (1,), set(), {}))
        self.assertEqual(r.route(r.edges["ab"], r.edges["cd"], (1,), set(), {}), ["ab", "bc", "cd"])

    def test_matching_keeps_grade_separated_road(self):
        self.data["nodes"].update({"x": [0, 4], "y": [40, 4]})
        elevated = dict(self.data["edges"][0], id="xy", a="x", b="y", way=9, layer="1", bridge="yes")
        self.data["edges"].append(elevated)
        r = self.road_map()
        match = r.match((20, 3), 0, r.edges["ab"])
        self.assertEqual(match.edge.id, "ab")

    def test_congestion_changes_the_suggested_route(self):
        self.data["edges"].append(dict(self.data["edges"][0], id="fc", a="f", b="c", way=6, length=56))
        r = self.road_map()
        self.assertEqual(r.route(r.edges["ab"], r.edges["cd"], (1,), set(), {}), ["ab", "bc", "cd"])
        self.assertEqual(r.route(r.edges["ab"], r.edges["cd"], (1,), set(), {2: 0.2}), ["ab", "bf", "fc", "cd"])


class GameTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.roads = RoadMap(ROOT / "data" / "district.json")
        cls.game = Game(cls.roads)
        cls.initial = cls.game.create()

    def setUp(self):
        import copy
        source = self.game.sessions[self.initial["id"]]
        self.session = copy.deepcopy(source)
        self.session.id = self.id()
        self.game.sessions[self.session.id] = self.session

    def cmd(self, action, **payload):
        return self.game.command(self.session.id, self.session.seq + 1, action, payload)

    def at_stop(self, key):
        stop = self.game.stops[key]
        edge = self.roads.edges[stop.edge]
        self.session.point = stop.point
        self.session.edge, self.session.heading = edge.id, self.roads.angle(edge)
        self.session.history = (edge.way,)
        self.session.speed = 0

    def test_map_audit(self):
        self.assertEqual(self.roads.document["unsupported_restrictions"], [])
        self.assertGreater(len(self.roads.restrictions), 250)
        self.assertEqual(len(self.roads.document["conditional_notes"]), 2)
        self.assertTrue(all(e.a in self.roads.nodes and e.b in self.roads.nodes for e in self.roads.edges.values()))
        for stop in self.game.stops.values():
            edge = self.roads.edges[stop.edge]
            self.assertEqual(edge.layer, "0")
            self.assertGreaterEqual(edge.length, 30)

    def test_complete_trip_and_replay_cannot_pay_twice(self):
        self.cmd("accept")
        self.at_stop(self.session.pickup)
        self.cmd("service")
        self.assertEqual(self.session.phase, "onboard")
        self.at_stop(self.session.destination)
        old_money = self.session.money
        response = self.cmd("service")
        self.assertEqual(self.session.money, old_money + self.session.fare)
        replay = self.game.command(self.session.id, self.session.seq, "service", {})
        self.assertEqual(response, replay)
        self.assertEqual(self.session.trips, 1)
        with self.assertRaises(RuleError):
            self.game.command(self.session.id, self.session.seq, "recover", {})
        self.cmd("next")
        self.assertEqual(self.session.phase, "available")

    def test_full_trip_by_driving_the_real_graph(self):
        self.cmd("accept")
        self.cmd("pause", paused=False)
        for expected_phase in ("onboard", "complete"):
            target = self.game.target(self.session)
            route = self.roads.route(
                self.roads.edges[self.session.edge], self.roads.edges[target.edge],
                self.session.history, self.session.closed, self.session.traffic,
            )
            self.assertIsNotNone(route)
            for index, edge_id in enumerate(route):
                edge = self.roads.edges[edge_id]
                destination = target.point if index == len(route) - 1 else self.roads.nodes[edge.b]
                origin = self.session.point
                length = math.dist(origin, destination)
                steps = max(1, math.ceil(length / 15))
                for i in range(1, steps + 1):
                    point = (
                        origin[0] + (destination[0] - origin[0]) * i / steps,
                        origin[1] + (destination[1] - origin[1]) * i / steps,
                    )
                    dt = math.dist(self.session.point, point) / 10
                    self.cmd("move", x=point[0], y=point[1], heading=self.roads.angle(edge), speed=10, dt=dt)
            self.cmd("move", x=self.session.point[0], y=self.session.point[1], heading=self.session.heading, speed=0, dt=0)
            self.cmd("service")
            self.assertEqual(self.session.phase, expected_phase)
        self.assertEqual(self.session.trips, 1)

    def test_pickup_requires_stopped_and_correct_level(self):
        self.cmd("accept")
        with self.assertRaises(RuleError):
            self.cmd("service")
        self.at_stop(self.session.pickup)
        self.session.speed = 3
        with self.assertRaises(RuleError):
            self.cmd("service")
        self.session.speed = 0
        self.assertTrue(self.game.stop_valid(self.session, self.game.stops[self.session.pickup]))

    def test_paused_motion_and_nonfinite_values_rejected(self):
        with self.assertRaises(RuleError):
            self.cmd("move", x=self.session.point[0] + 1, y=self.session.point[1], speed=1, heading=0, dt=1)
        with self.assertRaises(RuleError):
            self.cmd("move", x=math.nan, y=0, speed=0, heading=0, dt=0)
        self.assertEqual(self.session.fuel, 100)
        self.assertEqual(self.session.elapsed, 0)

    def test_movement_fuel_congestion_and_pause_clock(self):
        self.cmd("pause", paused=False)
        x, y = self.session.point
        self.cmd("move", x=x + 2, y=y, speed=2, heading=0, dt=1)
        self.assertLess(self.session.fuel, 100)
        self.assertEqual(self.session.elapsed, 1)
        self.cmd("pause", paused=True)
        self.cmd("move", x=x + 2, y=y, speed=0, heading=0, dt=0)
        self.assertEqual(self.session.elapsed, 1)

    def test_upgrades_recovery_refuel(self):
        self.cmd("upgrade", kind="efficiency")
        self.assertEqual(self.session.money, 20)
        with self.assertRaises(RuleError):
            self.cmd("upgrade", kind="efficiency")
        self.session.fuel = 0
        self.cmd("recover")
        self.assertEqual(self.session.money, 0)
        self.assertEqual(self.session.fuel, 12)
        with self.assertRaises(RuleError):
            self.cmd("refuel")
        self.session.money = 100
        self.cmd("refuel")
        self.assertEqual(self.session.fuel, 100)
        self.assertEqual(self.session.money, 56)

    def test_validated_assisted_turn(self):
        for edge in self.roads.edges.values():
            options = self.roads.exits(edge, (edge.way,), set())
            if len(self.roads.neighbors[edge.b]) >= 3 and options and edge.length > 20:
                self.session.point = (
                    self.roads.nodes[edge.b][0] - math.cos(self.roads.angle(edge)) * 12,
                    self.roads.nodes[edge.b][1] - math.sin(self.roads.angle(edge)) * 12,
                )
                self.session.edge, self.session.heading = edge.id, self.roads.angle(edge)
                self.session.history = (edge.way,)
                self.cmd("turn", incoming=edge.id, exit=options[0].id)
                self.assertEqual(self.session.assisted_edges[:2], [edge.id, options[0].id])
                self.assertFalse(self.session.paused)
                return
        self.fail("No suitable real-data junction found")

    def test_closure_prevents_movement_and_routing(self):
        edge = self.roads.edges[self.session.edge]
        self.session.closed = {edge.way}
        self.cmd("pause", paused=False)
        a = self.session.point
        heading = self.roads.angle(edge)
        with self.assertRaises(RuleError):
            self.cmd("move", x=a[0] + math.cos(heading) * 2, y=a[1] + math.sin(heading) * 2, speed=2, heading=heading, dt=1)
        self.assertEqual(self.session.point, a)

    def test_unreachable_job_and_expired_session_are_explicit(self):
        self.cmd("accept")
        target = self.game.stops[self.session.pickup]
        self.session.closed = {self.roads.edges[target.edge].way}
        self.session.route_key = None
        self.assertTrue(self.game.snapshot(self.session)["no_route"])
        self.session.last_seen -= 3601
        with self.assertRaisesRegex(RuleError, "expired"):
            self.cmd("pause", paused=True)


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)
        cls.state = cls.client.post("/api/sessions").json()

    def test_health_assets_attribution_and_data(self):
        self.assertEqual(self.client.get("/api/health").status_code, 200)
        self.assertIn("OpenStreetMap contributors", self.client.get("/").text)
        self.assertEqual(self.client.get("/api/map").json()["version"], self.state["version"])
        self.assertEqual(self.client.get("/data-license.html").status_code, 200)
        self.assertEqual(self.client.get("/api/source").status_code, 200)
        self.assertTrue(self.client.get("/app.mjs").headers["content-type"].startswith("text/javascript"))

    def test_strict_payloads_and_expired_session(self):
        url = f"/api/sessions/{self.state['id']}/commands"
        bad = self.client.post(url, json={"seq": 1, "command": {"action": "move", "x": 0, "y": 0, "heading": 0, "dt": 1, "speed": 999}})
        self.assertEqual(bad.status_code, 422)
        missing = self.client.post("/api/sessions/missing/commands", json={"seq": 1, "command": {"action": "accept"}})
        self.assertEqual(missing.status_code, 404)


if __name__ == "__main__":
    unittest.main()
