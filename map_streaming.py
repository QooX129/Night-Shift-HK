"""Versioned visual chunks; the complete driving graph stays in the bootstrap."""

import hashlib
import json
import math


CHUNK_SIZE = 256


class VisualMap:
    def __init__(self, document: dict):
        encoded = json.dumps(document, separators=(",", ":"), ensure_ascii=False).encode()
        self.version = hashlib.sha256(f"visual-map-v1:{CHUNK_SIZE}:".encode() + encoded).hexdigest()[:20]
        metadata = {item["index"]: item for item in document.get("elevation", {}).get("buildings", [])}
        chunks: dict[str, list[dict]] = {}
        overview = []
        for index, shape in enumerate(document["backdrop"]):
            xs, ys = zip(*shape["points"])
            left, right, top, bottom = min(xs), max(xs), min(ys), max(ys)
            overview.append({"id": index, "kind": shape["kind"], "points": [
                [left, top], [right, top], [right, bottom], [left, bottom],
            ]})
            item = {**shape, "id": index}
            if index in metadata:
                item["building"] = metadata[index]
            for x in range(math.floor(left / CHUNK_SIZE), math.floor(right / CHUNK_SIZE) + 1):
                for y in range(math.floor(top / CHUNK_SIZE), math.floor(bottom / CHUNK_SIZE) + 1):
                    chunks.setdefault(f"{x}:{y}", []).append(item)
        core = {**document, "backdrop": [], "overview": overview}
        if document.get("elevation"):
            core["elevation"] = {**document["elevation"], "buildings": []}
        core["visualChunks"] = {
            "version": self.version, "size": CHUNK_SIZE, "keys": sorted(chunks),
        }
        self.core = json.dumps(core, separators=(",", ":"), ensure_ascii=False).encode()
        self.chunks = {
            key: json.dumps({"version": self.version, "key": key, "backdrop": items},
                            separators=(",", ":"), ensure_ascii=False).encode()
            for key, items in chunks.items()
        }
