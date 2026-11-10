from pathlib import Path
import json
import logging
import mimetypes
import time
from threading import RLock
from typing import Annotated, Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware
from pydantic import BaseModel, ConfigDict, Field

from game import Game, MovementBoundaryError, RuleError
from roads import DRIVING, RoadMap
from map_streaming import VisualMap

ROOT = Path(__file__).resolve().parent
mimetypes.add_type("text/javascript", ".mjs")
roads = RoadMap(ROOT / "data" / "district.json")
game = Game(roads)
game_lock = RLock()
visual_map = VisualMap(roads.document)
app = FastAPI(title="Night Shift HK", docs_url=None, redoc_url=None)
app.add_middleware(GZipMiddleware, minimum_size=1000)
logger = logging.getLogger(__name__)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Position(StrictModel):
    x: float = Field(allow_inf_nan=False)
    y: float = Field(allow_inf_nan=False)
    heading: float = Field(allow_inf_nan=False)


class Move(Position):
    action: Literal["move"]
    speed: float = Field(ge=-4, le=DRIVING["max_speed"], allow_inf_nan=False)
    dt: float = Field(ge=0, le=4, allow_inf_nan=False)
    trail: list[Position] = Field(default_factory=list, max_length=240)
    visible_citizens: list[Annotated[str, Field(min_length=1, max_length=100)]] = Field(default_factory=list, max_length=100)


class Pause(StrictModel):
    action: Literal["pause"]
    paused: bool
    preserve_speed: bool = False


class SelectRoad(StrictModel):
    action: Literal["select_road"]
    incoming: str = Field(max_length=100)
    exit: str = Field(max_length=100)


class Upgrade(StrictModel):
    action: Literal["upgrade"]
    kind: Literal["efficiency", "engine"]


class Simple(StrictModel):
    action: Literal["service", "next", "recover", "refuel"]


class Accept(StrictModel):
    action: Literal["accept"]
    order: str | None = Field(default=None, max_length=100)


class Door(StrictModel):
    action: Literal["door"]
    citizen: str = Field(min_length=1, max_length=100)


class Command(StrictModel):
    seq: int = Field(ge=1)
    command: Annotated[Move | Pause | SelectRoad | Upgrade | Accept | Door | Simple, Field(discriminator="action")]


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "dataset": roads.version}


def cached_map_response(request: Request, content: bytes, tag: str, immutable: bool = False) -> Response:
    headers = {"ETag": f'W/"{tag}"', "Vary": "Accept-Encoding",
               "Cache-Control": "public, max-age=31536000, immutable" if immutable else "no-cache"}
    if request.headers.get("if-none-match") == headers["ETag"]:
        return Response(status_code=304, headers=headers)
    return Response(content, media_type="application/json", headers=headers)


@app.get("/api/map")
def map_data(request: Request, stream: bool = False):
    if stream:
        return cached_map_response(request, visual_map.core, visual_map.version)
    return roads.document


@app.get("/api/map/chunks/{version}/{x}/{y}")
def map_chunk(request: Request, version: str, x: int, y: int) -> Response:
    if version != visual_map.version:
        raise HTTPException(status_code=409, detail="Map dataset changed. Refresh to load the new map.")
    key = f"{x}:{y}"
    if key not in visual_map.chunks:
        raise HTTPException(status_code=404, detail="Unknown visual map chunk.")
    return cached_map_response(request, visual_map.chunks[key], f"{version}:{key}", immutable=True)


@app.get("/api/source")
def map_source() -> FileResponse:
    return FileResponse(ROOT / "data" / "source.osm.json", media_type="application/json", filename="source.osm.json")


@app.get("/api/stops")
def stops() -> list[dict]:
    return [
        {"id": s.id, "name": s.name, "zh": s.zh, "edge": s.edge, "point": s.point}
        for s in game.stops.values()
    ]


@app.get("/api/elevation")
def elevation_source() -> FileResponse:
    return FileResponse(ROOT / "data/elevation.json", media_type="application/json", filename="elevation.json")


@app.post("/api/sessions")
def create_session() -> dict:
    try:
        with game_lock:
            return game.create()
    except RuleError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.post("/api/sessions/{session_id}/commands", response_model=None)
def command(session_id: str, body: Command) -> dict | JSONResponse:
    try:
        payload = body.command.model_dump()
        action = payload.pop("action")
        with game_lock:
            try:
                return game.command(session_id, body.seq, action, payload)
            except MovementBoundaryError as error:
                session = game.sessions[session_id]
                session.speed = 0
                diagnostic = {
                    "code": "movement_boundary", "reason": str(error), "seq": body.seq,
                    "version": roads.version,
                    "confirmed": {"x": session.point[0], "y": session.point[1],
                                  "heading": session.heading, "edge": session.edge},
                    "selected_exit": session.selected_exit, "selected_junction": session.selected_junction,
                    "rejected_sample": error.sample,
                    "movement": {key: payload[key] for key in ("x", "y", "heading", "speed", "dt")},
                    "trail": payload["trail"],
                }
                now = time.monotonic()
                if now - session.last_boundary_log >= 5:
                    logger.warning("Movement rejected: %s", json.dumps({
                        **diagnostic, "suppressed_since_last_log": session.boundary_logs_suppressed,
                    }))
                    session.last_boundary_log = now
                    session.boundary_logs_suppressed = 0
                else:
                    session.boundary_logs_suppressed += 1
                return JSONResponse(status_code=409, content={
                    "detail": str(error), "code": "movement_boundary",
                    "state": game.snapshot(session), "diagnostic": diagnostic,
                })
    except RuleError as error:
        status = 404 if session_id not in game.sessions else 409
        raise HTTPException(status_code=status, detail=str(error)) from error


app.mount("/", StaticFiles(directory=ROOT / "web", html=True), name="web")
