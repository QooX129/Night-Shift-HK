"""Road surface equations mirrored by web/elevation.mjs."""

import math


def road_profiles(nodes, heights, edges):
    neighbors = {}
    for edge in edges:
        neighbors.setdefault(edge.a, set()).add(edge.b)
        neighbors.setdefault(edge.b, set()).add(edge.a)

    def tangent(node, target):
        adjacent = neighbors[node]
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


def surface_pose(nodes, heights, edge, point, heading, profiles=None):
    if not heights:
        return {"height": 0.0, "grade": 0.0, "pitch": 0.0}
    a, b = nodes[edge.a], nodes[edge.b]
    dx, dy = b[0] - a[0], b[1] - a[1]
    t = max(0, min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy)))
    za, zb = heights[edge.a], heights[edge.b]
    length = math.hypot(dx, dy)
    grade = (zb - za) / length
    height = za + (zb - za) * t
    if profiles and edge.id in profiles:
        m0, m1 = (value * length for value in profiles[edge.id])
        delta = zb - za
        height = za + m0 * t + (3 * delta - 2 * m0 - m1) * t * t + (m0 + m1 - 2 * delta) * t * t * t
        grade = (m0 + 2 * (3 * delta - 2 * m0 - m1) * t + 3 * (m0 + m1 - 2 * delta) * t * t) / length
    grade *= math.cos(heading - math.atan2(dy, dx))
    return {"height": height, "grade": grade, "pitch": math.atan(grade)}


def slope_speed_limit(maximum, grade):
    return maximum * (1 - 2 * min(.12, abs(grade)))
