"""Metric road geometry, turn restrictions, and routing for the district."""

from dataclasses import asdict, dataclass, replace
import heapq
import itertools
import json
import math
from pathlib import Path
from typing import TypedDict


Point = tuple[float, float]
class DrivingConfig(TypedDict):
    taxi_radius: float
    widths: dict[str, float]
    max_speed: float
    acceleration: float
    upgraded_acceleration: float


DRIVING: DrivingConfig = {
    "taxi_radius": 3,
    "max_speed": 150 / 3.6,
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
        self.bounds: list[float] = self.document["bounds"]
        self.nodes: dict[str, Point] = {k: tuple(v) for k, v in self.document["nodes"].items()}
        self.edges = {e["id"]: Edge(**e) for e in self.document["edges"]}
        existing = {(e.way, e.a, e.b) for e in self.edges.values()}
        for edge in list(self.edges.values()):
            if (edge.way, edge.b, edge.a) not in existing:
                reverse = replace(edge, id=f"~{edge.id}", a=edge.b, b=edge.a, wrongway=True)
                self.edges[reverse.id] = reverse
        self.document["edges"] = [asdict(e) for e in self.edges.values()]
        self.document["driving"] = DRIVING
        self.version += "-manual-2"
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

    def radius(self, edge: Edge) -> float:
        return DRIVING["widths"].get(edge.kind, 10) / 2 - DRIVING["taxi_radius"]

    def corridor_edges(self, point: Point, previous: Edge) -> list[Edge]:
        """Reach other segments only through nearby shared OSM nodes, never crossings."""
        found = {previous.id: previous}
        stack = [previous]
        while stack:
            edge = stack.pop()
            for node in (edge.a, edge.b):
                if math.dist(point, self.nodes[node]) > self.radius(edge) + 1:
                    continue
                for nxt in self.outgoing.get(node, []):
                    if nxt.id not in found:
                        found[nxt.id] = nxt
                        stack.append(nxt)
        # Opposite directions share one physical segment even far from its endpoints.
        for edge in self.outgoing.get(previous.b, []):
            if edge.b == previous.a and edge.way == previous.way:
                found[edge.id] = edge
        return list(found.values())

    def corridor_match(
        self, point: Point, heading: float, previous: Edge,
        selected_exit: str | None = None, selected_junction: str | None = None,
    ) -> Match | None:
        matches = []
        for edge in self.corridor_edges(point, previous):
            if selected_junction is not None and edge.a == selected_junction and edge.id != selected_exit:
                continue
            nearest, distance, fraction = project(point, self.nodes[edge.a], self.nodes[edge.b])
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
        initial = (start.id, self.history(history, start.way))
        counter = itertools.count()
        queue = [(0.0, next(counter), initial)]
        costs = {initial: 0.0}
        parents: dict[tuple, tuple] = {}
        found = None
        while queue:
            cost, _, state = heapq.heappop(queue)
            if cost != costs.get(state):
                continue
            edge = self.edges[state[0]]
            if edge.id == target.id:
                found = state
                break
            for nxt in self.exits(edge, state[1], closed):
                next_history = self.history(state[1], nxt.way)
                next_state = (nxt.id, next_history)
                candidate = cost + nxt.length / traffic.get(nxt.way, 1.0)
                if candidate < costs.get(next_state, math.inf):
                    costs[next_state] = candidate
                    parents[next_state] = state
                    heapq.heappush(queue, (candidate, next(counter), next_state))
        if found is None:
            return None
        path = [found[0]]
        while found != initial:
            found = parents[found]
            path.append(found[0])
        return path[::-1]
