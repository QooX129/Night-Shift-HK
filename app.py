from pathlib import Path
import mimetypes
from threading import RLock
from typing import Annotated, Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

from game import Game, RuleError
from roads import DRIVING, RoadMap

ROOT = Path(__file__).resolve().parent
mimetypes.add_type("text/javascript", ".mjs")
roads = RoadMap(ROOT / "data" / "district.json")
game = Game(roads)
game_lock = RLock()
app = FastAPI(title="Night Shift HK", docs_url=None, redoc_url=None)


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


class Pause(StrictModel):
    action: Literal["pause"]
    paused: bool


class SelectRoad(StrictModel):
    action: Literal["select_road"]
    incoming: str = Field(max_length=100)
    exit: str = Field(max_length=100)


class Upgrade(StrictModel):
    action: Literal["upgrade"]
    kind: Literal["efficiency", "engine"]


class Simple(StrictModel):
    action: Literal["accept", "service", "next", "recover", "refuel"]


class Command(StrictModel):
    seq: int = Field(ge=1)
    command: Annotated[Move | Pause | SelectRoad | Upgrade | Simple, Field(discriminator="action")]


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "dataset": roads.version}


@app.get("/api/map")
def map_data() -> dict:
    return roads.document


@app.get("/api/source")
def map_source() -> FileResponse:
    return FileResponse(ROOT / "data" / "source.osm.json", media_type="application/json", filename="source.osm.json")


@app.get("/api/stops")
def stops() -> list[dict]:
    return [
        {"id": s.id, "name": s.name, "zh": s.zh, "edge": s.edge, "point": s.point}
        for s in game.stops.values()
    ]


@app.post("/api/sessions")
def create_session() -> dict:
    try:
        with game_lock:
            return game.create()
    except RuleError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.post("/api/sessions/{session_id}/commands")
def command(session_id: str, body: Command) -> dict:
    try:
        payload = body.command.model_dump()
        action = payload.pop("action")
        with game_lock:
            return game.command(session_id, body.seq, action, payload)
    except RuleError as error:
        status = 404 if session_id not in game.sessions else 409
        raise HTTPException(status_code=status, detail=str(error)) from error


app.mount("/", StaticFiles(directory=ROOT / "web", html=True), name="web")
