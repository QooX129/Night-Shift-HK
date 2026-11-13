"""Conservative roadside walking paths clipped against roads, flyovers and buildings."""

import math
from collections import defaultdict

from roads import DRIVING, project


def path_pose(points, distance):
    remaining = distance
    for a, b in zip(points, points[1:]):
        length = math.dist(a, b)
        if remaining <= length:
            t = max(0, remaining / length)
            return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
        remaining -= length
    return points[-1]


def advance_walk(distance, direction, travel, length):
    phase = (distance if direction > 0 else 2 * length - distance) + travel
    phase %= 2 * length
    return (phase, 1) if phase < length else (2 * length - phase, -1)


def intersects(a, b, c, d):
    def cross(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    return (
        max(min(a[0], b[0]), min(c[0], d[0])) <= min(max(a[0], b[0]), max(c[0], d[0]))
        and max(min(a[1], b[1]), min(c[1], d[1])) <= min(max(a[1], b[1]), max(c[1], d[1]))
        and cross(a, b, c) * cross(a, b, d) <= 0
        and cross(c, d, a) * cross(c, d, b) <= 0
    )


def segment_distance(a, b, c, d):
    if a == b:
        return math.dist(a, c) if c == d else project(a, c, d)[1]
    if c == d:
        return project(c, a, b)[1]
    if intersects(a, b, c, d):
        return 0
    return min(project(a, c, d)[1], project(b, c, d)[1], project(c, a, b)[1], project(d, a, b)[1])


def inside(point, polygon):
    x, y = point
    result = False
    for a, b in zip(polygon, polygon[1:] + polygon[:1]):
        if (a[1] > y) != (b[1] > y) and x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]:
            result = not result
    return result


class Sidewalks:
    def __init__(self, roads):
        self.roads = roads
        self.cells = defaultdict(list)
        self.cache = {}
        self.nearby_point = None
        self.nearby_paths = []
        self.edges = []
        seen = set()
        for edge in roads.edges.values():
            key = (edge.way, *sorted((edge.a, edge.b)))
            if key in seen or edge.tunnel != "no":
                continue
            seen.add(key)
            ground = edge.layer == "0" and edge.bridge == "no"
            flyover = edge.bridge != "no" or (edge.layer != "0" and not edge.layer.startswith("-"))
            if not ground and not flyover:
                continue
            a, b = roads.nodes[edge.a], roads.nodes[edge.b]
            radius = (edge.width or DRIVING["widths"].get(edge.kind, 10)) / 2
            self.add(("road", (a, b), radius), (a, b), radius + 1)
            if (ground and edge.length >= 30 and edge.kind not in {"service", "motorway", "trunk"}
                    and not edge.kind.endswith("_link")):
                self.edges.append(edge)
        for shape in roads.document["backdrop"]:
            if shape["kind"] == "building":
                points = [tuple(point) for point in shape["points"]]
                self.add(("building", points, .4), points, .4)
        # Build static geometry before movement requests can enter a new area.
        for edge in self.edges:
            self.paths(edge)

    def keys(self, points, margin=0):
        for x in range(math.floor((min(p[0] for p in points) - margin) / 40),
                       math.floor((max(p[0] for p in points) + margin) / 40) + 1):
            for y in range(math.floor((min(p[1] for p in points) - margin) / 40),
                           math.floor((max(p[1] for p in points) + margin) / 40) + 1):
                yield x, y

    def add(self, obstacle, points, margin):
        for key in self.keys(points, margin):
            self.cells[key].append(obstacle)

    def safe(self, a, b):
        left, top, right, bottom = self.roads.bounds
        if any(not (left <= p[0] <= right and top <= p[1] <= bottom) for p in (a, b)):
            return False
        seen = set()
        for key in self.keys((a, b), .4):
            for obstacle in self.cells.get(key, ()):
                if id(obstacle) in seen:
                    continue
                seen.add(id(obstacle))
                kind, points, radius = obstacle
                if kind == "road":
                    if segment_distance(a, b, *points) < radius + .35:
                        return False
                elif inside(a, points) or inside(b, points) or any(
                    segment_distance(a, b, c, d) < radius
                    for c, d in zip(points, points[1:] + points[:1])
                    if c != d
                ):
                    return False
        return True

    def paths(self, edge):
        if edge.id in self.cache:
            return self.cache[edge.id]
        a, b = self.roads.nodes[edge.a], self.roads.nodes[edge.b]
        length = math.dist(a, b)
        nx, ny = -(b[1] - a[1]) / length, (b[0] - a[0]) / length
        offset = (edge.width or DRIVING["widths"].get(edge.kind, 10)) / 2 + 2
        paths = []
        for side in (-1, 1):
            points = []
            count = max(1, math.ceil(length / 2))
            for i in range(count + 1):
                t = i / count
                point = (a[0] + (b[0] - a[0]) * t + nx * offset * side,
                         a[1] + (b[1] - a[1]) * t + ny * offset * side)
                if not self.safe(point, point) or (points and not self.safe(points[-1], point)):
                    if len(points) > 1 and math.dist(points[0], points[-1]) >= 4:
                        paths.append((side, (points[0], points[-1])))
                    points = []
                if self.safe(point, point):
                    points.append(point)
            if len(points) > 1 and math.dist(points[0], points[-1]) >= 4:
                paths.append((side, (points[0], points[-1])))
        self.cache[edge.id] = paths
        return paths

    def nearby(self, point, radius):
        key = (point, radius)
        if key == self.nearby_point:
            return self.nearby_paths
        paths = []
        for edge in self.edges:
            a, b = self.roads.nodes[edge.a], self.roads.nodes[edge.b]
            if project(point, a, b)[1] > radius + 20:
                continue
            for side, points in self.paths(edge):
                distance = project(point, *points)[1]
                if distance > radius:
                    continue
                length = math.dist(*points)
                # Endpoint projections need the true line projection for circle clipping.
                dx, dy = points[1][0] - points[0][0], points[1][1] - points[0][1]
                centre = ((point[0] - points[0][0]) * dx + (point[1] - points[0][1]) * dy) / length
                perpendicular = abs((point[0] - points[0][0]) * dy - (point[1] - points[0][1]) * dx) / length
                span = math.sqrt(max(0, radius ** 2 - perpendicular ** 2))
                low, high = max(0, centre - span), min(length, centre + span)
                if low < high:
                    paths.append((edge, side, points, low, high))
        self.nearby_point, self.nearby_paths = key, paths
        return paths
