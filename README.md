# Night Shift HK

A Python-powered, browser-based taxi game on real OpenStreetMap roads around
Mong Kok and Yau Ma Tei. Drive freely, choose exits at junctions, and take fictional
passengers through Kowloon.

## Run on Windows

Requires Python 3.11 or newer. Runtime validation was performed with Python 3.14.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8000
```

Open <http://127.0.0.1:8000>. The packaged map works without Google keys, map tiles,
live geocoding, external fonts, or third-party requests from the game page.
An internet connection is only needed to install dependencies, refresh the
source map, or access a remotely hosted game.

## Play

- **W / Up:** accelerate. **S / Down:** brake. **A/D / Left/Right:** steer.
- Phones show separate touch steering, brake, and accelerator controls.
- **Space / Pause:** pause the taxi and simulation clock. Changing browser tabs
  also pauses the game.
- Accept an order, stop at the **green** pickup marker, and click **Pick up passenger**.
  Stop at the **yellow** destination marker to complete the trip and receive earnings.
- The route is a suggestion; you may choose another legal route.
- On approaching a junction, choose an exit. Turn assist follows connected road
  geometry at low speed, then returns manual steering. Brake still works during
  assistance; steering and the accelerator do not fight the assisted turn.
- Off-road and wrong-way driving give warnings rather than collisions.
- Orange roads have simulated congestion; red roads are closed. A new simulated
  closure is selected approximately every 100 seconds of active game time.
- The **blue** marker is the taxi rest stop. Stop there to refuel or buy upgrades.
  Fuel efficiency costs $100; the engine tune costs $160. Upgrades last one shift.
- If stuck or out of fuel, pause and use **Return to rest stop**. Recovery costs up
  to $20, adds emergency fuel, and does not complete the passenger trip.
- **繁中 / EN:** switch language. **+ / −:** zoom. **⌖:** district overview.

There is **no saving**. Reloading starts a new shift. A server restart also clears
sessions. Money and fares are arcade game values, not Hong Kong taxi tariffs.

## What is included

- Locally packaged, attributed district roads, buildings, parks, and bilingual road names.
- Directed road routing with node and ordered via-way turn restrictions.
- Keyboard and touch driving, warnings, pause/resume, and assisted junction turns.
- Passenger orders, pickup/drop-off validation, earnings, and bilingual personalities.
- Seeded congestion, changing simulated closures, fuel, refuelling, and two upgrades.
- Explicit network failure/retry and idempotent commands.

The renderer uses **one Canvas layer** rather than Leaflet plus a separate driving
overlay. For this small, fixed-north-up district that removes a runtime dependency
and avoids external tile hosting. Likewise, the offline importer uses Python's
standard library instead of the larger OSMnx/geospatial dependency stack; the
packaged graph is small enough for direct geometry and heap-based routing.

## Tests

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m unittest discover -s tests -p "test_*.py" -v
npm install
npm test
npx playwright install chromium
npm run test:browser
```

Playwright starts and stops its own server on port 8765. Tests use desktop and
phone-shaped Chromium viewports; emulation does **not** certify real phone or
Safari performance. Screenshots and failed-test traces are written to
`test-results` and are not part of the app.

### Verified local build

- 17 Python rule/API tests pass, including driving a complete passenger trip over
  the real graph and replay-safe trip completion.
- 4 JavaScript physics tests pass.
- 12 Chromium browser tests pass across desktop and phone-emulated viewports,
  including assisted junction turns, bilingual UI, touch pedals, purchases,
  connection failures/retry, and slow acknowledgements.
- Active free-steering animation measured approximately 60 FPS in both reference
  Chromium viewports. Performance tests disable trace recording to avoid measuring
  the recorder instead of the game.
- The packaged dataset contains 5,194 nodes, 6,682 directed edges, and 291 parsed
  turn restrictions. No unhandled restriction relations were found in this extract.

Public hosting is intentionally deferred. A physical phone, Safari, and the Docker
image have not been tested; the Dockerfile is provided as a deployment option, not
as a verified hosted release.

## Refreshing the district map

The checked-in `data` directory contains the bounded source extract and derived
database. No player triggers downloads from OpenStreetMap.

```powershell
.\.venv\Scripts\python.exe tools\prepare_map.py --download
```

To rebuild from the existing source without downloading:

```powershell
.\.venv\Scripts\python.exe tools\prepare_map.py
```

The importer retains road direction, access, grade-separation metadata, raw
geometry, and turn-restriction relations; it excludes non-drivable and private
roads, parking aisles, and disconnected components. It records unsupported
restrictions explicitly. Two conditions applying only to vehicles longer than
8 metres do not apply to this game's taxi.

Do not replace this with scraped Google Maps data. Map data and the adapted
database are under ODbL 1.0; visible attribution and download links are provided
in the game. See [map data licence](web/data-license.html).

## Publish on the web

Use one Python web service or a Docker-capable host. A static-only host cannot
run the FastAPI backend. The included Dockerfile serves the game on port 8000
or the host-provided `PORT`.

```powershell
docker build -t night-shift-hk .
docker run --rm -p 8000:8000 night-shift-hk
```

For a Python service without Docker:

1. Upload the project, including both packaged map databases but excluding
   `.venv`, `node_modules`, and test output.
2. Set the install command to `pip install -r requirements.txt`.
3. Set the start command to `python -m uvicorn app:app --host 0.0.0.0 --port 8000`,
   substituting the port required by the provider.
4. Use one worker and one instance: sessions currently live in process memory.
5. Enable HTTPS, then verify `/api/health` and complete a trip through the public URL.

Publishing requires a hosting account. No account, domain, paid service, or cloud
deployment is created automatically. Check current sleep behavior, bandwidth,
memory limits, and costs before choosing a provider. A sleeping/restarted service
loses all active shifts. The app is a small prototype, not a production-scale
multiplayer service.

## Boundaries and known limitations

- Real centre-line geometry is not a lane/collision mesh. Buildings, other cars,
  pedestrians, reverse gear, and physical traffic lights are not simulated.
- Closely spaced OSM nodes appear as separate junctions; turn assist follows
  polylines, not realistic vehicle dynamics. No real navigation accuracy is claimed.
- Road matching considers direction, prior connectivity, and level metadata,
  but free movement at ambiguous stacked roads can still require recovery.
- The graph supports ordered via-way restrictions but does not implement every
  time-dependent/local taxi rule. Service points are fictional roadside stops
  near landmarks, not verified legal taxi stands or entrances.
- No accounts, persistent saves, multiplayer, live traffic, AI dialogue, or
  competitive anti-cheat. Movement is simulated in the browser.
- Only this district is packaged. Expanding Hong Kong requires additional data,
  connectivity/turn audits, and asset partitioning.

## Project layout

- `app.py`: validated HTTP commands and same-origin web/data delivery.
- `game.py`: sessions, orders, transactions, traffic, fuel, and progression.
- `roads.py`: metric geometry, matching, directed routes, and restrictions.
- `web`: original interface, Canvas renderer, bilingual strings, and driving physics.
- `tools\prepare_map.py`: bounded OSM importer and reproducible database builder.
- `tests`: Python rules/API checks, JavaScript physics checks, and browser flows.
