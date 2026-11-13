import copy
import math
from pathlib import Path
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import app, game as api_game
from game import CITIZEN_HAIL_COOLDOWN, CITIZEN_RADIUS, Citizen, Game, NoReachableTrip, RuleError, Stop, urban_meter
from pedestrians import segment_distance
from roads import RoadMap, project


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
        point = stop.point
        if key == self.session.pickup and self.session.pickup_point is not None:
            point = self.session.pickup_point
        elif key == self.session.destination and self.session.destination_point is not None:
            point = self.session.destination_point
        self.session.point = point
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
        pickups, destinations, passengers, fares = set(), set(), set(), set()
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
            self.assertGreaterEqual(math.dist(order.pickup_point, order.destination_point), 60)
            for stop, point in ((pickup, order.pickup_point), (destination, order.destination_point)):
                a = self.game.roads.nodes[self.game.roads.edges[stop.edge].a]
                b = self.game.roads.nodes[self.game.roads.edges[stop.edge].b]
                self.assertGreaterEqual(math.dist(point, a), 5 - 1e-8)
                self.assertGreaterEqual(math.dist(point, b), 5 - 1e-8)
                self.assertTrue(all(
                    project(point, self.game.roads.nodes[flyover.a],
                            self.game.roads.nodes[flyover.b])[1] >= 30
                    for flyover in self.game.flyover_edges
                ))
                self.assertNotIn(self.game.roads.edges[stop.edge].way, self.game.roads.no_stopping_ways)
            pickups.add(order.pickup)
            destinations.add(order.destination)
            passengers.add(order.passenger)
            fares.add(order.fare)
        self.assertGreater(len(pickups), 1)
        self.assertGreater(len(destinations), 1)
        self.assertGreater(len(passengers), 1)
        self.assertTrue(any(fare > 34 for fare in fares))

    def test_weighted_selection_prefers_more_popular_stops(self):
        stops = [Stop("low", "", "", "x", (0, 0), 1),
                 Stop("high", "", "", "x", (0, 0), 3)]
        counts = {"low": 0, "high": 0}
        for _ in range(4000):
            counts[next(self.game.weighted_stops(self.session, stops)).id] += 1
        self.assertTrue(2.6 < counts["high"] / counts["low"] < 3.4)

    def test_same_road_gets_distinct_safe_points(self):
        stop = next(stop for stop in self.game.street_stops if stop.id.startswith("street-")
                    and self.game.flyover_clear(stop.point))
        points = [self.game.randomized_stop_point(self.session, stop) for _ in range(30)]
        self.assertTrue(all(point is not None and self.game.flyover_clear(point) for point in points))
        self.assertGreater(len(set(points)), 20)

    def test_explicit_parking_entrance_and_taxi_stand_are_candidates(self):
        road = next(stop for stop in self.game.street_stops if stop.id.startswith("street-")
                    and self.game.flyover_clear(stop.point))
        places = [{"id": "test-place", "name": "Mall", "zh": "Mall",
                   "point": road.point, "popularity": 3,
                   "parking_entrances": [road.point]}]
        stands = [{"id": "test-stand", "name": "Taxi stand", "zh": "Taxi stand",
                   "point": road.point}]
        with patch.object(self.game.roads, "places", places), \
             patch.object(self.game.roads, "taxi_stands", stands), \
             patch("game.Sidewalks"):
            game = Game(self.game.roads)
        destination = next(stop for stop in game.destination_stops if stop.group == "test-place")
        pickup = next(stop for stop in game.pickup_stops if stop.id == "test-stand")
        self.assertIn(":parking:", destination.id)
        self.assertLessEqual(math.dist(destination.point, road.point), 30)
        self.assertEqual(game.randomized_stop_point(self.session, destination), destination.point)
        self.assertEqual(game.randomized_stop_point(self.session, pickup), pickup.point)
        self.assertGreater(pickup.popularity, destination.popularity)

    def test_urban_meter_increment_and_discount_boundaries(self):
        self.assertEqual(urban_meter(0), 29)
        self.assertEqual(urban_meter(.999), 29)
        self.assertEqual(urban_meter(1), 31.1)
        self.assertEqual(urban_meter(35), 102.5)
        self.assertEqual(urban_meter(35.999), 102.5)
        self.assertEqual(urban_meter(36), 103.9)

    def test_phone_meter_counts_distance_and_waiting_and_pays_once(self):
        self.assertGreaterEqual(self.session.offers[0].fare, 34)
        self.phone_pickup()
        self.session.paused = False
        self.session.next_offer = self.session.next_citizen = math.inf
        self.assertEqual(self.game.snapshot(self.session)["meter"], 29)
        self.assertEqual(self.session.fare, 34)

        edge = next(e for e in self.game.roads.edges.values() if not e.wrongway and e.length > 100)
        a, b = self.game.roads.nodes[edge.a], self.game.roads.nodes[edge.b]
        self.session.point = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
        self.session.edge, self.session.heading = edge.id, self.game.roads.angle(edge)
        self.session.history = (edge.way,)
        self.session.meter_distance = 499
        x, y = self.session.point
        heading = self.session.heading
        payload = dict(x=x + 4 * math.cos(heading), y=y + 4 * math.sin(heading),
                       speed=4, heading=heading, dt=1)
        response = self.cmd("move", **payload)
        self.assertAlmostEqual(self.session.meter_units, 3 / 200)
        self.assertEqual(response["meter"], 29)
        self.session.meter_distance = 699
        self.session.meter_units = 199 / 200
        x, y = self.session.point
        payload.update(x=x + 4 * math.cos(heading), y=y + 4 * math.sin(heading))
        response = self.cmd("move", **payload)
        self.assertAlmostEqual(self.session.meter_units, 203 / 200)
        self.assertEqual(response["meter"], 31.1)
        self.assertEqual(response["fare"], 36.1)
        self.assertEqual(self.game.command(self.session.id, self.session.seq, "move", payload), response)
        self.assertAlmostEqual(self.session.meter_units, 203 / 200)

        x, y = self.session.point
        self.cmd("move", x=x + math.cos(heading), y=y + math.sin(heading),
                 speed=1, heading=heading, dt=1)
        self.assertAlmostEqual(self.session.meter_units, 203 / 200 + 1 / 60)
        units = self.session.meter_units
        self.cmd("pause", paused=True)
        self.assertEqual(self.session.meter_units, units)
        self.cmd("pause", paused=False)

        self.at_stop(self.session.destination)
        old_money, fare = self.session.money, self.session.fare
        completed = self.cmd("service")
        self.assertEqual(completed["meter"], 31.1)
        committed_money = self.session.money
        self.assertEqual(committed_money, round(old_money + fare, 1))
        self.assertEqual(self.game.command(self.session.id, self.session.seq, "service", {}), completed)
        self.assertEqual(self.session.money, committed_money)

    def test_street_trip_has_no_phone_booking_charge(self):
        citizen = self.citizen()
        self.cmd("door", citizen=citizen.id)
        self.advance(1.8)
        self.assertEqual(self.session.fare, 29)
        self.assertEqual(self.game.snapshot(self.session)["meter"], 29)

    def test_stationary_waiting_accumulates_across_updates(self):
        self.phone_pickup()
        self.session.paused = False
        self.session.next_offer = self.session.next_citizen = math.inf
        x, y = self.session.point
        payload = dict(x=x, y=y, speed=0, heading=self.session.heading, dt=4)
        state = self.cmd("move", **{**payload, "dt": .1})
        self.assertEqual(state["meter"], 29)
        for _ in range(14):
            self.cmd("move", **payload)
        state = self.cmd("move", **{**payload, "dt": 3.8})
        self.assertEqual(state["meter"], 29)
        state = self.cmd("move", **{**payload, "dt": .1})
        self.assertAlmostEqual(self.session.meter_units, 1)
        self.assertEqual(state["meter"], 31.1)
        state = self.cmd("move", **{**payload, "dt": .1})
        self.assertEqual(state["meter"], 31.1)
        self.assertEqual(state["fare"], 36.1)
        for _ in range(14):
            self.cmd("move", **payload)
        state = self.cmd("move", **{**payload, "dt": 3.8})
        self.assertEqual(state["meter"], 31.1)
        state = self.cmd("move", **{**payload, "dt": .1})
        self.assertEqual(state["meter"], 33.2)
        self.assertEqual(state["fare"], 38.2)

    def test_meter_ticks_after_driving_700_metres(self):
        self.phone_pickup()
        self.session.paused = False
        self.session.next_offer = self.session.next_citizen = math.inf
        edge = max((e for e in self.game.roads.edges.values() if not e.wrongway), key=lambda e: e.length)
        a = self.game.roads.nodes[edge.a]
        heading = self.game.roads.angle(edge)
        dx, dy = math.cos(heading), math.sin(heading)
        self.session.point = (a[0] + 5 * dx, a[1] + 5 * dy)
        self.session.edge, self.session.heading = edge.id, heading
        self.session.history = (edge.way,)
        pickup = Stop("meter-pickup", "Pickup", "上車", edge.id, self.session.point)
        destination = Stop("meter-destination", "Destination", "落車", edge.id,
                           (a[0] + 705 * dx, a[1] + 705 * dy))
        with patch.object(self.game, "destination_stops", [destination]):
            estimate = self.game.make_order(self.session, pickup).fare
        self.assertEqual(estimate, 36.1)
        for _ in range(21):
            x, y = self.session.point
            state = self.cmd("move", x=x + 32 * dx, y=y + 32 * dy, speed=8, heading=heading, dt=4)
        self.assertAlmostEqual(self.session.meter_distance, 672, places=5)
        self.assertEqual(state["meter"], 29)
        x, y = self.session.point
        state = self.cmd("move", x=x + 28 * dx, y=y + 28 * dy, speed=8, heading=heading, dt=3.5)
        self.assertAlmostEqual(self.session.meter_distance, 700, places=5)
        self.assertEqual(state["meter"], 31.1)
        self.assertEqual(state["fare"], estimate)

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

    def test_unreachable_scheduled_offer_does_not_reject_or_repeat_movement(self):
        self.session.paused = False
        self.session.next_offer = .1
        self.session.next_citizen = math.inf
        before = self.session.elapsed
        payload = dict(x=self.session.point[0], y=self.session.point[1],
                       heading=self.session.heading, speed=0, dt=.3)
        with patch.object(self.game.roads, "route", return_value=None), self.assertLogs("game", level="WARNING") as logs:
            state = self.cmd("move", **payload)
        self.assertIn("Scheduled passenger offer deferred", logs.output[0])
        self.assertAlmostEqual(state["elapsed"], before + .3)
        self.assertEqual(state["seq"], 1)
        self.assertFalse(state["paused"])
        self.assertTrue(45 <= self.session.next_offer - self.session.elapsed <= 180)
        self.assertEqual(self.game.command(self.session.id, 1, "move", payload), state)
        self.assertAlmostEqual(self.session.elapsed, before + .3)
        self.session.elapsed = self.session.next_offer
        self.game.advance_city(self.session, 0)
        self.assertGreater(len(self.session.offers), 0)

    def test_explicit_trip_failure_and_unexpected_dispatch_errors_still_surface(self):
        with patch.object(self.game.roads, "route", return_value=None):
            with self.assertRaisesRegex(RuleError, "No reachable passenger trip"):
                self.game.make_order(self.session)
        self.session.next_offer = 0
        with patch.object(self.game, "offer", side_effect=RuleError("Unexpected dispatch error")):
            with self.assertRaisesRegex(RuleError, "Unexpected dispatch error"):
                self.game.advance_city(self.session, 0)

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
        edge = self.game.roads.edges[self.game.stops[self.session.pickup].edge]
        self.assertAlmostEqual(math.dist(state["customer"], state["pickup_point"]),
                               self.game.roads.radius(edge) + 2)
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

    def test_phone_customers_use_safe_sidewalks_at_the_pickup(self):
        for _ in range(30):
            order = self.game.make_order(self.session)
            self.session.order = order
            self.game.display_order(self.session, order, "pickup", "accepted")
            point = self.game.snapshot(self.session)["customer"]
            edge = self.game.roads.edges[self.game.stops[order.pickup].edge]
            self.assertTrue(self.game.sidewalks.safe(point, point), (order.pickup, point))
            self.assertTrue(self.game.flyover_clear(point), (order.pickup, point))
            self.assertTrue(any(
                project(point, *path)[1] < 1e-6
                for side, path in self.game.sidewalks.paths(edge) if side == 1
            ), (order.pickup, point))
            centre = project(point, self.game.roads.nodes[edge.a], self.game.roads.nodes[edge.b])[0]
            self.assertLess(math.dist(centre, order.pickup_point), 1e-6)

    def test_phone_order_rejects_pickups_without_a_clear_sidewalk(self):
        order = self.game.make_order(self.session)
        stop = self.game.stops[order.pickup]
        edge = self.game.roads.edges[stop.edge]
        with patch.object(self.game, "flyover_clear", return_value=False):
            self.assertIsNone(self.game.phone_customer_point(edge, order.pickup_point))
        with patch.object(self.game, "pickup_stops", [stop]), \
             patch.object(self.game.sidewalks, "paths", return_value=[]):
            with self.assertRaises(NoReachableTrip):
                self.game.make_order(self.session)

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
        point = response["boarding"]["point"]
        left = (math.sin(self.session.heading), -math.cos(self.session.heading))
        self.assertGreater(sum((point[i] - self.session.point[i]) * left[i] for i in (0, 1)), 0)
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

    def test_dropoff_uses_taxi_left_even_when_facing_against_destination_edge(self):
        self.phone_pickup()
        self.at_stop(self.session.destination)
        self.session.heading += math.pi
        self.session.paused = False
        state = self.cmd("service")
        point = state["boarding"]["point"]
        dx, dy = point[0] - self.session.point[0], point[1] - self.session.point[1]
        self.assertGreater(math.sin(self.session.heading) * dx - math.cos(self.session.heading) * dy, 0)
        self.assertAlmostEqual(math.cos(self.session.heading) * dx + math.sin(self.session.heading) * dy, 0)

    def test_empty_tank_keeps_onboard_order_and_allows_stationary_updates_and_recovery(self):
        self.phone_pickup()
        order = self.session.order
        self.session.paused = False
        self.session.fuel = .00001
        edge = self.game.roads.edges[self.session.edge]
        x, y = self.session.point
        heading = self.game.roads.angle(edge)
        state = self.cmd("move", x=x + .1 * math.cos(heading), y=y + .1 * math.sin(heading),
                         heading=heading, speed=.5, dt=.3)
        self.assertEqual(state["fuel"], 0)
        self.assertEqual(state["speed"], 0)
        state = self.cmd("move", x=state["x"], y=state["y"], heading=heading, speed=0, dt=.3)
        self.assertEqual(state["phase"], "onboard")
        self.assertIs(self.session.order, order)
        self.cmd("recover")
        self.assertIs(self.session.order, order)
        self.assertEqual(self.session.phase, "onboard")
        self.assertEqual(self.session.fuel, 12)

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
        self.assertIsNone(response["destination_point"])
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
        self.assertEqual(state["destination_point"], self.session.order.destination_point)
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

    def test_citizens_walk_spawn_and_stay_alive_while_nearby(self):
        citizen = self.citizen(hailing=False)
        self.session.point = (self.session.point[0] + 100, self.session.point[1])
        point = self.game.citizen_point(citizen)
        self.session.next_citizen = 1
        self.advance(1)
        self.assertNotEqual(point, self.game.citizen_point(citizen))
        self.assertEqual(len(self.session.citizens), 6)
        self.assertEqual(self.session.next_citizen - self.session.elapsed, .5)
        citizen.expires = self.session.elapsed
        self.advance(0)
        self.assertIn(citizen, self.session.citizens)
        self.session.point = (100000, 100000)
        self.advance(0)
        self.assertNotIn(citizen, self.session.citizens)

    def test_relocated_citizens_survive_outside_range_until_original_timeout(self):
        count = len(self.session.citizens)
        self.assertGreater(count, 0)
        for citizen in self.session.citizens:
            self.assertLessEqual(math.dist(self.session.point, self.game.citizen_point(citizen)), CITIZEN_RADIUS)
        original_ids = {c.id for c in self.session.citizens}
        self.at_stop("mongkok")
        self.session.next_citizen = math.inf
        self.session.next_offer = math.inf
        self.advance(0)
        self.assertEqual(len(self.session.citizens), count)
        self.assertEqual(original_ids, {c.id for c in self.session.citizens})
        self.session.elapsed = 151
        self.game.advance_city(self.session, 0)
        self.assertTrue(all(math.dist(self.session.point, self.game.citizen_point(c)) <= CITIZEN_RADIUS
                            for c in self.session.citizens))

    def test_citizen_spawning_has_no_distant_fallback(self):
        self.session.point = (100000, 100000)
        self.session.next_citizen = 0
        self.session.next_offer = math.inf
        self.session.elapsed = 151
        self.advance(0)
        self.assertEqual(self.session.citizens, [])

    def test_spawns_use_safe_paths_both_curbs_and_no_initial_hails(self):
        self.session.citizens = []
        for _ in range(100):
            self.game.spawn_citizen(self.session)
        self.assertEqual({c.side for c in self.session.citizens}, {-1, 1})
        self.assertGreater(len({c.stop for c in self.session.citizens}), 5)
        for citizen in self.session.citizens:
            self.assertFalse(citizen.hailing)
            self.assertTrue(self.game.sidewalks.safe(*citizen.path))
            self.assertLessEqual(math.dist(self.session.point, self.game.citizen_point(citizen)), CITIZEN_RADIUS + 1e-9)

    def test_spawns_near_mapped_flyovers_stay_clear_of_their_footprints(self):
        self.session.point = self.game.midpoint(self.game.flyover_edges[0])
        self.session.citizens = []
        for _ in range(30):
            self.game.spawn_citizen(self.session)
        self.assertEqual(len(self.session.citizens), 30)
        for citizen in self.session.citizens:
            edge = self.game.roads.edges[self.game.stops[citizen.stop].edge]
            self.assertNotIn(edge.kind, {"motorway", "trunk"})
            for flyover in self.game.flyover_edges:
                self.assertGreaterEqual(
                    segment_distance(*citizen.path, self.game.roads.nodes[flyover.a],
                                     self.game.roads.nodes[flyover.b]),
                    self.game.roads.radius(flyover) + .35 - 1e-8,
                )

    def test_walking_beyond_range_retains_citizen_until_expiry(self):
        citizen = self.citizen(hailing=False)
        citizen.fraction = 0.5
        citizen.direction = 1
        point = self.game.citizen_point(citizen)
        edge = self.game.roads.edges[self.game.stops[citizen.stop].edge]
        angle = self.game.roads.angle(edge)
        self.session.point = (
            point[0] - (CITIZEN_RADIUS - 0.1) * math.cos(angle),
            point[1] - (CITIZEN_RADIUS - 0.1) * math.sin(angle),
        )
        self.session.next_citizen = self.session.next_offer = math.inf
        self.advance(1)
        self.assertIn(citizen, self.session.citizens)
        self.session.elapsed = citizen.expires
        self.game.advance_city(self.session, 0)
        self.assertNotIn(citizen, self.session.citizens)
        for nearby in self.session.citizens:
            self.assertLessEqual(math.dist(self.session.point, self.game.citizen_point(nearby)), CITIZEN_RADIUS)

    def test_spawn_cap_counts_only_citizens_inside_radius(self):
        self.session.citizens = []
        for _ in range(100):
            self.game.spawn_citizen(self.session)
        self.session.next_offer = math.inf
        self.session.next_citizen = 0
        self.game.advance_city(self.session, 0)
        self.assertEqual(len(self.session.citizens), 100)
        self.at_stop("mongkok")
        self.session.next_citizen = 0
        self.game.advance_city(self.session, 0)
        self.assertEqual(len(self.session.citizens), 105)
        local = [c for c in self.session.citizens
                 if math.dist(self.session.point, self.game.citizen_point(c)) <= CITIZEN_RADIUS]
        self.assertLessEqual(len(local), 100)
        self.assertEqual(len(local), 5)

    def test_population_refills_gradually_to_100_within_ten_seconds(self):
        self.session.citizens = []
        self.session.next_offer = math.inf
        self.session.next_citizen = 0
        self.game.advance_city(self.session, 0)
        self.assertEqual(len(self.session.citizens), 5)
        self.game.advance_city(self.session, 0)
        self.assertEqual(len(self.session.citizens), 5)
        for _ in range(19):
            self.session.elapsed += .5
            self.game.advance_city(self.session, 0)
        self.assertEqual(len(self.session.citizens), 100)
        self.session.elapsed += .5
        self.game.advance_city(self.session, 0)
        self.assertEqual(len(self.session.citizens), 100)

    def test_refill_batch_stops_at_local_cap(self):
        self.session.citizens = []
        for _ in range(98):
            self.game.spawn_citizen(self.session)
        self.session.next_offer = math.inf
        self.session.next_citizen = 0
        self.game.advance_city(self.session, 0)
        self.assertEqual(len(self.session.citizens), 100)

    def nearby_walker(self, require_legal=False):
        citizens = self.session.citizens
        if require_legal:
            eligible = []
            for candidate in citizens:
                edge = self.game.roads.edges[self.game.stops[candidate.stop].edge]
                point = self.game.citizen_point(candidate)
                centre = project(point, self.game.roads.nodes[edge.a], self.game.roads.nodes[edge.b])[0]
                angle = self.game.roads.angle(edge)
                offset = (edge.width or 10) / 2 + .8
                curb = (centre[0] - math.sin(angle) * offset * candidate.side,
                        centre[1] + math.cos(angle) * offset * candidate.side)
                if self.game.street_pickup_allowed(edge, centre) and self.game.sidewalks.safe(point, curb):
                    eligible.append(candidate)
            self.assertTrue(eligible, "No legal local curb approach")
            citizens = eligible
        citizen = citizens[0]
        self.session.citizens = [citizen]
        self.session.point = self.game.citizen_point(citizen)
        self.session.paused = False
        self.session.next_citizen = self.session.next_offer = math.inf
        return citizen

    def test_hailing_citizen_cannot_be_collected_on_mapped_no_stopping_road(self):
        citizen = self.citizen()
        way = self.game.roads.edges[self.game.stops[citizen.stop].edge].way
        with patch.object(self.game.roads, "no_stopping_ways", {way}):
            self.assertFalse(self.game.citizen_ready(self.session, citizen))
            with self.assertRaisesRegex(RuleError, "hailing citizen"):
                self.cmd("door", citizen=citizen.id)

    def test_only_visible_empty_taxi_rolls_hail_and_respects_cooldown(self):
        citizen = self.nearby_walker()
        with patch.object(self.session.rng, "random", return_value=.9) as roll:
            self.game.advance_city(self.session, 0)
            roll.assert_not_called()
            self.game.advance_city(self.session, 0, [citizen.id])
            self.assertEqual(roll.call_count, 1)
            self.assertEqual(citizen.next_hail, 300)
            self.session.elapsed = 299
            self.game.advance_city(self.session, 0, [citizen.id])
            self.assertEqual(roll.call_count, 1)
            self.session.elapsed = 300
            self.game.advance_city(self.session, 0, [citizen.id])
            self.assertEqual(roll.call_count, 2)
            self.session.elapsed = 600
            self.session.phase = "onboard"
            self.game.advance_city(self.session, 0, [citizen.id])
            self.assertEqual(roll.call_count, 2)

    def test_accepted_phone_order_blocks_new_hails_but_keeps_existing_hails(self):
        self.cmd("accept", order=self.session.offers[0].id)
        citizen = self.nearby_walker()
        with patch.object(self.session.rng, "random", return_value=0) as roll:
            self.game.advance_city(self.session, 0, [citizen.id])
        roll.assert_not_called()
        self.assertFalse(citizen.seeking_curb)
        citizen.hailing = True
        self.game.advance_city(self.session, 0, [citizen.id])
        self.assertTrue(citizen.hailing)

    def test_waiting_phone_order_also_blocks_new_hails(self):
        order = self.session.offers.pop()
        self.session.queue = [order]
        citizen = self.nearby_walker()
        with patch.object(self.session.rng, "random", return_value=0) as roll:
            self.game.advance_city(self.session, 0, [citizen.id])
        roll.assert_not_called()
        self.assertFalse(citizen.seeking_curb)

    def test_hail_timeout_starts_at_curb_then_cools_down_and_returns_to_original_walk(self):
        citizen = self.nearby_walker(require_legal=True)
        path, distance, direction = citizen.path, citizen.distance, citizen.direction
        with patch.object(self.session.rng, "random", return_value=0):
            self.game.advance_city(self.session, 0, [citizen.id])
        self.assertTrue(citizen.seeking_curb)
        self.session.elapsed = 4
        self.game.advance_city(self.session, 4)
        self.assertTrue(citizen.hailing)
        self.assertTrue(45 <= citizen.hail_until - self.session.elapsed <= 120)
        end = citizen.hail_until
        self.session.elapsed = end - .01
        self.game.advance_city(self.session, 0)
        self.assertTrue(citizen.hailing)
        self.session.elapsed = end
        point = self.game.citizen_point(citizen)
        self.game.advance_city(self.session, 0, [citizen.id])
        self.assertFalse(citizen.hailing)
        self.assertEqual(self.game.citizen_point(citizen), point)
        self.assertEqual(citizen.next_hail, end + CITIZEN_HAIL_COOLDOWN)
        self.game.advance_city(self.session, 4, [citizen.id])
        self.assertEqual(citizen.path, path)
        self.assertEqual(citizen.direction, direction)
        self.assertAlmostEqual(citizen.distance, distance)
        self.assertFalse(citizen.seeking_curb)
        with patch.object(self.session.rng, "random", return_value=0) as roll:
            self.session.elapsed = citizen.next_hail - .01
            self.game.advance_city(self.session, 0, [citizen.id])
            roll.assert_not_called()
            self.session.elapsed = citizen.next_hail
            self.game.advance_city(self.session, 0, [citizen.id])
            roll.assert_called_once()
        self.assertTrue(citizen.seeking_curb)

    def test_successful_hail_walks_to_safe_curb_before_waving(self):
        citizen = self.nearby_walker(require_legal=True)
        with patch.object(self.session.rng, "random", return_value=0):
            self.game.advance_city(self.session, 0, [citizen.id])
        self.assertTrue(citizen.seeking_curb)
        self.assertFalse(citizen.hailing)
        self.assertTrue(self.game.sidewalks.safe(*citizen.path))
        self.game.advance_city(self.session, 4)
        self.assertTrue(citizen.hailing)
        self.assertFalse(citizen.seeking_curb)

    def test_hail_is_rejected_outside_80_metres_and_while_paused(self):
        citizen = self.nearby_walker()
        self.session.point = (self.session.point[0] + 81, self.session.point[1])
        with patch.object(self.session.rng, "random") as roll:
            self.game.advance_city(self.session, 0, [citizen.id, "unknown"])
            roll.assert_not_called()
            self.session.point = self.game.citizen_point(citizen)
            self.session.paused = True
            self.game.advance_city(self.session, 0, [citizen.id])
            roll.assert_not_called()

    def test_snapshot_clock_matches_citizen_motion_without_rounding(self):
        self.session.elapsed = 19 / 60
        state = self.game.snapshot(self.session)
        self.assertEqual(state["elapsed"], self.session.elapsed)
        self.assertEqual(state["elapsed"], state["citizens_at"])


class OrderApiTests(unittest.TestCase):
    def test_unreachable_phone_pickup_is_declined_without_interrupting_trip(self):
        with TestClient(app) as client:
            initial = client.post("/api/sessions").json()
            session = api_game.sessions[initial["id"]]
            api_game.offer(session)
            session.edge = "151226328:7:1172757994"
            session.point = (-779.387294143514, -965.3947039211315)
            session.history = (api_game.roads.edges[session.edge].way,)
            session.closed = {30151133}
            session.phase = "onboard"
            session.order = session.offers.pop()
            offer = session.offers[-1]
            offer.pickup = "street-101183499:1:6386068430"
            current_order = session.order
            url = f"/api/sessions/{session.id}/commands"
            request = {"seq": 1, "command": {"action": "accept", "order": offer.id}}
            result = client.post(url, json=request)
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.json()["command_error"], "pickup_unreachable")
            self.assertEqual(result.json()["phase"], "onboard")
            self.assertIs(session.order, current_order)
            self.assertIn(offer, session.offers)
            self.assertEqual(session.queue, [])
            self.assertEqual(client.post(url, json=request).json(), result.json())
            session.closed = set()
            self.assertIsNone(api_game.roads.route(
                api_game.roads.edges[session.edge],
                api_game.roads.edges[api_game.stops[offer.pickup].edge],
                session.history, session.closed, session.traffic,
            ))
            pickup = api_game.roads.edges[api_game.stops[offer.pickup].edge]
            session.edge = pickup.id
            session.point = api_game.roads.nodes[pickup.a]
            session.history = (pickup.way,)
            request["seq"] = 2
            accepted = client.post(url, json=request)
            self.assertEqual(accepted.status_code, 200)
            self.assertNotIn("command_error", accepted.json())
            self.assertEqual(session.queue, [offer])

    def test_live_waterloo_dead_end_does_not_fail_scheduled_offer_move(self):
        with TestClient(app) as client:
            initial = client.post("/api/sessions").json()
            session = api_game.sessions[initial["id"]]
            session.edge = "1079194348:0:1152660823"
            session.point = (764.8523060264388, -734.7486001717523)
            session.heading = -2.5490806065887543
            session.history = (api_game.roads.edges[session.edge].way,)
            session.closed = {30150244}
            session.elapsed = 165.01666666666722
            session.next_offer = 0
            session.next_citizen = math.inf
            session.paused = False
            with self.assertRaisesRegex(RuleError, "No reachable passenger trip"):
                api_game.make_order(session)
            url = f"/api/sessions/{session.id}/commands"
            request = {"seq": 1, "command": {
                "action": "move", "x": session.point[0], "y": session.point[1],
                "heading": session.heading, "speed": 0, "dt": .3,
            }}
            with self.assertLogs("game", level="WARNING"):
                moved = client.post(url, json=request)
            self.assertEqual(moved.status_code, 200)
            self.assertEqual(moved.json()["seq"], 1)
            self.assertAlmostEqual(moved.json()["elapsed"], 165.31666666666722)
            self.assertEqual(client.post(url, json=request).json(), moved.json())
            request["seq"] = 2
            continued = client.post(url, json=request)
            self.assertEqual(continued.status_code, 200)
            self.assertAlmostEqual(continued.json()["elapsed"], moved.json()["elapsed"] + .3)

    def test_move_visibility_reaches_hailing_logic_and_curb_arrival(self):
        with TestClient(app) as client:
            state = client.post("/api/sessions").json()
            url = f"/api/sessions/{state['id']}/commands"
            visible = [c["id"] for c in state["citizens"]
                       if math.dist(c["point"], (state["x"], state["y"])) <= 80]
            self.assertTrue(visible)
            resumed = client.post(url, json={
                "seq": 1, "command": {"action": "pause", "paused": False},
            })
            self.assertEqual(resumed.status_code, 200)
            move = {"action": "move", "x": state["x"], "y": state["y"],
                    "heading": state["heading"], "speed": 0, "dt": 19 / 60,
                    "visible_citizens": visible}
            with patch.object(api_game.sessions[state["id"]].rng, "random", return_value=0):
                approach = client.post(url, json={"seq": 2, "command": move})
            self.assertEqual(approach.status_code, 200)
            approaching = [c["id"] for c in approach.json()["citizens"] if c["motion"]["seeking_curb"]]
            self.assertTrue(approaching)
            self.assertFalse(any(c["hailing"] for c in approach.json()["citizens"]))
            self.assertEqual(approach.json()["elapsed"], approach.json()["citizens_at"])
            arrived = client.post(url, json={
                "seq": 3, "command": {**move, "dt": 2, "visible_citizens": []},
            })
            self.assertEqual(arrived.status_code, 200)
            hailing = [c for c in arrived.json()["citizens"] if c["id"] in approaching]
            self.assertTrue(all(c["hailing"] and c["motion"]["speed"] == 0 for c in hailing))

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
