"""Metric road geometry, turn restrictions, and routing for the district."""

from dataclasses import dataclass
import heapq
import itertools
import json
import math
from pathlib import Path


Point = tuple[float, float]


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
        self.outgoing: dict[str, list[Edge]] = {}
        self.neighbors: dict[str, set[str]] = {}
        self.grid: dict[tuple[int, int], list[Edge]] = {}
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
            a, b = self.nodes[edge.a], self.nodes[edge.b]
            for x in range(math.floor(min(a[0], b[0]) / 60), math.floor(max(a[0], b[0]) / 60) + 1):
                for y in range(math.floor(min(a[1], b[1]) / 60), math.floor(max(a[1], b[1]) / 60) + 1):
                    self.grid.setdefault((x, y), []).append(edge)

    def angle(self, edge: Edge) -> float:
        a, b = self.nodes[edge.a], self.nodes[edge.b]
        return math.atan2(b[1] - a[1], b[0] - a[0])

    def history(self, previous: tuple[int, ...], way: int) -> tuple[int, ...]:
        if previous and previous[-1] == way:
            return previous
        return (*previous, way)[-self.history_size:]

    def legal(self, incoming: Edge, outgoing: Edge, history: tuple[int, ...]) -> bool:
        if incoming.b != outgoing.a:
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

    def match(self, point: Point, heading: float, previous: Edge | None = None) -> Match | None:
        gx, gy = math.floor(point[0] / 60), math.floor(point[1] / 60)
        candidates = {}
        for x in range(gx - 1, gx + 2):
            for y in range(gy - 1, gy + 2):
                for edge in self.grid.get((x, y), []):
                    candidates[edge.id] = edge
        best = None
        best_score = math.inf
        for edge in candidates.values():
            nearest, distance, fraction = project(point, self.nodes[edge.a], self.nodes[edge.b])
            alignment = math.cos(heading - self.angle(edge))
            score = distance + (1 - alignment) * 5
            if previous:
                connected = edge.id == previous.id or edge.a in (previous.a, previous.b) or edge.b in (previous.a, previous.b)
                if not connected:
                    score += 14
                if (edge.layer, edge.bridge, edge.tunnel) != (previous.layer, previous.bridge, previous.tunnel) and not connected:
                    score += 35
            if score < best_score:
                best_score = score
                best = Match(edge, nearest, distance, fraction, alignment < -0.35)
        return best if best and best.distance <= 32 else None

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
