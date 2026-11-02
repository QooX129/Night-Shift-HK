"""Metric road geometry, turn restrictions, and routing for the district."""

from dataclasses import asdict, dataclass, replace
import hashlib
import heapq
import itertools
import json
import math
import warnings
from pathlib import Path
from typing import TypedDict
from elevation import road_profiles, surface_pose, slope_speed_limit


Point = tuple[float, float]
class DrivingConfig(TypedDict):
    taxi_radius: float
    taxi_length: float
    taxi_width: float
    widths: dict[str, float]
    max_speed: float
    acceleration: float
    upgraded_acceleration: float


DRIVING: DrivingConfig = {
    "taxi_radius": 2.5,
    "taxi_length": 3.7,
    "taxi_width": 1.7,
    "max_speed": 160 / 3.6,
    "acceleration": 7,
    "upgraded_acceleration": 9.1,
    "widths": {"primary": 16, "secondary": 14, "tertiary": 12, "unclassified": 10,
               "residential": 10, "living_street": 8, "service": 8,
               "primary_link": 10, "secondary_link": 10, "tertiary_link": 10},
}


@dataclass(frozen=True, slots=True)
class Edge:
    id: str
    a: str
    b: str
    way: int
    length: float
    name: str
    zh: str
    kind: str
    oneway: bool
    layer: str
    bridge: str
    tunnel: str
    wrongway: bool = False
    width: float | None = None
    width_source: str | None = None


@dataclass(frozen=True, slots=True)
class Match:
    edge: Edge
    point: Point
    distance: float
    fraction: float
    wrong_way: bool


def project(point: Point, a: Point, b: Point) -> tuple[Point, float, float]:
    dx, dy = b[0] - a[0], b[1] - a[1]
    t = max(0.0, min(1.0, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy)))
    nearest = (a[0] + t * dx, a[1] + t * dy)
    return nearest, math.dist(point, nearest), t


class RoadMap:
    def __init__(self, path: Path):
        self.document = json.loads(path.read_text(encoding="utf-8"))
        self.version: str = self.document["version"]
        width_path = path.with_name("road-widths.json")
        width_version = ""
        if width_path.exists():
            width_bytes = width_path.read_bytes()
            widths = json.loads(width_bytes)
            width_version = "-road-scale-1-" + hashlib.sha256(width_bytes).hexdigest()[:12]
            if widths["map_version"] != self.version:
                raise ValueError("Road-width package is stale; rebuild tools/prepare_road_widths.py")
            for edge in self.document["edges"]:
                key = ":".join(map(str, (edge["way"], *sorted((edge["a"], edge["b"])))))
                value = widths["values"][key]
                width = value["width"]
                if not isinstance(width, (int, float)) or not math.isfinite(width) or width <= 0:
                    raise ValueError(f"Invalid road width for {edge['id']}")
                edge["width"] = width
                edge["width_source"] = value["source"] + ("-spacing-constrained" if value["spacing_constrained"] else "")
            self.document["road_width_audit"] = widths["audit"]
            if widths["conflicts"]:
                warnings.warn(f"{len(widths['conflicts'])} unresolved road-width pairs; see {width_path}", stacklevel=2)
        elif path.name == "district.json":
            raise ValueError("Missing road-width package; run tools/prepare_road_widths.py")
        elevation_path = path.with_name("elevation.json")
        self.elevation = json.loads(elevation_path.read_text()) if elevation_path.exists() else None
        if self.elevation and self.elevation["map_version"] != self.version:
            raise ValueError("Elevation package is stale; rebuild tools/prepare_elevation.py")
        self.document["elevation"] = self.elevation
        if self.elevation:
            self.document["license_scope"] = "ODbL covers OSM-derived components; Government elevation/model terms also apply"
        self.bounds: list[float] = self.document["bounds"]
        self.nodes: dict[str, Point] = {k: tuple(v) for k, v in self.document["nodes"].items()}
        self.edges = {e["id"]: Edge(**e) for e in self.document["edges"]}
        existing = {(e.way, e.a, e.b) for e in self.edges.values()}
        for edge in list(self.edges.values()):
            if (edge.way, edge.b, edge.a) not in existing:
                reverse = replace(edge, id=f"~{edge.id}", a=edge.b, b=edge.a, wrongway=True)
                self.edges[reverse.id] = reverse
        self.document["edges"] = [asdict(e) for e in self.edges.values()]
        if self.elevation:
            self.elevation["road_profiles"] = road_profiles(self.nodes, self.elevation["node_heights"], list(self.edges.values()))
        self.document["driving"] = DRIVING
        self.version += "-manual-3" + ("-elevation-curves-1" if self.elevation else "") + width_version
        self.document["version"] = self.version
        self.outgoing: dict[str, list[Edge]] = {}
        self.neighbors: dict[str, set[str]] = {}
        self.restrictions = self.document["restrictions"]
        self.history_size = max((len(r.get("via_ways", [])) + 1 for r in self.restrictions), default=1)
        self.node_rules: dict[str, list[dict]] = {}
        self.way_rules: dict[int, list[dict]] = {}
        for rule in self.restrictions:
            if rule["via"]:
                self.node_rules.setdefault(rule["via"], []).append(rule)
            else:
                for way in (rule["from"], *rule["via_ways"]):
                    self.way_rules.setdefault(way, []).append(rule)
        for edge in self.edges.values():
            self.outgoing.setdefault(edge.a, []).append(edge)
            self.neighbors.setdefault(edge.a, set()).add(edge.b)
            self.neighbors.setdefault(edge.b, set()).add(edge.a)
        self.branch_levels = {edge.id: self.branch_level(edge) for edge in self.edges.values()}
        self.document["branch_levels"] = {key: list(level) for key, level in self.branch_levels.items()}
        self.document["stacked_junctions"] = sorted({
            edge.b for edge in self.edges.values() if self.stacked_choice(edge, set())
        })

    def surface(self, edge: Edge, point: Point, heading: float) -> dict:
        return surface_pose(self.nodes, self.elevation["node_heights"] if self.elevation else None,
                            edge, point, heading, self.elevation.get("road_profiles") if self.elevation else None)

    def speed_limit(self, edge: Edge, point: Point, heading: float) -> float:
        return slope_speed_limit(DRIVING["max_speed"], self.surface(edge, point, heading)["grade"])

    def radius(self, edge: Edge) -> float:
        return (edge.width if edge.width is not None else DRIVING["widths"].get(edge.kind, 10)) / 2

    def body_fits(
        self, point: Point, heading: float, previous: Edge, padding: float = 0, allowance: float = 0,
    ) -> bool:
        half_length, half_width = DRIVING["taxi_length"] / 2 + padding, DRIVING["taxi_width"] / 2 + padding
        cosine, sine = math.cos(heading), math.sin(heading)
        edges = self.corridor_edges(point, previous)
        left, top, right, bottom = self.bounds

        def world(x: float, y: float) -> Point:
            return (point[0] + x * cosine - y * sine, point[1] + x * sine + y * cosine)

        def inside(p: Point, edge: Edge) -> bool:
            return project(p, self.nodes[edge.a], self.nodes[edge.b])[1] <= self.radius(edge) + allowance + 1e-6

        def covered(x0: float, y0: float, x1: float, y1: float, depth: int) -> bool:
            corners = [world(x0, y0), world(x1, y0), world(x1, y1), world(x0, y1)]
            if any(not (left - allowance <= p[0] <= right + allowance
                        and top - allowance <= p[1] <= bottom + allowance) for p in corners):
                return False
            # Convex road capsules cover the whole cell when they cover its corners.
            if any(all(inside(p, edge) for p in corners) for edge in edges):
                return True
            if depth == 0 or any(not any(inside(p, edge) for edge in edges) for p in corners):
                return False
            x, y = (x0 + x1) / 2, (y0 + y1) / 2
            return (covered(x0, y0, x, y, depth - 1) and covered(x, y0, x1, y, depth - 1)
                    and covered(x0, y, x, y1, depth - 1) and covered(x, y, x1, y1, depth - 1))

        return covered(-half_length, -half_width, half_length, half_width, 6)

    def penetration(self, point: Point, heading: float, previous: Edge) -> float:
        if self.body_fits(point, heading, previous):
            return 0
        low, high = 0.0, math.hypot(DRIVING["taxi_length"], DRIVING["taxi_width"])
        for _ in range(32):
            middle = (low + high) / 2
            if self.body_fits(point, heading, previous, allowance=middle):
                high = middle
            else:
                low = middle
        return high

    def rotation_fits(self, point: Point, start: float, end: float, previous: Edge) -> bool:
        angle = math.atan2(math.sin(end - start), math.cos(end - start))
        steps = max(1, math.ceil(abs(angle) / 0.02))
        if angle == 0:
            return self.body_fits(point, start, previous)
        # Bound the entire angular sweep between samples by padded rectangles.
        padding = math.hypot(DRIVING["taxi_length"], DRIVING["taxi_width"]) * abs(angle) / (4 * steps)
        return all(self.body_fits(point, start + angle * (i - 0.5) / steps, previous, padding)
                   for i in range(1, steps + 1))

    def corridor_edges(
        self, point: Point, previous: Edge,
        selected_exit: str | None = None, selected_junction: str | None = None,
    ) -> list[Edge]:
        """Join nearby shared nodes or overlapping same-level connected surfaces."""
        found = {previous.id: previous}
        stack = [previous]
        while stack:
            edge = stack.pop()
            reach = math.hypot(DRIVING["taxi_length"], DRIVING["taxi_width"]) / 2
            on_surface = project(point, self.nodes[edge.a], self.nodes[edge.b])[1] <= self.radius(edge) + reach
            for node in (edge.a, edge.b):
                near_node = math.dist(point, self.nodes[node]) <= self.radius(edge) + reach
                for nxt in self.outgoing.get(node, []):
                    if node == selected_junction and nxt.id != selected_exit:
                        continue
                    if not near_node and not (
                        on_surface
                        and (edge.layer, edge.bridge, edge.tunnel) == (nxt.layer, nxt.bridge, nxt.tunnel)
                        and project(point, self.nodes[nxt.a], self.nodes[nxt.b])[1] <= self.radius(nxt) + reach
                    ):
                        continue
                    if nxt.id not in found:
                        found[nxt.id] = nxt
                        stack.append(nxt)
        # Opposite directions share one physical segment even far from its endpoints.
        for edge in self.outgoing.get(previous.b, []):
            if edge.a == selected_junction and edge.id != selected_exit:
                continue
            if edge.b == previous.a and edge.way == previous.way:
                found[edge.id] = edge
        return list(found.values())

    def corridor_match(
        self, point: Point, heading: float, previous: Edge,
        selected_exit: str | None = None, selected_junction: str | None = None,
        *, check_body: bool = True, allowance: float = 0, closed: set[int] | None = None,
    ) -> Match | None:
        if check_body and not self.body_fits(point, heading, previous, allowance=allowance):
            return None
        matches = []
        for edge in self.corridor_edges(point, previous, selected_exit, selected_junction):
            if closed and edge.way in closed:
                continue
            if selected_junction is not None and edge.a == selected_junction and edge.id != selected_exit:
                continue
            nearest, distance, fraction = project(point, self.nodes[edge.a], self.nodes[edge.b])
            if (self.elevation and edge.id != previous.id
                    and abs(self.surface(edge, point, heading)["height"]
                            - self.surface(previous, point, heading)["height"]) > .35):
                continue
            if distance <= self.radius(edge) + 1e-6:
                score = distance + (1 - math.cos(heading - self.angle(edge))) * 0.15
                match = Match(edge, nearest, distance, fraction, edge.wrongway)
                if (edge.id == previous.id and edge.b == selected_junction and fraction < 1
                        and math.cos(heading - self.angle(edge)) > 0.35):
                    return match
                matches.append((score, edge.id, match))
        return min(matches, key=lambda m: (m[0], m[1]))[2] if matches else None

    def branches(self, incoming: Edge, closed: set[int]) -> list[Edge]:
        return [e for e in self.outgoing.get(incoming.b, [])
                if e.b != incoming.a and e.way not in closed]

    def branch_level(self, edge: Edge) -> tuple[str, str, str]:
        distance, seen = 0.0, {edge.a}
        signature = (edge.layer, edge.bridge, edge.tunnel)
        while distance < 100:
            distance += edge.length
            if (edge.layer, edge.bridge, edge.tunnel) != ("0", "no", "no"):
                return (edge.layer, edge.bridge, edge.tunnel)
            seen.add(edge.a)
            choices = [e for e in self.outgoing.get(edge.b, []) if e.b not in seen]
            if len(choices) != 1:
                break
            edge = choices[0]
        return signature

    def stacked_choice(self, incoming: Edge, closed: set[int]) -> bool:
        options = self.branches(incoming, closed)
        return len(options) >= 2 and len({self.branch_levels[e.id] for e in options}) > 1

    def junction_choice(self, incoming: Edge, closed: set[int]) -> bool:
        return len(self.branches(incoming, closed)) > 2 or self.stacked_choice(incoming, closed)

    def angle(self, edge: Edge) -> float:
        a, b = self.nodes[edge.a], self.nodes[edge.b]
        return math.atan2(b[1] - a[1], b[0] - a[0])

    def history(self, previous: tuple[int, ...], way: int) -> tuple[int, ...]:
        if previous and previous[-1] == way:
            return previous
        return (*previous, way)[-self.history_size:]

    def legal(self, incoming: Edge, outgoing: Edge, history: tuple[int, ...]) -> bool:
        if incoming.b != outgoing.a or outgoing.wrongway:
            return False
        reverse = incoming.a == outgoing.b
        if reverse and len(self.neighbors.get(incoming.b, ())) > 1:
            return False
        for rule in self.node_rules.get(incoming.b, []):
            if incoming.way != rule["from"]:
                continue
            matches = outgoing.way == rule["to"]
            if rule["from"] == rule["to"] and rule["rule"] == "no_u_turn":
                matches = matches and reverse
            if rule["rule"].startswith("no_") and matches:
                return False
            if rule["rule"].startswith("only_") and not matches:
                return False
        for rule in self.way_rules.get(incoming.way, []):
            prefix = (rule["from"], *rule["via_ways"])
            if outgoing.way == incoming.way:
                continue
            if rule["rule"].startswith("no_"):
                if tuple(history[-len(prefix):]) == prefix and outgoing.way == rule["to"]:
                    return False
            else:
                for size in range(1, len(prefix) + 1):
                    if tuple(history[-size:]) != prefix[:size]:
                        continue
                    expected = prefix[size] if size < len(prefix) else rule["to"]
                    if size == 1 and not any(e.way == expected for e in self.outgoing.get(incoming.b, [])):
                        continue
                    if outgoing.way != expected:
                        return False
        return True

    def exits(self, incoming: Edge, history: tuple[int, ...], closed: set[int]) -> list[Edge]:
        return [
            e for e in self.outgoing.get(incoming.b, [])
            if e.way not in closed and self.legal(incoming, e, history)
        ]

    def route(self, start: Edge, target: Edge, history: tuple[int, ...], closed: set[int], traffic: dict[int, float]) -> list[str] | None:
        if target.way in closed:
            return None
        if start.wrongway:
            # A wrong-way taxi has no legal exits ahead, so plan from turning around.
            start = self.edges[start.id[1:]]
        initial = (start.id, self.history(history, start.way))
        goal = self.nodes[target.b]
        # A* guide: edge lengths are never shorter than 0.99 × straight-line distance.
        scale = 0.99 / max([1.0, *traffic.values()])

        def estimate(edge: Edge) -> float:
            return math.dist(self.nodes[edge.b], goal) * scale

        counter = itertools.count()
        queue = [(estimate(start), next(counter), initial)]
        costs = {initial: 0.0}
        parents: dict[tuple, tuple] = {}
        closed_states: set[tuple] = set()
        found = None
        while queue:
            _, _, state = heapq.heappop(queue)
            edge = self.edges[state[0]]
            cost = costs[state]
            if state in closed_states:
                continue
            closed_states.add(state)
            if edge.id == target.id:
                found = state
                break
            for nxt in self.exits(edge, state[1], closed):
                next_history = self.history(state[1], nxt.way)
                next_state = (nxt.id, next_history)
                heading = math.atan2(self.nodes[nxt.b][1] - self.nodes[nxt.a][1],
                                     self.nodes[nxt.b][0] - self.nodes[nxt.a][0])
                candidate = cost + nxt.length / traffic.get(nxt.way, 1.0) * DRIVING["max_speed"] / self.speed_limit(
                    nxt, self.nodes[nxt.a], heading)
                if candidate < costs.get(next_state, math.inf):
                    costs[next_state] = candidate
                    parents[next_state] = state
                    heapq.heappush(queue, (candidate + estimate(nxt), next(counter), next_state))
        if found is None:
            return None
        path = [found[0]]
        while found != initial:
            found = parents[found]
            path.append(found[0])
        return path[::-1]
