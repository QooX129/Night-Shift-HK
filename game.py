"""Session rules. Browser movement is an arcade simulation, not anti-cheat."""

from dataclasses import dataclass, field
import math
import random
import time
from uuid import uuid4

from roads import DRIVING, Edge, Point, RoadMap, project
from pedestrians import Sidewalks, advance_walk, path_pose


CITIZEN_RADIUS = 220
CITIZEN_HAIL_PROBABILITY = 0.10
CITIZEN_HAIL_COOLDOWN = 300
CITIZEN_HAIL_DISTANCE = 80


class RuleError(ValueError):
    pass


@dataclass(frozen=True)
class Stop:
    id: str
    name: str
    zh: str
    edge: str
    point: Point


@dataclass
class Order:
    id: str
    pickup: str
    destination: str
    passenger: int
    fare: int
    expires: float
    source: str = "phone"
    deadline: float | None = None


@dataclass
class Citizen:
    id: str
    stop: str
    fraction: float
    direction: int
    passenger: int
    expires: float
    hailing: bool
    approached: bool = False
    path: tuple[Point, ...] = ()
    distance: float = 0
    speed: float = 1.1
    side: int = 1
    next_hail: float = 0
    seeking_curb: bool = False


@dataclass
class Session:
    id: str
    point: Point
    heading: float
    edge: str
    history: tuple[int, ...]
    speed: float = 0
    paused: bool = True
    elapsed: float = 0
    fuel: float = 100
    money: int = 120
    trips: int = 0
    upgrades: list[str] = field(default_factory=list)
    phase: str = "available"
    pickup: str = ""
    destination: str = ""
    passenger: int = 0
    fare: int = 0
    seq: int = 0
    last_seen: float = field(default_factory=time.monotonic)
    last_response: dict | None = None
    last_request: tuple | None = None
    closed: set[int] = field(default_factory=set)
    traffic: dict[int, float] = field(default_factory=dict)
    incident: int = 0
    selected_exit: str | None = None
    selected_junction: str | None = None
    warning: str = ""
    route: list[str] | None = None
    route_key: tuple | None = None
    route_point: Point | None = None
    dialogue: str = "welcome"
    offers: list[Order] = field(default_factory=list)
    queue: list[Order] = field(default_factory=list)
    order: Order | None = None
    citizens: list[Citizen] = field(default_factory=list)
    rng: random.Random = field(default_factory=random.Random)
    next_offer: float = 0
    next_citizen: float = 0
    boarding: dict | None = None
    cancelled_orders: int = 0


PASSENGERS = [
    {
        "name": "Auntie Lam",
        "zh": "林太",
        "role": "Market regular",
        "role_zh": "街市熟客",
        "pickup": "Morning! I have vegetables in the bag. Easy on the corners, please.",
        "pickup_zh": "早晨！袋菜唔好整爛呀，轉彎慢慢嚟。",
        "arrival": "Right here is lovely. Time to get dinner started!",
        "arrival_zh": "呢度落就得喇，返去煮飯先！",
    },
    {
        "name": "Jason",
        "zh": "阿俊",
        "role": "Late for rehearsal",
        "role_zh": "趕去夾 band",
        "pickup": "Thanks for stopping! My band is already waiting.",
        "pickup_zh": "唔該晒！班 band 友等緊我呀。",
        "arrival": "Made it! That guitar solo won't play itself.",
        "arrival_zh": "到喇！個結他 solo 等緊我呀。",
    },
    {
        "name": "Mei",
        "zh": "阿美",
        "role": "Neighbourhood photographer",
        "role_zh": "社區攝影師",
        "pickup": "I love these streets. There's a different story on every corner.",
        "pickup_zh": "我好鍾意呢區，每個街角都有故事。",
        "arrival": "Perfect light today. Thank you for the ride!",
        "arrival_zh": "今日啲光好靚，多謝你車我過嚟！",
    },
]


class Game:
    def __init__(self, roads: RoadMap):
        self.roads = roads
        self.sidewalks = Sidewalks(roads)
        self.sessions: dict[str, Session] = {}
        anchors = [
            ("market", "Near Yau Ma Tei market", "油麻地街市附近", 22.3102, 114.1702),
            ("temple", "Near Temple Street", "廟街附近", 22.3075, 114.1703),
            ("cinema", "Near Yau Ma Tei Theatre", "油麻地戲院附近", 22.3130, 114.1707),
            ("mongkok", "Near Mong Kok station", "旺角站附近", 22.3191, 114.1693),
            ("ladies", "Near Tung Choi Street", "通菜街附近", 22.3180, 114.1711),
            ("waterloo", "Near Waterloo Road", "窩打老道附近", 22.3135, 114.1730),
            ("depot", "Taxi rest stop", "的士休息站", 22.3105, 114.1694),
        ]
        self.stops: dict[str, Stop] = {}
        lat, lon = roads.document["origin"]
        for key, name, zh, stop_lat, stop_lon in anchors:
            x = (stop_lon - lon) * 111_320 * math.cos(math.radians(lat))
            y = (lat - stop_lat) * 111_320
            candidates = [
                e
                for e in roads.edges.values()
                if e.length >= 30
                and e.layer == "0"
                and e.bridge == "no"
                and e.tunnel == "no"
                and e.kind
                not in {"service", "primary_link", "secondary_link", "tertiary_link"}
            ]
            edge = min(candidates, key=lambda e: math.dist((x, y), self.midpoint(e)))
            self.stops[key] = Stop(key, name, zh, edge.id, self.midpoint(edge))
        self.depot = self.stops["depot"]
        street_edges = [
            e
            for e in roads.edges.values()
            if not e.wrongway
            and e.length >= 30
            and e.layer == "0"
            and e.bridge == "no"
            and e.tunnel == "no"
            and e.kind
            not in {"service", "primary_link", "secondary_link", "tertiary_link"}
        ]
        for edge in random.Random(29).sample(street_edges, min(96, len(street_edges))):
            key = f"street-{edge.id}"
            self.stops[key] = Stop(
                key, edge.name, edge.zh, edge.id, self.midpoint(edge)
            )
        self.street_stops = [s for s in self.stops.values() if s.id != "depot"]
        self.incident_ways = sorted(
            {
                e.way
                for e in roads.edges.values()
                if e.kind == "residential"
                and e.name != "Local road"
                and all(roads.edges[s.edge].way != e.way for s in self.stops.values())
            }
        )

    def midpoint(self, edge: Edge) -> Point:
        a, b = self.roads.nodes[edge.a], self.roads.nodes[edge.b]
        return ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)

    def create(self) -> dict:
        now = time.monotonic()
        self.sessions = {
            key: value
            for key, value in self.sessions.items()
            if now - value.last_seen < 3600
        }
        if len(self.sessions) >= 200:
            raise RuleError("The prototype is busy. Please try again later.")
        edge = self.roads.edges[self.depot.edge]
        session = Session(
            uuid4().hex, self.depot.point, self.roads.angle(edge), edge.id, (edge.way,)
        )
        rng = random.Random(17)
        ways = sorted(
            {
                e.way
                for e in self.roads.edges.values()
                if e.kind in {"primary", "secondary", "tertiary"}
            }
        )
        for way in rng.sample(ways, min(14, len(ways))):
            session.traffic[way] = 0.48
        self.offer(session)
        session.next_offer = session.rng.uniform(120, 180)
        for _ in range(60):
            self.spawn_citizen(session)
        session.next_citizen = session.rng.uniform(8, 16)
        self.sessions[session.id] = session
        return self.snapshot(session)

    def offer(self, session: Session) -> None:
        order = self.make_order(session)
        session.offers.append(order)
        if session.phase == "available":
            self.display_order(session, session.offers[0], "available", "offer")

    def make_order(self, session: Session, pickup: Stop | None = None) -> Order:
        candidates = session.rng.sample(self.street_stops, len(self.street_stops))
        start = self.roads.edges[session.edge]
        for origin in [pickup] if pickup else candidates:
            edge = self.roads.edges[origin.edge]
            if not self.roads.route(
                start, edge, session.history, session.closed, session.traffic
            ):
                continue
            destination = next(
                (
                    s
                    for s in candidates
                    if s.id != origin.id
                    and math.dist(s.point, origin.point) >= 60
                    and self.roads.route(
                        edge,
                        self.roads.edges[s.edge],
                        (edge.way,),
                        session.closed,
                        session.traffic,
                    )
                ),
                None,
            )
            if destination:
                return Order(
                    uuid4().hex,
                    origin.id,
                    destination.id,
                    session.rng.randrange(len(PASSENGERS)),
                    45 + round(math.dist(origin.point, destination.point) * 0.07),
                    session.elapsed + session.rng.uniform(30, 180),
                )
        raise RuleError(
            "No reachable passenger trip. Clear the closure or return to the depot."
        )

    def display_order(
        self, session: Session, order: Order, phase: str, dialogue: str
    ) -> None:
        session.pickup, session.destination = order.pickup, order.destination
        session.passenger, session.fare = order.passenger, order.fare
        session.phase, session.dialogue = phase, dialogue

    def activate_next(self, session: Session) -> None:
        session.order = session.queue.pop(0) if session.queue else None
        if session.order:
            self.display_order(session, session.order, "pickup", "accepted")
        else:
            session.phase, session.dialogue = "available", "offer"
            session.route_key = None
            if session.offers:
                self.display_order(session, session.offers[0], "available", "offer")

    def spawn_citizen(self, session: Session) -> None:
        candidates = self.sidewalks.nearby(session.point, CITIZEN_RADIUS)
        if not candidates:
            return
        edge, side, path, low, high = session.rng.choices(
            candidates, weights=[high - low for _, _, _, low, high in candidates], k=1
        )[0]
        key = f"pedestrian-{edge.id}"
        if key not in self.stops:
            self.stops[key] = Stop(key, edge.name, edge.zh, edge.id, self.midpoint(edge))
        session.citizens.append(
            Citizen(
                uuid4().hex,
                key,
                0.5,
                session.rng.choice([-1, 1]),
                session.rng.randrange(len(PASSENGERS)),
                session.elapsed + session.rng.uniform(80, 150),
                False,
                path=path,
                distance=session.rng.uniform(low, high),
                speed=session.rng.uniform(.85, 1.35),
                side=side,
            )
        )

    def curb_point(self, stop: Stop, fraction: float = 0.5) -> Point:
        edge = self.roads.edges[stop.edge]
        a, b = self.roads.nodes[edge.a], self.roads.nodes[edge.b]
        angle = self.roads.angle(edge)
        offset = DRIVING["widths"].get(edge.kind, 10) / 2 + 0.8
        return (
            a[0] + (b[0] - a[0]) * fraction - math.sin(angle) * offset,
            a[1] + (b[1] - a[1]) * fraction + math.cos(angle) * offset,
        )

    def citizen_point(self, citizen: Citizen) -> Point:
        if citizen.path:
            return path_pose(citizen.path, citizen.distance)
        return self.curb_point(self.stops[citizen.stop], citizen.fraction)

    def advance_city(self, session: Session, dt: float, visible_citizens: list[str] | None = None) -> None:
        session.offers = [o for o in session.offers if o.expires > session.elapsed]
        expired = [
            o
            for o in session.queue
            if o.deadline is not None and o.deadline <= session.elapsed
        ]
        session.cancelled_orders += len(expired)
        session.queue = [o for o in session.queue if o not in expired]
        if (
            session.order
            and session.phase == "pickup"
            and session.order.deadline is not None
            and session.order.deadline <= session.elapsed
        ):
            session.cancelled_orders += 1
            self.activate_next(session)
        if session.elapsed >= session.next_offer:
            self.offer(session)
            session.next_offer = session.elapsed + session.rng.uniform(45, 180)
        if session.elapsed >= session.next_citizen:
            if len(session.citizens) < 100:
                self.spawn_citizen(session)
            session.next_citizen = session.elapsed + session.rng.uniform(8, 16)
        for citizen in session.citizens:
            if not citizen.hailing:
                if citizen.path:
                    length = sum(math.dist(a, b) for a, b in zip(citizen.path, citizen.path[1:]))
                    if citizen.seeking_curb:
                        citizen.distance = min(length, citizen.distance + dt * citizen.speed)
                        if citizen.distance >= length:
                            citizen.hailing, citizen.seeking_curb = True, False
                    else:
                        citizen.distance, citizen.direction = advance_walk(
                            citizen.distance, citizen.direction, dt * citizen.speed, length
                        )
                else:
                    edge = self.roads.edges[self.stops[citizen.stop].edge]
                    citizen.fraction += citizen.direction * dt * citizen.speed / edge.length
                    if not 0.15 <= citizen.fraction <= 0.85:
                        citizen.fraction = max(0.15, min(0.85, citizen.fraction))
                        citizen.direction *= -1
        nearby = [
            c for c in session.citizens
            if math.dist(session.point, self.citizen_point(c)) <= CITIZEN_RADIUS
        ]
        removed = len(session.citizens) - len(nearby)
        session.citizens = nearby
        for _ in range(removed):
            self.spawn_citizen(session)
        if not session.paused and not session.boarding and session.phase not in {"onboard", "boarding"}:
            visible = set(visible_citizens or ())
            for citizen in session.citizens:
                point = self.citizen_point(citizen)
                if (citizen.id not in visible or citizen.hailing or citizen.seeking_curb
                        or session.elapsed < citizen.next_hail
                        or math.dist(session.point, point) > CITIZEN_HAIL_DISTANCE):
                    continue
                citizen.next_hail = session.elapsed + CITIZEN_HAIL_COOLDOWN
                if session.rng.random() >= CITIZEN_HAIL_PROBABILITY:
                    continue
                edge = self.roads.edges[self.stops[citizen.stop].edge]
                centre = project(point, self.roads.nodes[edge.a], self.roads.nodes[edge.b])[0]
                angle = self.roads.angle(edge)
                offset = (edge.width or DRIVING["widths"].get(edge.kind, 10)) / 2 + .8
                curb = (centre[0] - math.sin(angle) * offset * citizen.side,
                        centre[1] + math.cos(angle) * offset * citizen.side)
                if not self.sidewalks.safe(point, curb):
                    continue
                citizen.path = (point, curb)
                citizen.distance, citizen.direction, citizen.seeking_curb = 0, 1, True
        if session.boarding and session.elapsed >= session.boarding["ends"]:
            alighting = session.boarding.get("alighting")
            session.boarding = None
            if not alighting:
                session.phase, session.dialogue = "onboard", "pickup"
                session.route_key = None
        if session.phase == "available" and session.offers:
            self.display_order(session, session.offers[0], "available", "offer")

    def citizen_ready(self, session: Session, citizen: Citizen) -> bool:
        stop = self.stops[citizen.stop]
        point = self.citizen_point(citizen)
        return citizen.hailing and self.stop_valid(
            session, Stop(stop.id, stop.name, stop.zh, stop.edge, point)
        )

    def open_door(self, session: Session, citizen_id: str) -> None:
        if session.paused or session.boarding or session.phase in {"onboard", "boarding"}:
            raise RuleError(
                "Resume and finish the current passenger trip before opening the door."
            )
        citizen = next((c for c in session.citizens if c.id == citizen_id), None)
        if citizen is None or not self.citizen_ready(session, citizen):
            raise RuleError(
                "Stop beside a hailing citizen on the same road before opening the door."
            )
        order = self.make_order(session, self.stops[citizen.stop])
        order.source, order.passenger = "street", citizen.passenger
        if session.order and session.phase == "pickup":
            session.queue.insert(0, session.order)
        session.order = order
        self.display_order(session, order, "boarding", "boarding")
        session.boarding = {
            "point": self.citizen_point(citizen),
            "starts": session.elapsed,
            "ends": session.elapsed + 1.8,
        }
        session.citizens.remove(citizen)

    def stop_valid(self, session: Session, stop: Stop) -> bool:
        current = self.roads.edges[session.edge]
        target = self.roads.edges[stop.edge]
        return (
            abs(session.speed) <= 0.6
            and math.dist(session.point, stop.point) <= 13
            and current.way == target.way
            and (current.layer, current.bridge, current.tunnel)
            == (target.layer, target.bridge, target.tunnel)
        )

    def target(self, session: Session) -> Stop | None:
        if session.phase == "pickup":
            return self.stops[session.pickup]
        if session.phase == "onboard":
            return self.stops[session.destination]
        return None

    def update_position(self, session: Session, payload: dict) -> None:
        point = (float(payload["x"]), float(payload["y"]))
        speed, heading = float(payload["speed"]), float(payload["heading"])
        elapsed = float(payload["dt"])
        old = session.point
        distance = math.dist(old, point)
        if not all(math.isfinite(v) for v in (*point, speed, heading, elapsed)):
            raise RuleError("Movement must contain finite numbers.")
        left, top, right, bottom = self.roads.bounds
        if not (left <= point[0] <= right and top <= point[1] <= bottom):
            raise RuleError("Outside the playable district. Use Return to road.")
        if not -4 <= speed <= DRIVING["max_speed"] or not 0 <= elapsed <= 4:
            raise RuleError("Invalid speed or movement interval.")
        if session.paused and (distance > 0.5 or elapsed > 0.01):
            raise RuleError("Resume the game before driving.")
        if session.boarding and (distance > 0.01 or abs(speed) > 0.01):
            raise RuleError("Wait for the passenger to finish boarding before driving.")
        if distance > elapsed * DRIVING["max_speed"] + 6:
            raise RuleError("Movement jumped too far. Pause and return to the road.")
        if session.fuel <= 0 and distance > 0.5:
            raise RuleError("Out of fuel. Call recovery.")
        previous = self.roads.edges[session.edge]
        surface_speed_budget = self.roads.speed_limit(previous, old, session.heading)
        escaping_closure = previous.way if previous.way in session.closed else None
        history = session.history
        warning = session.warning
        cursor = old
        total_distance = 0.0
        trail = [
            *payload.get("trail", []),
            {"x": point[0], "y": point[1], "heading": heading},
        ]
        for sample in trail:
            destination = (float(sample["x"]), float(sample["y"]))
            sample_heading = float(sample["heading"])
            if not all(math.isfinite(v) for v in (*destination, sample_heading)):
                raise RuleError("Movement must contain finite numbers.")
            segment = math.dist(cursor, destination)
            total_distance += segment
            if total_distance > elapsed * DRIVING["max_speed"] + 6:
                raise RuleError(
                    "Movement jumped too far. Pause and return to the road."
                )
            steps = max(1, math.ceil(segment / 0.4))
            origin = cursor
            sample_cursor = cursor
            for i in range(1, steps + 1):
                sample_point = (
                    origin[0] + (destination[0] - origin[0]) * i / steps,
                    origin[1] + (destination[1] - origin[1]) * i / steps,
                )
                match = self.roads.corridor_match(
                    sample_point,
                    sample_heading,
                    previous,
                    session.selected_exit,
                    session.selected_junction,
                    check_body=segment > 1e-8,
                    allowance=(
                        self.roads.penetration(sample_cursor, sample_heading, previous)
                        if segment > 1e-8
                        else 0
                    ),
                    closed=session.closed - {escaping_closure},
                )
                if match is None:
                    physical = self.roads.corridor_match(
                        sample_point,
                        sample_heading,
                        previous,
                        session.selected_exit,
                        session.selected_junction,
                        check_body=False,
                    )
                    if physical and physical.edge.way in session.closed:
                        raise RuleError("Road closed. Reverse or steer onto another road.")
                    raise RuleError("The taxi footprint must remain on a connected road.")
                surface_speed_budget = max(surface_speed_budget,
                                           self.roads.speed_limit(match.edge, sample_point, sample_heading))
                if match.edge.way != escaping_closure:
                    escaping_closure = None
                if match.edge.id != previous.id:
                    if previous.b == match.edge.a and previous.a != match.edge.b:
                        warning = (
                            ""
                            if self.roads.legal(previous, match.edge, history)
                            else "restricted"
                        )
                    history = self.roads.history(history, match.edge.way)
                    previous = match.edge
                sample_cursor = sample_point
            cursor = destination
        if session.paused and total_distance > 0.01:
            raise RuleError("Resume the game before driving.")
        if session.fuel <= 0 and total_distance > 0.01:
            raise RuleError("Out of fuel. Call recovery.")
        if total_distance > elapsed * surface_speed_budget + 6:
            raise RuleError("Movement exceeds the road's slope speed limit.")
        if speed > self.roads.speed_limit(previous, point, heading) + 1e-6:
            raise RuleError("Speed exceeds this road's slope limit.")
        session.edge, session.history, session.warning = previous.id, history, warning
        if session.selected_junction:
            node = self.roads.nodes[session.selected_junction]
            if previous.id == session.selected_exit or math.dist(point, node) > 61.5:
                session.selected_exit = session.selected_junction = None
        session.point, session.speed, session.heading = point, speed, heading
        session.elapsed += elapsed
        efficiency = 0.65 if "efficiency" in session.upgrades else 1
        session.fuel = max(0, session.fuel - total_distance * 0.006 * efficiency)
        if session.elapsed // 100 > session.incident and self.incident_ways:
            session.incident = int(session.elapsed // 100)
            occupied = self.roads.edges[session.edge].way
            choices = [w for w in self.incident_ways if w != occupied]
            if choices:
                session.closed = {choices[(session.incident - 1) % len(choices)]}
                session.route_key = None
                session.dialogue = "traffic"
        self.advance_city(session, elapsed, payload.get("visible_citizens"))

    def command(self, session_id: str, seq: int, action: str, payload: dict) -> dict:
        session = self.sessions.get(session_id)
        if session is None:
            raise RuleError("Session expired or server restarted. Start a new shift.")
        if time.monotonic() - session.last_seen > 3600:
            del self.sessions[session_id]
            raise RuleError("Session expired or server restarted. Start a new shift.")
        if seq == session.seq and session.last_response is not None:
            if session.last_request != (action, payload):
                raise RuleError(
                    "A sequence number cannot be reused for a different command."
                )
            return session.last_response
        if seq != session.seq + 1:
            raise RuleError("Commands are out of sequence. Restart the shift.")
        session.last_seen = time.monotonic()
        if action == "move":
            self.update_position(session, payload)
        elif action == "pause":
            session.paused = bool(payload["paused"])
            if not payload.get("preserve_speed", False):
                session.speed = 0
        elif action == "accept":
            if session.phase in {"pickup", "boarding"} or session.queue:
                raise RuleError("Only one pending phone order is allowed.")
            order_id = payload.get("order")
            order = next(
                (
                    o
                    for o in session.offers
                    if (order_id is None or o.id == order_id)
                    and o.expires > session.elapsed
                ),
                None,
            )
            if order is None:
                raise RuleError("This order is no longer available.")
            pickup_edge = self.stops[order.pickup].edge
            if session.phase == "onboard":
                reachable = self.roads.route(
                    self.roads.edges[session.edge],
                    self.roads.edges[pickup_edge],
                    session.history,
                    session.closed,
                    session.traffic,
                )
            else:
                # The pickup becomes the active target, so cache it for the snapshot.
                reachable = self.plan(session, pickup_edge)
            if not reachable:
                raise RuleError(
                    "This pickup is currently unreachable because of road closures."
                )
            order.deadline = session.elapsed + session.rng.uniform(120, 300)
            session.offers.remove(order)
            if session.phase == "onboard":
                session.queue.append(order)
            else:
                session.order = order
                self.display_order(session, order, "pickup", "accepted")
        elif action == "door":
            self.open_door(session, payload["citizen"])
        elif action == "service":
            if session.boarding and session.boarding.get("alighting"):
                raise RuleError("Wait for the passenger to finish getting out.")
            target = self.target(session)
            if target is None or not self.stop_valid(session, target):
                raise RuleError(
                    "Stop at the marked roadside point before picking up or dropping off."
                )
            if session.phase == "pickup":
                session.phase = session.dialogue = "boarding"
                session.boarding = {
                    "point": self.curb_point(target),
                    "starts": session.elapsed,
                    "ends": session.elapsed + 1.8,
                }
            else:
                session.money += session.fare
                session.trips += 1
                session.phase = "complete"
                session.dialogue = "arrival"
                session.boarding = {
                    "point": self.curb_point(target),
                    "starts": session.elapsed,
                    "ends": session.elapsed + 1.8,
                    "alighting": True,
                }
            session.route_key = None
        elif action == "next":
            if session.phase not in {"complete", "pickup", "onboard"}:
                raise RuleError("Finish or cancel the current order first.")
            self.activate_next(session)
        elif action == "recover":
            if session.boarding:
                raise RuleError(
                    "Wait for the passenger to finish boarding before calling recovery."
                )
            if not session.paused and abs(session.speed) > 0.6:
                raise RuleError("Stop before calling recovery.")
            edge = self.roads.edges[self.depot.edge]
            session.point = self.depot.point
            session.edge, session.heading = edge.id, self.roads.angle(edge)
            session.history = (edge.way,)
            session.speed, session.paused = 0, True
            session.money = max(0, session.money - 20)
            session.fuel = max(session.fuel, 12)
            session.selected_exit = session.selected_junction = None
            session.warning = ""
            session.route_key = None
            session.dialogue = "recovery"
        elif action == "refuel":
            if not self.stop_valid(session, self.depot):
                raise RuleError("Stop at the taxi rest stop to refuel.")
            cost = math.ceil((100 - session.fuel) * 0.5)
            if session.money < cost:
                raise RuleError(
                    "Not enough earnings to fill the tank. Recovery includes emergency fuel."
                )
            session.money -= cost
            session.fuel = 100
            session.dialogue = "refuel"
        elif action == "upgrade":
            kind = payload["kind"]
            if kind not in {"efficiency", "engine"}:
                raise RuleError("Unknown upgrade.")
            if not self.stop_valid(session, self.depot):
                raise RuleError("Stop at the taxi rest stop to install upgrades.")
            price = {"efficiency": 100, "engine": 160}[kind]
            if kind in session.upgrades or session.money < price:
                raise RuleError("Upgrade already installed or insufficient earnings.")
            session.money -= price
            session.upgrades.append(kind)
            session.dialogue = "upgrade"
        elif action == "select_road":
            self.select_road(session, payload["incoming"], payload["exit"])
        else:
            raise RuleError("Unknown game action.")
        session.seq = seq
        session.last_request = (action, payload.copy())
        result = self.snapshot(session)
        session.last_response = result
        return result

    def select_road(self, session: Session, incoming_id: str, exit_id: str) -> None:
        incoming = self.roads.edges.get(incoming_id)
        if incoming is None or incoming.id != session.edge:
            raise RuleError("The intersection no longer matches your road.")
        match = self.roads.corridor_match(
            session.point, session.heading, incoming, check_body=False
        )
        _, _, fraction = project(
            session.point, self.roads.nodes[incoming.a], self.roads.nodes[incoming.b]
        )
        if (
            not session.paused
            or not match
            or (1 - fraction) * incoming.length > min(60, incoming.length * 0.8) + 1.5
            or math.cos(session.heading - self.roads.angle(incoming)) <= 0.35
            or not self.roads.junction_choice(incoming, session.closed)
        ):
            raise RuleError("Stop on the approach before choosing a turn.")
        options = self.roads.branches(incoming, session.closed)
        if len(options) < 2:
            raise RuleError("There is no junction choice on this approach.")
        chosen = next((e for e in options if e.id == exit_id), None)
        if chosen is None:
            raise RuleError("That exit is disconnected or closed.")
        session.selected_exit, session.selected_junction = chosen.id, incoming.b
        session.paused = False
        session.dialogue = "selected"

    def plan(self, session: Session, target_edge: str) -> list[str] | None:
        edge = self.roads.edges[session.edge]
        key = (edge.id, target_edge, tuple(sorted(session.closed)), session.history)
        if session.route_key == key:
            return session.route
        previous, route = session.route_key, session.route
        if previous and previous[1:3] == key[1:3] and route and edge.id in route:
            # Still following the plan: keep the remaining legs instead of re-searching.
            route = route[route.index(edge.id):]
        else:
            route = self.roads.route(
                edge,
                self.roads.edges[target_edge],
                session.history,
                session.closed,
                session.traffic,
            )
        session.route, session.route_key = route, key
        return route

    def snapshot(self, session: Session) -> dict:
        edge = self.roads.edges[session.edge]
        wrongway = edge.oneway and (edge.wrongway != (session.speed < -0.05))
        warning = "wrongway" if wrongway else session.warning
        target = self.target(session)
        no_route = False
        if target:
            self.plan(session, target.edge)
            no_route = session.route is None
        else:
            session.route = None
        options = []
        if len(self.roads.neighbors.get(edge.b, ())) >= 3:
            for nxt in self.roads.branches(edge, session.closed):
                delta = math.atan2(
                    math.sin(self.roads.angle(nxt) - self.roads.angle(edge)),
                    math.cos(self.roads.angle(nxt) - self.roads.angle(edge)),
                )
                options.append(
                    {
                        "edge": nxt.id,
                        "name": nxt.name,
                        "zh": nxt.zh,
                        "angle": delta,
                        "restricted": not self.roads.legal(edge, nxt, session.history),
                    }
                )

        def order_data(order: Order) -> dict:
            return {
                "id": order.id,
                "pickup": order.pickup,
                "destination": order.destination,
                "passenger": PASSENGERS[order.passenger],
                "fare": order.fare,
                "source": order.source,
                "distance": round(
                    math.dist(session.point, self.stops[order.pickup].point)
                ),
            }

        accepted = (
            [session.order] if session.order and session.phase == "pickup" else []
        ) + session.queue
        return {
            "id": session.id,
            "version": self.roads.version,
            "seq": session.seq,
            "x": session.point[0],
            "y": session.point[1],
            "heading": session.heading,
            "speed": session.speed,
            "edge": session.edge,
            "paused": session.paused,
            "elapsed": session.elapsed,
            "fuel": round(session.fuel, 3),
            "money": session.money,
            "trips": session.trips,
            "upgrades": session.upgrades[:],
            "phase": session.phase,
            "fare": session.fare,
            "pickup": session.pickup,
            "destination": ""
            if session.phase == "boarding"
            and session.order
            and session.order.source == "street"
            else session.destination,
            "customer": self.curb_point(self.stops[session.pickup])
            if session.phase == "pickup"
            else None,
            "passenger": PASSENGERS[session.passenger],
            "dialogue": session.dialogue,
            "route": session.route,
            "no_route": no_route,
            "warning": warning,
            "options": options,
            "junction": edge.b if options else None,
            "stacked_choice": self.roads.stacked_choice(edge, session.closed),
            "junction_choice": self.roads.junction_choice(edge, session.closed),
            "closed": sorted(session.closed),
            "traffic": session.traffic,
            "selected_exit": session.selected_exit,
            "selected_junction": session.selected_junction,
            "service_ready": bool(target and self.stop_valid(session, target)),
            "depot_ready": self.stop_valid(session, self.depot),
            "offers": [order_data(o) for o in session.offers],
            "accepted_orders": [order_data(o) for o in accepted],
            "can_accept": session.phase not in {"pickup", "boarding"}
            and not session.queue,
            "active_order": session.order.id if session.order else None,
            "order_source": session.order.source if session.order else None,
            "boarding": session.boarding.copy() if session.boarding else None,
            "cancelled_orders": session.cancelled_orders,
            "citizens": [
                {
                    "id": c.id,
                    "point": self.citizen_point(c),
                    "edge": self.stops[c.stop].edge,
                    "hailing": c.hailing,
                    "motion": {
                        "points": c.path, "distance": c.distance, "direction": c.direction,
                        "speed": 0 if c.hailing else c.speed, "seeking_curb": c.seeking_curb,
                    } if c.path else None,
                    "ready": session.phase not in {"onboard", "boarding"}
                    and not session.boarding
                    and self.citizen_ready(session, c),
                }
                for c in session.citizens
            ],
            "citizens_at": session.elapsed,
            "citizen_hailing_distance": CITIZEN_HAIL_DISTANCE,
        }
