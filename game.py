"""Session rules. Browser movement is an arcade simulation, not anti-cheat."""

from dataclasses import dataclass, field
import math
import random
import time
from uuid import uuid4

from roads import DRIVING, Edge, Point, RoadMap, project


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


PASSENGERS = [
    {"name": "Auntie Lam", "zh": "林太", "role": "Market regular", "role_zh": "街市熟客",
     "pickup": "Morning! I have vegetables in the bag. Easy on the corners, please.",
     "pickup_zh": "早晨！袋菜唔好整爛呀，轉彎慢慢嚟。",
     "arrival": "Right here is lovely. Time to get dinner started!",
     "arrival_zh": "呢度落就得喇，返去煮飯先！"},
    {"name": "Jason", "zh": "阿俊", "role": "Late for rehearsal", "role_zh": "趕去夾 band",
     "pickup": "Thanks for stopping! My band is already waiting.",
     "pickup_zh": "唔該晒！班 band 友等緊我呀。",
     "arrival": "Made it! That guitar solo won't play itself.",
     "arrival_zh": "到喇！個結他 solo 等緊我呀。"},
    {"name": "Mei", "zh": "阿美", "role": "Neighbourhood photographer", "role_zh": "社區攝影師",
     "pickup": "I love these streets. There's a different story on every corner.",
     "pickup_zh": "我好鍾意呢區，每個街角都有故事。",
     "arrival": "Perfect light today. Thank you for the ride!",
     "arrival_zh": "今日啲光好靚，多謝你車我過嚟！"},
]


class Game:
    def __init__(self, roads: RoadMap):
        self.roads = roads
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
                e for e in roads.edges.values()
                if e.length >= 30 and e.layer == "0" and e.bridge == "no" and e.tunnel == "no"
                and e.kind not in {"service", "primary_link", "secondary_link", "tertiary_link"}
            ]
            edge = min(candidates, key=lambda e: math.dist((x, y), self.midpoint(e)))
            self.stops[key] = Stop(key, name, zh, edge.id, self.midpoint(edge))
        self.depot = self.stops["depot"]
        self.incident_ways = sorted({
            e.way for e in roads.edges.values()
            if e.kind == "residential" and e.name != "Local road"
            and all(roads.edges[s.edge].way != e.way for s in self.stops.values())
        })

    def midpoint(self, edge: Edge) -> Point:
        a, b = self.roads.nodes[edge.a], self.roads.nodes[edge.b]
        return ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)

    def create(self) -> dict:
        now = time.monotonic()
        self.sessions = {key: value for key, value in self.sessions.items() if now - value.last_seen < 3600}
        if len(self.sessions) >= 200:
            raise RuleError("The prototype is busy. Please try again later.")
        edge = self.roads.edges[self.depot.edge]
        session = Session(uuid4().hex, self.depot.point, self.roads.angle(edge), edge.id, (edge.way,))
        rng = random.Random(17)
        ways = sorted({e.way for e in self.roads.edges.values() if e.kind in {"primary", "secondary", "tertiary"}})
        for way in rng.sample(ways, min(14, len(ways))):
            session.traffic[way] = 0.48
        self.offer(session)
        self.sessions[session.id] = session
        return self.snapshot(session)

    def offer(self, session: Session) -> None:
        start = self.roads.edges[session.edge]
        options = []
        for stop in self.stops.values():
            if stop.id == "depot":
                continue
            route = self.roads.route(start, self.roads.edges[stop.edge], session.history, session.closed, session.traffic)
            if route:
                options.append(stop)
        if len(options) < 2:
            raise RuleError("No reachable passenger orders. Clear the closure or return to the depot.")
        pickup = options[session.trips % len(options)]
        choices = [
            s for s in options if s.id != pickup.id and self.roads.route(
                self.roads.edges[pickup.edge], self.roads.edges[s.edge],
                (self.roads.edges[pickup.edge].way,), session.closed, session.traffic,
            )
        ]
        if not choices:
            raise RuleError("No reachable drop-off for this pickup.")
        destination = choices[(session.trips * 3) % len(choices)]
        session.pickup, session.destination = pickup.id, destination.id
        session.fare = 45 + round(math.dist(pickup.point, destination.point) * 0.07)
        session.passenger = session.trips % len(PASSENGERS)
        session.phase = "available"
        session.dialogue = "offer"
        session.route_key = None

    def stop_valid(self, session: Session, stop: Stop) -> bool:
        current = self.roads.edges[session.edge]
        target = self.roads.edges[stop.edge]
        return (
            abs(session.speed) <= 0.6 and math.dist(session.point, stop.point) <= 13
            and current.way == target.way
            and (current.layer, current.bridge, current.tunnel) == (target.layer, target.bridge, target.tunnel)
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
        if distance > elapsed * DRIVING["max_speed"] + 6:
            raise RuleError("Movement jumped too far. Pause and return to the road.")
        if session.fuel <= 0 and distance > 0.5:
            raise RuleError("Out of fuel. Call recovery.")
        previous = self.roads.edges[session.edge]
        history = session.history
        warning = session.warning
        cursor = old
        total_distance = 0.0
        trail = [*payload.get("trail", []), {"x": point[0], "y": point[1], "heading": heading}]
        for sample in trail:
            destination = (float(sample["x"]), float(sample["y"]))
            sample_heading = float(sample["heading"])
            if not all(math.isfinite(v) for v in (*destination, sample_heading)):
                raise RuleError("Movement must contain finite numbers.")
            segment = math.dist(cursor, destination)
            total_distance += segment
            if total_distance > elapsed * DRIVING["max_speed"] + 6:
                raise RuleError("Movement jumped too far. Pause and return to the road.")
            steps = max(1, math.ceil(segment / 0.4))
            origin = cursor
            for i in range(1, steps + 1):
                sample_point = (origin[0] + (destination[0] - origin[0]) * i / steps,
                                origin[1] + (destination[1] - origin[1]) * i / steps)
                radius = self.roads.document["driving"]["taxi_radius"]
                if not (left + radius <= sample_point[0] <= right - radius
                        and top + radius <= sample_point[1] <= bottom - radius):
                    raise RuleError("The taxi footprint must remain inside the playable district.")
                match = self.roads.corridor_match(
                    sample_point, sample_heading, previous,
                    session.selected_exit, session.selected_junction,
                )
                if match is None:
                    raise RuleError("The taxi footprint must remain on a connected road.")
                if match.edge.way in session.closed and segment > 0.01:
                    raise RuleError("Road closed. Stop and choose another road, or call recovery.")
                if match.edge.id != previous.id:
                    if previous.b == match.edge.a and previous.a != match.edge.b:
                        warning = "" if self.roads.legal(previous, match.edge, history) else "restricted"
                    history = self.roads.history(history, match.edge.way)
                    previous = match.edge
            cursor = destination
        if session.paused and total_distance > 0.01:
            raise RuleError("Resume the game before driving.")
        if session.fuel <= 0 and total_distance > 0.01:
            raise RuleError("Out of fuel. Call recovery.")
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

    def command(self, session_id: str, seq: int, action: str, payload: dict) -> dict:
        session = self.sessions.get(session_id)
        if session is None:
            raise RuleError("Session expired or server restarted. Start a new shift.")
        if time.monotonic() - session.last_seen > 3600:
            del self.sessions[session_id]
            raise RuleError("Session expired or server restarted. Start a new shift.")
        if seq == session.seq and session.last_response is not None:
            if session.last_request != (action, payload):
                raise RuleError("A sequence number cannot be reused for a different command.")
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
            if session.phase != "available":
                raise RuleError("There is no order to accept.")
            session.phase = "pickup"
            session.dialogue = "accepted"
            session.route_key = None
        elif action == "service":
            target = self.target(session)
            if target is None or not self.stop_valid(session, target):
                raise RuleError("Stop at the marked roadside point before picking up or dropping off.")
            if session.phase == "pickup":
                session.phase = "onboard"
                session.dialogue = "pickup"
            else:
                session.money += session.fare
                session.trips += 1
                session.phase = "complete"
                session.dialogue = "arrival"
            session.route_key = None
        elif action == "next":
            if session.phase not in {"complete", "pickup", "onboard"}:
                raise RuleError("Finish or cancel the current order first.")
            self.offer(session)
        elif action == "recover":
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
                raise RuleError("Not enough earnings to fill the tank. Recovery includes emergency fuel.")
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
        match = self.roads.corridor_match(session.point, session.heading, incoming)
        _, _, fraction = project(session.point, self.roads.nodes[incoming.a], self.roads.nodes[incoming.b])
        if (
            not session.paused or not match
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

    def snapshot(self, session: Session) -> dict:
        edge = self.roads.edges[session.edge]
        wrongway = edge.oneway and (edge.wrongway != (session.speed < -0.05))
        warning = "wrongway" if wrongway else session.warning
        target = self.target(session)
        no_route = False
        if target:
            route_key = (edge.id, target.edge, tuple(sorted(session.closed)), session.history)
            if session.route_key != route_key:
                session.route = self.roads.route(edge, self.roads.edges[target.edge], session.history, session.closed, session.traffic)
                session.route_key = route_key
            no_route = session.route is None
        else:
            session.route = None
        options = []
        if len(self.roads.neighbors.get(edge.b, ())) >= 3:
            for nxt in self.roads.branches(edge, session.closed):
                delta = math.atan2(math.sin(self.roads.angle(nxt) - self.roads.angle(edge)), math.cos(self.roads.angle(nxt) - self.roads.angle(edge)))
                options.append({"edge": nxt.id, "name": nxt.name, "zh": nxt.zh, "angle": delta,
                                "restricted": not self.roads.legal(edge, nxt, session.history)})
        return {
            "id": session.id, "version": self.roads.version, "seq": session.seq,
            "x": session.point[0], "y": session.point[1], "heading": session.heading,
            "speed": session.speed, "edge": session.edge, "paused": session.paused,
            "elapsed": round(session.elapsed, 1), "fuel": round(session.fuel, 3),
            "money": session.money, "trips": session.trips, "upgrades": session.upgrades[:],
            "phase": session.phase, "fare": session.fare,
            "pickup": session.pickup, "destination": session.destination,
            "passenger": PASSENGERS[session.passenger], "dialogue": session.dialogue,
            "route": session.route, "no_route": no_route, "warning": warning,
            "options": options, "junction": edge.b if options else None,
            "stacked_choice": self.roads.stacked_choice(edge, session.closed),
            "junction_choice": self.roads.junction_choice(edge, session.closed),
            "closed": sorted(session.closed), "traffic": session.traffic,
            "selected_exit": session.selected_exit, "selected_junction": session.selected_junction,
            "service_ready": bool(target and self.stop_valid(session, target)),
            "depot_ready": self.stop_valid(session, self.depot),
        }
