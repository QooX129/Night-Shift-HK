"""Road surface equations mirrored by web/elevation.mjs."""

import math


def surface_pose(nodes, heights, edge, point, heading):
    if not heights:
        return {"height": 0.0, "grade": 0.0, "pitch": 0.0}
    a, b = nodes[edge.a], nodes[edge.b]
    dx, dy = b[0] - a[0], b[1] - a[1]
    t = max(0, min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy)))
    za, zb = heights[edge.a], heights[edge.b]
    grade = (zb - za) / math.hypot(dx, dy) * math.cos(heading - math.atan2(dy, dx))
    return {"height": za + (zb - za) * t, "grade": grade, "pitch": math.atan(grade)}


def slope_speed_limit(maximum, grade):
    return maximum * (1 - 2 * min(.12, abs(grade)))
