import copy
import math
from pathlib import Path
import unittest

from fastapi.testclient import TestClient

from app import app
from game import Citizen, Game, RuleError
from roads import RoadMap


class OrderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.game = Game(RoadMap(Path(__file__).resolve().parents[1] / "data" / "district.json"))
        cls.initial = cls.game.create()

    def setUp(self):
        self.session = copy.deepcopy(self.game.sessions[self.initial["id"]])
        self.session.id = self.id()
        self.session.rng.seed(2026)
        self.game.sessions[self.session.id] = self.session

    def cmd(self, action, **payload):
        return self.game.command(self.session.id, self.session.seq + 1, action, payload)

    def advance(self, seconds):
        self.session.elapsed += seconds
        self.game.advance_city(self.session, seconds)

    def at_stop(self, key):
        stop = self.game.stops[key]
        edge = self.game.roads.edges[stop.edge]
        self.session.point = stop.point
        self.session.edge = edge.id
        self.session.heading = self.game.roads.angle(edge)
        self.session.history = (edge.way,)
        self.session.speed = 0

    def phone_pickup(self):
        self.cmd("accept", order=self.session.offers[0].id)
        self.at_stop(self.session.pickup)
        self.cmd("service")
        self.advance(2)

    def citizen(self, hailing=True):
        self.at_stop("depot")
        citizen = Citizen("street-rider", "depot", 0.5, 1, 0, self.session.elapsed + 100, hailing)
        self.session.citizens = [citizen]
        self.session.paused = False
        return citizen

    def test_random_offer_ranges_and_reachable_map_locations(self):
        pickups, destinations, passengers = set(), set(), set()
        for _ in range(12):
            order = self.game.make_order(self.session)
            self.assertTrue(30 <= order.expires - self.session.elapsed <= 180)
            pickup = self.game.stops[order.pickup]
            destination = self.game.stops[order.destination]
            start = self.game.roads.edges[self.session.edge]
            target = self.game.roads.edges[pickup.edge]
            self.assertTrue(self.game.roads.route(start, target, self.session.history, set(), {}))
            self.assertTrue(self.game.roads.route(
                target, self.game.roads.edges[destination.edge], (target.way,), set(), {}))
            pickups.add(order.pickup)
            destinations.add(order.destination)
            passengers.add(order.passenger)
        self.assertGreater(len(pickups), 1)
        self.assertGreater(len(destinations), 1)
        self.assertGreater(len(passengers), 1)

    def test_offers_arrive_at_scheduled_times_and_expire_independently(self):
        old = self.session.offers[0]
        old.expires = 50
        self.session.next_offer = 45
        self.advance(44)
        self.assertEqual(len(self.session.offers), 1)
        self.advance(1)
        self.assertEqual(len(self.session.offers), 2)
        self.assertTrue(45 <= self.session.next_offer - self.session.elapsed <= 180)
        self.advance(5)
        self.assertNotIn(old, self.session.offers)
        with self.assertRaisesRegex(RuleError, "no longer available"):
            self.cmd("accept", order=old.id)

    def test_no_arbitrary_offer_cap_and_no_countdowns_in_snapshot(self):
        for _ in range(7):
            self.game.offer(self.session)
        state = self.game.snapshot(self.session)
        self.assertEqual(len(state["offers"]), 8)
        self.assertNotIn("expires", state["offers"][0])
        self.assertNotIn("deadline", state["offers"][0])
        self.assertIn("distance", state["offers"][0])

    def test_pause_does_not_advance_city_or_deadlines(self):
        before = self.game.snapshot(self.session)
        self.cmd("pause", paused=True)
        self.cmd("pause", paused=False)
        self.cmd("pause", paused=True)
        after = self.game.snapshot(self.session)
        self.assertEqual(after["elapsed"], before["elapsed"])
        self.assertEqual(after["offers"], before["offers"])
        self.assertEqual(after["citizens"], before["citizens"])

    def test_citizen_snapshot_identifies_its_road_surface(self):
        state = self.game.snapshot(self.session)
        self.assertTrue(state["citizens"])
        for citizen, snapshot in zip(self.session.citizens, state["citizens"]):
            self.assertEqual(snapshot["edge"], self.game.stops[citizen.stop].edge)

    def test_accept_uses_order_id_and_replay_cannot_duplicate(self):
        self.game.offer(self.session)
        chosen = self.session.offers[1]
        response = self.cmd("accept", order=chosen.id)
        self.assertEqual(self.session.order.id, chosen.id)
        self.assertTrue(120 <= chosen.deadline - self.session.elapsed <= 300)
        self.assertEqual(self.game.command(
            self.session.id, self.session.seq, "accept", {"order": chosen.id}), response)
        self.assertEqual(len(self.session.offers), 1)
        with self.assertRaisesRegex(RuleError, "pending"):
            self.cmd("accept", order=self.session.offers[0].id)

    def test_accept_while_driving_wrong_way_routes_via_turnaround(self):
        roads = self.game.roads
        pickup = roads.edges[self.game.stops[self.session.offers[0].pickup].edge]
        edge = next(e for e in roads.edges.values() if e.wrongway and e.length > 30
                    and roads.route(roads.edges[e.id[1:]], pickup, (e.way,), set(), {}))
        self.session.point = roads.nodes[edge.a]
        self.session.edge, self.session.history = edge.id, (edge.way,)
        self.session.heading, self.session.speed = roads.angle(edge), 0
        self.cmd("accept", order=self.session.offers[0].id)
        self.assertEqual(self.session.phase, "pickup")
        self.assertFalse(self.game.snapshot(self.session)["no_route"])

    def test_following_the_route_does_not_search_again(self):
        roads = self.game.roads
        calls = []
        search = roads.route
        roads.route = lambda *args: calls.append(1) or search(*args)
        try:
            self.cmd("accept", order=self.session.offers[0].id)
            route = self.session.route
            for edge_id in route[1:6]:
                self.session.edge = edge_id
                self.session.history = roads.history(self.session.history, roads.edges[edge_id].way)
                state = self.game.snapshot(self.session)
                self.assertEqual(state["route"][0], edge_id)
        finally:
            del roads.route
        self.assertEqual(len(calls), 1)

    def test_phone_customer_waits_at_pickup_then_walks_in(self):
        self.cmd("accept", order=self.session.offers[0].id)
        state = self.game.snapshot(self.session)
        stop = self.game.stops[self.session.pickup]
        self.assertTrue(4 <= math.dist(state["customer"], stop.point) <= 16 / 2 + 1)
        self.at_stop(self.session.pickup)
        self.session.paused = False
        response = self.cmd("service")
        self.assertEqual(response["phase"], "boarding")
        self.assertIsNone(response["customer"])
        self.assertEqual(response["boarding"]["point"], state["customer"])
        self.assertTrue(response["destination"])
        with self.assertRaisesRegex(RuleError, "boarding"):
            self.cmd("move", x=self.session.point[0] + 0.2, y=self.session.point[1], speed=1,
                     heading=self.session.heading, dt=0.1)
        self.advance(1.8)
        self.assertEqual(self.session.phase, "onboard")

    def test_dropoff_plays_alighting_animation_that_holds_the_taxi(self):
        self.phone_pickup()
        self.game.offer(self.session)
        self.cmd("accept", order=self.session.offers[-1].id)
        self.at_stop(self.session.destination)
        self.session.paused = False
        destination = self.game.stops[self.session.destination]
        response = self.cmd("service")
        self.assertEqual(response["phase"], "complete")
        self.assertTrue(response["boarding"]["alighting"])
        self.assertEqual(response["boarding"]["point"], self.game.curb_point(destination))
        with self.assertRaisesRegex(RuleError, "boarding"):
            self.cmd("move", x=self.session.point[0] + 0.2, y=self.session.point[1], speed=1,
                     heading=self.session.heading, dt=0.1)
        self.cmd("next")
        self.assertEqual(self.session.phase, "pickup")
        self.assertIsNotNone(self.session.boarding)
        with self.assertRaisesRegex(RuleError, "getting out"):
            self.cmd("service")
        self.advance(1.8)
        self.assertIsNone(self.session.boarding)
        self.assertEqual(self.session.phase, "pickup")

    def test_one_pending_order_during_trip_then_promoted_after_dropoff(self):
        self.phone_pickup()
        self.game.offer(self.session)
        pending = self.session.offers[-1]
        self.cmd("accept", order=pending.id)
        self.assertEqual(self.session.phase, "onboard")
        self.assertEqual([o.id for o in self.session.queue], [pending.id])
        self.game.offer(self.session)
        with self.assertRaisesRegex(RuleError, "pending"):
            self.cmd("accept", order=self.session.offers[-1].id)
        self.at_stop(self.session.destination)
        self.cmd("service")
        self.cmd("next")
        self.assertEqual(self.session.order.id, pending.id)
        self.assertEqual(self.session.phase, "pickup")
        self.assertEqual(self.session.queue, [])

    def test_pending_order_cancels_but_onboard_passenger_never_times_out(self):
        self.phone_pickup()
        active = self.session.order
        self.game.offer(self.session)
        self.cmd("accept", order=self.session.offers[-1].id)
        pending = self.session.queue[0]
        self.session.next_offer = math.inf
        self.advance(pending.deadline - self.session.elapsed)
        self.assertEqual(self.session.queue, [])
        self.assertIs(self.session.order, active)
        self.assertEqual(self.session.phase, "onboard")
        self.assertEqual(self.game.snapshot(self.session)["cancelled_orders"], 1)

    def test_active_phone_pickup_cancels_at_deadline_without_penalty(self):
        self.cmd("accept")
        money = self.session.money
        self.session.next_offer = math.inf
        self.advance(self.session.order.deadline - self.session.elapsed)
        self.assertIsNone(self.session.order)
        self.assertEqual(self.session.phase, "available")
        self.assertEqual(self.session.money, money)
        self.assertEqual(self.session.cancelled_orders, 1)

    def test_street_boarding_hides_destination_then_reveals_it_and_is_idempotent(self):
        citizen = self.citizen()
        response = self.cmd("door", citizen=citizen.id)
        self.assertEqual(response["phase"], "boarding")
        self.assertEqual(response["destination"], "")
        self.assertIsNone(response["route"])
        self.assertEqual(response["order_source"], "street")
        self.assertEqual(self.session.citizens, [])
        self.assertEqual(self.game.command(
            self.session.id, self.session.seq, "door", {"citizen": citizen.id}), response)
        with self.assertRaisesRegex(RuleError, "marked roadside"):
            self.cmd("service")
        self.advance(1.7)
        self.assertEqual(self.session.phase, "boarding")
        self.advance(0.1)
        state = self.game.snapshot(self.session)
        self.assertEqual(state["phase"], "onboard")
        self.assertTrue(state["destination"])
        self.assertIsNone(state["boarding"])

    def test_cannot_drive_or_recover_while_boarding(self):
        citizen = self.citizen()
        self.cmd("door", citizen=citizen.id)
        x, y = self.session.point
        with self.assertRaisesRegex(RuleError, "boarding"):
            self.cmd("move", x=x + 0.2, y=y, speed=1, heading=self.session.heading, dt=0.1)
        with self.assertRaisesRegex(RuleError, "boarding"):
            self.cmd("recover")
        self.cmd("move", x=x, y=y, speed=0, heading=self.session.heading, dt=2)
        self.assertEqual(self.session.phase, "onboard")

    def test_street_pickup_holds_phone_order_and_original_deadline(self):
        self.cmd("accept")
        phone = self.session.order
        deadline = phone.deadline
        citizen = self.citizen()
        self.cmd("door", citizen=citizen.id)
        self.assertEqual(self.session.queue, [phone])
        self.assertEqual(phone.deadline, deadline)
        self.advance(2)
        self.at_stop(self.session.destination)
        self.cmd("service")
        self.cmd("next")
        self.assertIs(self.session.order, phone)
        self.assertEqual(phone.deadline, deadline)

    def test_door_requires_hailing_stopped_same_road_and_empty_taxi(self):
        citizen = self.citizen(hailing=False)
        with self.assertRaisesRegex(RuleError, "hailing"):
            self.cmd("door", citizen=citizen.id)
        citizen.hailing = True
        self.session.speed = 2
        with self.assertRaisesRegex(RuleError, "Stop beside"):
            self.cmd("door", citizen=citizen.id)
        self.session.speed = 0
        self.at_stop("mongkok")
        with self.assertRaisesRegex(RuleError, "same road"):
            self.cmd("door", citizen=citizen.id)
        self.at_stop("depot")
        self.cmd("door", citizen=citizen.id)
        self.advance(2)
        with self.assertRaisesRegex(RuleError, "current passenger"):
            self.cmd("door", citizen=citizen.id)

    def test_citizens_walk_spawn_and_expire_without_colliding(self):
        citizen = self.citizen(hailing=False)
        self.session.point = (self.session.point[0] + 100, self.session.point[1])
        point = self.game.citizen_point(citizen)
        self.session.next_citizen = 1
        self.advance(1)
        self.assertNotEqual(point, self.game.citizen_point(citizen))
        self.assertEqual(len(self.session.citizens), 2)
        self.assertTrue(8 <= self.session.next_citizen - self.session.elapsed <= 16)
        citizen.expires = self.session.elapsed
        self.advance(0)
        self.assertNotIn(citizen, self.session.citizens)

    def test_approaching_empty_taxi_can_trigger_hail(self):
        citizen = self.citizen(hailing=False)
        for seed in range(20):
            self.session.rng.seed(seed)
            citizen.approached = False
            self.advance(0)
            if citizen.hailing:
                break
        self.assertTrue(citizen.hailing)
        self.assertTrue(citizen.approached)
        self.assertTrue(self.game.citizen_ready(self.session, citizen))


class OrderApiTests(unittest.TestCase):
    def test_explicit_offer_id_and_new_door_schema(self):
        with TestClient(app) as client:
            response = client.post("/api/sessions")
            self.assertEqual(response.status_code, 200)
            state = response.json()
            url = f"/api/sessions/{state['id']}/commands"
            command = {"seq": 1, "command": {"action": "accept", "order": state["offers"][0]["id"]}}
            accepted = client.post(url, json=command)
            self.assertEqual(accepted.status_code, 200)
            self.assertEqual(accepted.json()["phase"], "pickup")
            self.assertEqual(client.post(url, json=command).json(), accepted.json())
            self.assertEqual(client.post(url, json={"seq": 2, "command": {"action": "door"}}).status_code, 422)
            invalid = client.post(url, json={"seq": 2, "command": {"action": "door", "citizen": "missing"}})
            self.assertEqual(invalid.status_code, 409)
            self.assertIn("Resume", invalid.json()["detail"])


if __name__ == "__main__":
    unittest.main()
