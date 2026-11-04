"""Road surface equations mirrored by web/elevation.mjs."""

import math


ROAD_PRIORITY = {
    "motorway": 0, "trunk": 1, "primary": 2, "secondary": 3, "tertiary": 4,
    "unclassified": 5, "residential": 6, "service": 7,
}


def road_priority(edge):
    kind = edge.kind.removesuffix("_link")
    return ROAD_PRIORITY.get(kind, 8) * 2 + int(edge.kind.endswith("_link"))


def road_profiles(nodes, heights, edges):
    neighbors = {}
    incident = {}
    for edge in edges:
        neighbors.setdefault(edge.a, set()).add(edge.b)
        neighbors.setdefault(edge.b, set()).add(edge.a)
        for node, target in ((edge.a, edge.b), (edge.b, edge.a)):
            previous = incident.setdefault(node, {}).get(target)
            if previous is None or (road_priority(edge), edge.id) < (road_priority(previous), previous.id):
                incident[node][target] = edge

    def tangent(node, target):
        adjacent = neighbors[node]
        if len(adjacent) > 2:
            priority = min(road_priority(e) for e in incident[node].values())
            main = {key for key, e in incident[node].items() if road_priority(e) == priority}
            if target in main and len(main) <= 2:
                adjacent = main
        a, b = nodes[node], nodes[target]
        length = math.dist(a, b)
        grade = (heights[target] - heights[node]) / length
        if len(adjacent) == 1:
            return grade
        if len(adjacent) != 2:
            return 0.0
        other = next(key for key in adjacent if key != target)
        c = nodes[other]
        other_length = math.dist(a, c)
        cosine = sum((b[i] - a[i]) * (c[i] - a[i]) for i in range(2)) / (length * other_length)
        previous = (heights[node] - heights[other]) / other_length
        if cosine > -0.5 or previous * grade <= 0:
            return 0.0
        w1, w2 = 2 * length + other_length, length + 2 * other_length
        return (w1 + w2) / (w1 / previous + w2 / grade)

    return {edge.id: [tangent(edge.a, edge.b), -tangent(edge.b, edge.a)] for edge in edges}


def road_junctions(nodes, edges, profiles, widths):
    incident = {}
    edges_by_direction = {}
    for edge in sorted(edges, key=lambda e: e.id):
        key = (edge.way, *sorted((edge.a, edge.b)))
        edges_by_direction.setdefault(key, []).append(edge.id)
        for node in (edge.a, edge.b):
            incident.setdefault(node, {}).setdefault(key, edge)
    result, assigned = {}, set()
    for node, adjacent in sorted(incident.items()):
        priority = min(road_priority(e) for e in adjacent.values())
        main = sorted((e for e in adjacent.values() if road_priority(e) == priority), key=lambda e: e.id)
        for owner in main:
            entry = {"node": node, "id": owner.id, "priority": priority,
                     "a": owner.a, "b": owner.b, "profile": profiles[owner.id],
                     "radius": (owner.width or widths.get(owner.kind, 10)) / 2}
            pending, visited = [node], set()
            while pending:
                current = pending.pop()
                if current in visited:
                    continue
                visited.add(current)
                for key, edge in incident[current].items():
                    # Propagate across short side-road pieces so their shared endpoints
                    # also conform to the main road. Crossings without shared nodes
                    # are never visited, so independent decks stay separated.
                    if road_priority(edge) <= priority:
                        continue
                    pair = (key, owner.id)
                    if pair not in assigned:
                        assigned.add(pair)
                        for candidate in edges_by_direction[key]:
                            result.setdefault(candidate, []).append(entry)
                    target = edge.b if edge.a == current else edge.a
                    a, b, point = nodes[owner.a], nodes[owner.b], nodes[target]
                    dx, dy = b[0] - a[0], b[1] - a[1]
                    projection = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy)
                    t = max(0, min(1, projection))
                    if math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy) < entry["radius"] + 8.2:
                        pending.append(target)
    for owners in result.values():
        # A side road inherits any higher-priority adjustment already affecting its main road.
        seen = {owner["id"] for owner in owners}
        index = 0
        while index < len(owners):
            owner = owners[index]
            index += 1
            for ancestor in result.get(owner["id"], ()):
                if ancestor["id"] not in seen:
                    seen.add(ancestor["id"])
                    owners.append(ancestor)
        owners.sort(key=lambda e: (e["a"], e["b"], e["node"]))
    return result


def _surface(nodes, heights, start, end, point, profile):
    a, b = nodes[start], nodes[end]
    dx, dy = b[0] - a[0], b[1] - a[1]
    projection = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy)
    t = max(0, min(1, projection))
    za, zb = heights[start], heights[end]
    length = math.hypot(dx, dy)
    grade = (zb - za) / length
    height = za + (zb - za) * t
    if profile:
        m0, m1 = (value * length for value in profile)
        delta = zb - za
        height = za + m0 * t + (3 * delta - 2 * m0 - m1) * t * t + (m0 + m1 - 2 * delta) * t * t * t
        grade = (m0 + 2 * (3 * delta - 2 * m0 - m1) * t + 3 * (m0 + m1 - 2 * delta) * t * t) / length
    if projection < 0 or projection > 1:
        grade = 0
    return height, grade * dx / length, grade * dy / length


def _blended_surface(nodes, heights, start, end, point, profile, junctions, edge_id):
    height, gx, gy = _surface(nodes, heights, start, end, point, profile)
    owners_by_priority = {}
    for owner in (junctions or {}).get(edge_id, ()):
        a, b = nodes[owner["a"]], nodes[owner["b"]]
        dx, dy = b[0] - a[0], b[1] - a[1]
        t = max(0, min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy)))
        offset = (point[0] - a[0] - t * dx, point[1] - a[1] - t * dy)
        distance = math.hypot(*offset)
        gap = max(0, distance - owner["radius"] - .2)
        rank = (distance - owner["radius"], owner["id"])
        closest = owners_by_priority.get(owner["priority"])
        if closest is None or rank < closest[4]:
            owners_by_priority[owner["priority"]] = gap, distance, offset, owner, rank
    for priority in sorted(owners_by_priority, reverse=True):
        closest = owners_by_priority[priority]
        if closest[0] >= 8:
            continue
        gap, distance, offset, owner, _ = closest
        h, mx, my = _surface(nodes, heights, owner["a"], owner["b"], point, owner["profile"])
        t = gap / 8
        weight = 1 - t * t * (3 - 2 * t)
        derivative = -6 * t * (1 - t) / 8
        wx, wy = ((derivative * value / distance for value in offset) if distance else (0, 0))
        gx = gx * (1 - weight) + mx * weight + (h - height) * wx
        gy = gy * (1 - weight) + my * weight + (h - height) * wy
        height += (h - height) * weight
    return height, gx, gy


def surface_pose(nodes, heights, edge, point, heading, profiles=None, junctions=None):
    if not heights:
        return {"height": 0.0, "grade": 0.0, "pitch": 0.0}
    height, gx, gy = _blended_surface(
        nodes, heights, edge.a, edge.b, point, profiles.get(edge.id) if profiles else None, junctions, edge.id)
    grade = gx * math.cos(heading) + gy * math.sin(heading)
    return {"height": height, "grade": grade, "pitch": math.atan(grade)}


def slope_speed_limit(maximum, grade):
    return maximum * (1 - 2 * min(.12, abs(grade)))
