"""Conservative clearance constraints for independent surface and tunnel roads."""

import heapq
import math
import warnings

from elevation import road_junctions, road_profiles


COVERED_CLEARANCE = 6.05
PORTAL_APPROACH_LENGTH = 25.0
RAMP_SLOPE = .08


def _tagged(value):
    return str(value or "") not in ("", "0", "no")


def _layer(edge):
    try:
        return int(edge.layer)
    except (TypeError, ValueError):
        return 0


def _underground(edge):
    return edge.tunnel != "building_passage" and (
        _tagged(edge.tunnel) or _layer(edge) < 0)


def _ground(edge):
    return not _tagged(edge.bridge) and not _tagged(edge.tunnel) and _layer(edge) == 0


def _interval(a, b, c, d, radius):
    """Interval of a--b inside the capsule around c--d."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    ux, uy = d[0] - c[0], d[1] - c[1]
    length = math.hypot(ux, uy)
    ux, uy = ux / length, uy / length
    x, y = (a[0] - c[0]) * ux + (a[1] - c[1]) * uy, -(a[0] - c[0]) * uy + (a[1] - c[1]) * ux
    vx, vy = dx * ux + dy * uy, -dx * uy + dy * ux
    low, high = 0.0, 1.0
    for pos, velocity, minimum, maximum in ((x, vx, 0, length), (y, vy, -radius, radius)):
        if abs(velocity) < 1e-12:
            if not minimum <= pos <= maximum:
                low, high = 1, 0
                break
        else:
            p, q = (minimum - pos) / velocity, (maximum - pos) / velocity
            low, high = max(low, min(p, q)), min(high, max(p, q))
    intervals = [(low, high)] if low <= high else []
    aa = dx * dx + dy * dy
    for point in (c, d):
        x, y = a[0] - point[0], a[1] - point[1]
        bb, cc = 2 * (x * dx + y * dy), x * x + y * y - radius * radius
        discriminant = bb * bb - 4 * aa * cc
        if discriminant >= 0:
            root = math.sqrt(discriminant)
            lo, hi = max(0, (-bb - root) / (2 * aa)), min(1, (-bb + root) / (2 * aa))
            if lo <= hi:
                intervals.append((lo, hi))
    if not intervals:
        return None
    return min(i[0] for i in intervals), max(i[1] for i in intervals)


def _portal_approaches(tunnel, ground):
    def index(edges):
        result = {}
        for edge in edges:
            for node in (edge.a, edge.b):
                result.setdefault(node, []).append(edge)
        return result

    ground_incident, tunnel_incident = index(ground), index(tunnel)

    def nearby(node, incident, way=None):
        pending, distances, found = [(0.0, node)], {}, set()
        while pending:
            distance, current = heapq.heappop(pending)
            if distance > PORTAL_APPROACH_LENGTH or distance >= distances.get(current, math.inf):
                continue
            distances[current] = distance
            for candidate in incident.get(current, ()):
                if way is not None and candidate.way != way:
                    continue
                found.add(candidate.id)
                other = candidate.b if current == candidate.a else candidate.a
                heapq.heappush(pending, (distance + candidate.length, other))
        return found

    result = {edge.id: set() for edge in tunnel}
    for node in ground_incident.keys() & tunnel_incident.keys():
        approaches = set()
        for edge in ground_incident[node]:
            approaches.update(nearby(node, ground_incident, edge.way))
        for edge_id in nearby(node, tunnel_incident):
            result[edge_id].update(approaches)
    return result


def correct_tunnel_clearance(nodes, heights, edges, widths):
    """Return adjusted heights, profiles, junctions and piecewise tunnel profiles."""
    physical = {}
    for edge in sorted(edges, key=lambda e: e.id):
        physical.setdefault((edge.way, *sorted((edge.a, edge.b))), edge)
    tunnel = [e for e in physical.values() if _underground(e)]
    ground = [e for e in physical.values() if _ground(e)]
    excluded = _portal_approaches(tunnel, ground)
    radius = lambda e: (e.width if e.width is not None else widths.get(e.kind, 10)) / 2
    constraints = {}
    for edge in tunnel:
        a, b = nodes[edge.a], nodes[edge.b]
        r = radius(edge)
        for surface in ground:
            if surface.id in excluded[edge.id]:
                continue
            c, d = nodes[surface.a], nodes[surface.b]
            reach = r + radius(surface)
            if (max(a[0], b[0]) + reach < min(c[0], d[0]) or
                max(c[0], d[0]) + reach < min(a[0], b[0]) or
                max(a[1], b[1]) + reach < min(c[1], d[1]) or
                max(c[1], d[1]) + reach < min(a[1], b[1])):
                continue
            interval = _interval(a, b, c, d, reach)
            if interval:
                constraints.setdefault(edge.id, []).append((*interval, surface))

    heights = heights.copy()
    # Junction blending is a convex combination of monotone road profiles.
    # The smallest endpoint in its owner tree bounds the whole surface below.
    portal_nodes = {n for edge in tunnel for n in (edge.a, edge.b)} & {
        n for edge in physical.values() if _ground(edge) or edge.tunnel == "building_passage"
        for n in (edge.a, edge.b)}
    tunnel_incident = {}
    for edge in tunnel:
        for node in (edge.a, edge.b):
            tunnel_incident.setdefault(node, []).append(edge)
    for iteration in range(len(nodes) + 1):
        profiles = road_profiles(nodes, heights, edges)
        junctions = road_junctions(nodes, edges, profiles, widths)

        def lower_bound(edge, seen):
            if edge.id in seen:
                raise ValueError(f"Cyclic road junction owners at {edge.id}")
            seen = seen | {edge.id}
            values = [heights[edge.a], heights[edge.b]]
            for owner in junctions.get(edge.id, ()):
                values.append(lower_bound(by_id[owner["id"]], seen))
            return min(values)

        by_id = {edge.id: edge for edge in edges}
        limits = {node: heights[node] for node in tunnel_incident}
        for edge in tunnel:
            for low, high, surface in constraints.get(edge.id, ()):
                cap = lower_bound(surface, set()) - COVERED_CLEARANCE
                length = math.dist(nodes[edge.a], nodes[edge.b])
                for node, distance in ((edge.a, low * length), (edge.b, (1 - high) * length)):
                    if node not in portal_nodes:
                        limits[node] = min(limits[node], cap + RAMP_SLOPE * distance)
        pending = [(height, node) for node, height in limits.items()]
        heapq.heapify(pending)
        while pending:
            height, node = heapq.heappop(pending)
            if height != limits[node]:
                continue
            for edge in tunnel_incident[node]:
                other = edge.b if edge.a == node else edge.a
                value = height + RAMP_SLOPE * math.dist(nodes[edge.a], nodes[edge.b])
                if other not in portal_nodes and value < limits[other]:
                    limits[other] = value
                    heapq.heappush(pending, (value, other))
        changed = any(limits[node] < heights[node] - 1e-9 for node in limits)
        heights.update(limits)
        if not changed:
            break
    else:
        raise ValueError("Tunnel clearance constraints did not converge")

    pieces = {}
    affected_nodes = set()
    for edge in tunnel:
        ranges = [(low, high, lower_bound(surface, set()) - COVERED_CLEARANCE)
                  for low, high, surface in constraints.get(edge.id, ())]
        if not ranges:
            continue
        points = sorted({0.0, 1.0, *(t for low, high, _ in ranges for t in (low, high))})
        za, zb = heights[edge.a], heights[edge.b]
        knots = []
        for t in points:
            baseline = za + (zb - za) * t
            caps = [cap for low, high, cap in ranges if low - 1e-10 <= t <= high + 1e-10]
            knots.append([t, min([baseline, *caps])])
        length = math.dist(nodes[edge.a], nodes[edge.b])
        for i in range(1, len(knots) - 1):
            t, height = knots[i]
            knots[i][1] = min(height, *(z + RAMP_SLOPE * length * abs(t - u) for u, z in knots))
        if knots[0][1] < za - 1e-8 or knots[-1][1] < zb - 1e-8:
            raise ValueError(f"Tunnel clearance conflicts with portal height: {edge.id}")
        pieces[edge.id] = knots
        affected_nodes.update((edge.a, edge.b))

    profiles = road_profiles(nodes, heights, edges)
    for edge in edges:
        if edge.a in affected_nodes:
            profiles[edge.id][0] = 0
        if edge.b in affected_nodes:
            profiles[edge.id][1] = 0
    for edge in edges:
        key = (edge.way, *sorted((edge.a, edge.b)))
        original = physical[key]
        if original.id in pieces and edge.id != original.id:
            points = pieces[original.id]
            pieces[edge.id] = points if edge.a == original.a else [[1 - t, z] for t, z in reversed(points)]
    junctions = road_junctions(nodes, edges, profiles, widths)
    unresolved = [edge.id for edge in tunnel if edge.id in pieces and junctions.get(edge.id)]
    if unresolved:
        warnings.warn(f"Tunnel clearance may be overridden by junction blending: {', '.join(unresolved)}", stacklevel=2)
    def adjusted_owner(edge, seen):
        if edge.id in seen:
            return False
        seen = seen | {edge.id}
        return edge.id in pieces or any(
            adjusted_owner(by_id[owner["id"]], seen) for owner in junctions.get(edge.id, ()))

    for ranges in constraints.values():
        for _, _, surface in ranges:
            if adjusted_owner(surface, set()):
                raise ValueError(f"Ground clearance bound depends on a corrected tunnel: {surface.id}")
    return heights, profiles, junctions, pieces
