import json
import math
from pathlib import Path
import tempfile
import unittest

from fastapi.testclient import TestClient

from app import app
from game import Game, RuleError
from roads import DRIVING, RoadMap

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
        match = r.corridor_match((20, 2), 0, r.edges["ab"])
        self.assertEqual(match.edge.id, "ab")
        self.assertIsNone(r.corridor_match((20, 7), 0, r.edges["ab"]))

    def test_stacked_choices_require_a_connected_fork(self):
        self.data["edges"][2]["layer"] = "1"
        r = self.road_map()
        self.assertNotIn("b", r.document["stacked_junctions"])
        self.assertIn("c", r.document["stacked_junctions"])
        self.assertNotIn("a", r.document["stacked_junctions"])
        self.assertTrue(r.stacked_choice(r.edges["bc"], set()))
        self.assertFalse(r.stacked_choice(r.edges["bc"], {3}))
        self.assertFalse(r.stacked_choice(r.edges["~cd"], set()))

    def test_unconnected_crossing_is_not_a_branch(self):
        self.data["nodes"].update({"x": [20, -40], "y": [20, 40]})
        self.data["edges"].append(dict(self.data["edges"][0], id="xy", a="x", b="y", way=9, layer="1"))
        r = self.road_map()
        self.assertNotIn("xy", [e.id for e in r.corridor_edges((20, 0), r.edges["ab"])])
        self.assertEqual(r.document["stacked_junctions"], [])

    def test_wrongway_geometry_does_not_become_a_legal_gps_exit(self):
        r = self.road_map()
        reverse = r.edges["~ab"]
        self.assertTrue(reverse.wrongway)
        self.assertEqual(r.corridor_match((20, 0), math.pi, r.edges["ab"]).edge.id, "~ab")
        self.assertFalse(r.legal(r.edges["ab"], reverse, (1,)))

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

    def test_vehicle_cap_and_high_speed_path_validation(self):
        edge = next(e for e in self.roads.edges.values() if not e.wrongway and e.length > 100)
        a, b = self.roads.nodes[edge.a], self.roads.nodes[edge.b]
        self.session.point = (a[0] * 0.8 + b[0] * 0.2, a[1] * 0.8 + b[1] * 0.2)
        self.session.edge, self.session.heading = edge.id, self.roads.angle(edge)
        self.session.history = (edge.way,)
        self.cmd("pause", paused=False)
        maximum = DRIVING["max_speed"]
        self.assertEqual(maximum * 3.6, 150)
        x, y = self.session.point
        distance = maximum * 0.75
        self.cmd("move", x=x + math.cos(self.session.heading) * distance,
                 y=y + math.sin(self.session.heading) * distance,
                 heading=self.session.heading, speed=maximum, dt=0.75)
        self.assertEqual(self.session.speed, maximum)
        with self.assertRaisesRegex(RuleError, "speed"):
            self.cmd("move", x=self.session.point[0], y=self.session.point[1],
                     heading=self.session.heading, speed=maximum + 0.01, dt=0)

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

    def test_stacked_choice_is_advisory_and_does_not_move_or_steer(self):
        for edge in self.roads.edges.values():
            options = self.roads.branches(edge, set())
            if self.roads.stacked_choice(edge, set()) and edge.length > 30:
                self.session.point = (
                    self.roads.nodes[edge.b][0] - math.cos(self.roads.angle(edge)) * 12,
                    self.roads.nodes[edge.b][1] - math.sin(self.roads.angle(edge)) * 12,
                )
                self.session.edge, self.session.heading = edge.id, self.roads.angle(edge)
                self.session.history = (edge.way,)
                old = (self.session.point, self.session.heading, self.session.edge)
                self.cmd("select_road", incoming=edge.id, exit=options[0].id)
                self.assertEqual((self.session.point, self.session.heading, self.session.edge), old)
                self.assertEqual(self.session.selected_exit, options[0].id)
                self.assertFalse(self.session.paused)
                alternate = options[1]
                node = self.roads.nodes[edge.b]
                self.cmd("move", x=node[0], y=node[1], heading=self.roads.angle(alternate), speed=3, dt=1)
                a, b = node, self.roads.nodes[alternate.b]
                length = min(alternate.length * 0.5, 10)
                point = (a[0] + (b[0] - a[0]) * length / alternate.length,
                         a[1] + (b[1] - a[1]) * length / alternate.length)
                self.cmd("move", x=point[0], y=point[1], heading=self.roads.angle(alternate), speed=3, dt=1)
                self.assertIsNone(self.session.selected_exit)
                return
        self.fail("No suitable real-data junction found")

    def test_reverse_does_not_allow_remote_service_or_recovery_while_moving(self):
        self.cmd("accept")
        self.at_stop(self.session.pickup)
        self.session.speed = -3
        with self.assertRaises(RuleError):
            self.cmd("service")
        self.session.paused = False
        with self.assertRaises(RuleError):
            self.cmd("recover")

    def test_wrongway_and_restricted_turns_warn_without_blocking(self):
        for edge in self.roads.edges.values():
            if edge.oneway and not edge.wrongway and edge.length > 30:
                self.session.edge, self.session.point = edge.id, self.game.midpoint(edge)
                self.session.heading = self.roads.angle(edge)
                self.session.paused = False
                self.session.history = (edge.way,)
                a = self.session.point
                self.cmd("move", x=a[0] - math.cos(self.session.heading),
                         y=a[1] - math.sin(self.session.heading), heading=self.session.heading, speed=-2, dt=0.5)
                self.assertEqual(self.game.snapshot(self.session)["warning"], "wrongway")
                break
        else:
            self.fail("No one-way road found")
        for edge in self.roads.edges.values():
            if edge.wrongway or edge.length < 20:
                continue
            illegal = [e for e in self.roads.branches(edge, set()) if not self.roads.legal(edge, e, (edge.way,))]
            if not illegal:
                continue
            nxt = illegal[0]
            node = self.roads.nodes[edge.b]
            heading = self.roads.angle(edge)
            self.session.edge, self.session.point = edge.id, (node[0] - math.cos(heading), node[1] - math.sin(heading))
            self.session.heading, self.session.history = heading, (edge.way,)
            self.cmd("move", x=node[0], y=node[1], heading=self.roads.angle(nxt), speed=2, dt=0.5)
            self.assertIn(self.game.snapshot(self.session)["warning"], {"restricted", "wrongway"})
            return
        self.fail("No restricted real-road exit found")

    def test_offroad_and_corner_cutting_are_rejected_atomically(self):
        self.cmd("pause", paused=False)
        edge = self.roads.edges[self.session.edge]
        x, y = self.session.point
        heading = self.roads.angle(edge)
        original = (self.session.point, self.session.edge, self.session.fuel)
        with self.assertRaisesRegex(RuleError, "footprint"):
            self.cmd("move", x=x - math.sin(heading) * 15, y=y + math.cos(heading) * 15,
                     heading=heading, speed=10, dt=1)
        self.assertEqual((self.session.point, self.session.edge, self.session.fuel), original)
        with self.assertRaisesRegex(RuleError, "footprint"):
            self.cmd("move", x=x, y=y, heading=heading, speed=0, dt=1,
                     trail=[{"x": x - math.sin(heading) * 12, "y": y + math.cos(heading) * 12, "heading": heading}])
        self.assertEqual((self.session.point, self.session.edge, self.session.fuel), original)

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

    def test_api_vehicle_cap_matches_driving_configuration(self):
        state = self.client.post("/api/sessions").json()
        url = f"/api/sessions/{state['id']}/commands"
        command = {"action": "move", "x": state["x"], "y": state["y"],
                   "heading": state["heading"], "dt": 0, "speed": DRIVING["max_speed"]}
        self.assertEqual(self.client.post(url, json={"seq": 1, "command": command}).status_code, 200)
        command["speed"] = DRIVING["max_speed"] + 0.01
        self.assertEqual(self.client.post(url, json={"seq": 2, "command": command}).status_code, 422)
        self.assertEqual(self.client.get("/api/map").json()["driving"]["max_speed"], DRIVING["max_speed"])


if __name__ == "__main__":
    unittest.main()
