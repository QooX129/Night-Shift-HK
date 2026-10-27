# Night Shift HK

A Python-powered, browser-based taxi game on real OpenStreetMap roads around
Mong Kok and Yau Ma Tei. Drive freely, choose exits at junctions, and take fictional
passengers through Kowloon.

## Run locally

Requires Python 3.11 or newer. Runtime validation was performed with Python 3.14.
Run the commands from the project directory. Create a virtual environment, install
the Python dependencies, and start the web server using the instructions for your
operating system.

### macOS and Linux

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

### Windows (PowerShell)

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8000
```

Open <http://127.0.0.1:8000>. The packaged map works without Google keys, map tiles,
live geocoding, external fonts, or third-party requests from the game page.
An internet connection is only needed to install dependencies, refresh the
source map, or access a remotely hosted game.
To stop the server, press **Ctrl+C** in the terminal.

## Play

- **W / Up:** accelerate. **S / Down:** brake; keep holding after stopping to
  reverse at up to 4 m/s. Release the pedal to slow down. **A/D / Left/Right:** steer.
- **Space:** handbrake; it slows the taxi without engaging reverse. **Esc:** open
  the pause menu. Changing browser tabs also pauses the game.
- Phones show separate touch steering, brake, and accelerator controls.
- Accept an order, stop at the **green** pickup marker, and click **Pick up passenger**.
  Stop at the **yellow** destination marker to complete the trip and receive earnings.
- The route is a suggestion; you may choose another legal route.
  The yellow passenger-destination guide renders above forward, exit, and cyan
  selected-road highlights so it remains visible where they overlap.
- Steering remains under your control. Ordinary junctions highlight the connected exits
  without opening a popup; the GPS-recommended exit is brighter. Junctions with
  more than two available exits and connected stacked-road forks pause to offer
  a route choice before the junction in a compact, scrollable bottom-right GPS
  panel, without dimming or blurring the map. The GPS-recommended exit is identified in
  the list. Hover over an option or focus it with the keyboard to preview its
  road in cyan without selecting it. Selection queues the exit and resumes the
  approach without moving or rotating the taxi. Only when the taxi reaches the
  junction does it snap to face along the chosen road, preserving its speed.
  There is no steering assist or temporary sensitivity boost; manual steering
  remains unchanged before and after the snap. Highlight the
  whole road ahead from the taxi to the next junction, then each available exit
  to its following junction or dead end, including short segments and bends.
  This remains visible when stopped facing forward; closed roads and disconnected
  crossings are excluded. The selected-road highlight clears on entry.
- An unconnected flyover crossing never opens a selector or changes the current
  road level. Reach other levels through actual connecting roads/ramps.
- Steering sensitivity is configured by `STEERING_SENSITIVITY` in
  `web/physics.mjs`; increase it for faster turning and decrease it for slower,
  gentler normal steering.
- The full simulated taxi footprint stays inside approximate road corridors.
  Light-red outlines mark both the road edges and the inner taxi-centre collider
  limits at 80% opacity, using 1.6 m strokes without tinting the road interior.
  Contact with a road edge removes outward movement and allows sliding along
  the edge. Reverse if facing a dead end or a boundary.
- Wrong-way entry and restricted turns remain possible with warnings. GPS routes
  still respect the directed road graph and supported turn restrictions.
  Small arrows show legal traffic directions, not the taxi's chosen direction.
  One-way roads point one way; two-way roads have opposing arrows on the left
  side of each travel direction. Segments shorter than 16 m omit arrows to limit
  clutter. Arrows reflect the packaged graph, not live road signage.
- Orange roads have simulated congestion; red roads are closed. A new simulated
  closure is selected approximately every 100 seconds of active game time.
- The **blue** marker is the taxi rest stop. Stop there to refuel or buy upgrades.
  Fuel efficiency costs $100; the engine tune costs $160. Upgrades last one shift.
  The engine tune improves forward acceleration by 30%, not top speed.
- Standard and tuned engines share a **150 km/h** top-speed cap; congestion can
  lower it. This is the agreed Crown Comfort-inspired arcade approximation,
  **not a verified Toyota specification or a legal road speed limit**.
- If stuck or out of fuel, pause and use **Return to rest stop**. Recovery costs up
  to $20, adds emergency fuel, and does not complete the passenger trip.
- **繁中 / EN:** switch language. **+ / −:** zoom. **⌖:** district overview.

There is **no saving**. Reloading starts a new shift. A server restart also clears
sessions. Money and fares are arcade game values, not Hong Kong taxi tariffs.

## What is included

- Locally packaged, attributed district roads, buildings, parks, and bilingual road names.
- Directed road routing with node and ordered via-way turn restrictions.
- Keyboard/touch manual driving, low-speed reverse, road boundaries, warnings,
  pause/resume, and advisory stacked-road choices.
- Passenger orders, pickup/drop-off validation, earnings, and bilingual personalities.
- Seeded congestion, changing simulated closures, fuel, refuelling, and two upgrades.
- Explicit network failure/retry and idempotent commands.

The renderer uses **one Canvas layer** rather than Leaflet plus a separate driving
overlay. For this small, fixed-north-up district that removes a runtime dependency
and avoids external tile hosting. Likewise, the offline importer uses Python's
standard library instead of the larger OSMnx/geospatial dependency stack; the
packaged graph is small enough for direct geometry and heap-based routing.

## Tests

The Python tests need Python 3.11 or newer. The JavaScript and browser tests also
need Node.js and npm. Activate the project virtual environment first:

macOS/Linux:

```sh
source .venv/bin/activate
```

Windows (PowerShell):

```powershell
.\.venv\Scripts\Activate.ps1
```

Then, on any platform, run:

```powershell
python -m pip install -r requirements-dev.txt
python -m unittest discover -s tests -p "test_*.py" -v
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

- 25 Python rule/API tests pass, including a complete real-graph passenger trip,
  replay-safe rewards, road containment, advisory choices, warning-only turns,
  and acceptance at/rejection above the shared 150 km/h cap.
- 15 JavaScript physics tests pass, including boundary sliding, reverse, extended
  footprint containment, disconnected flyovers, full forward/exit paths across short
  segments, exact speed caps, acceleration upgrades, and high-speed corridor travel.
- 24 Chromium browser tests pass across desktop and phone-emulated viewports,
  including manual junctions, cyan selection rendering/clearing, reverse,
  full forward highlighting before the popup, thicker 80%-opacity outlines,
  legal traffic arrows, destination-guide rendering priority,
  bilingual UI, touch pedals, purchases, connection retry, and slow acknowledgements.
- Active free-steering animation measured approximately 60 FPS in both reference
  Chromium viewports. Performance tests disable trace recording to avoid measuring
  the recorder instead of the game.
- The packaged source graph contains 5,194 nodes, 6,682 directed edges, and 291
  parsed turn restrictions. The served map additionally includes explicitly
  marked wrong-way reverse edges for manual driving; these are not legal GPS exits.
  No unhandled restriction relations were found in this extract.

### Road-boundary model

Road widths are game estimates shared by rendering, browser physics, and server
validation: primary 16 m, secondary 14 m, tertiary 12 m, local/link roads 10 m,
and service/living streets 8 m. These are not surveyed road or lane widths.

A conservative 2.5 m-radius circle encloses the simulated taxi body. Its centre
stays within a road capsule narrowed by that radius, keeping the complete
footprint inside the rendered road. The map outlines both the approximate road
edges and the collider limits inset by the taxi radius, so the visible limits
match the movement constraint. The readable screen-sized icon is separate and
can extend beyond the road edge at some zoom levels.

Movement checkpoints carry the intervening positions. The backend checks the
connected road corridor along those paths, rejecting off-road movement and
unconnected level changes rather than silently snapping the taxi.
Browser collision handling also validates intermediate positions at the same
0.4 m sampling interval, preventing boundary slides from cutting across concave
road corners and triggering a rejected movement/forced pause.
During forced turns, browser and server matching both exclude unselected exits.
Heading alignment is revalidated before sending movement, so wall contact still
stops or slides the taxi rather than producing an inconsistent movement trail.
Stacked-fork detection follows each outgoing branch for up to 100 m or the next
fork, using available layer/bridge/tunnel tags. Incomplete tags can miss a choice.

Public hosting is intentionally deferred. A physical phone, Safari, and the Docker
image have not been tested; the Dockerfile is provided as a deployment option, not
as a verified hosted release.

## Refreshing the district map

The checked-in `data` directory contains the bounded source extract and derived
database. No player triggers downloads from OpenStreetMap.

```sh
python tools/prepare_map.py --download
```

To rebuild from the existing source without downloading:

```sh
python tools/prepare_map.py
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

```sh
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

- Road capsules derived from centre lines are not a surveyed lane/kerb mesh.
  Buildings, other cars, pedestrians, and physical traffic lights are not simulated.
- Closely spaced OSM nodes can remain separate junctions; highlights and
  stacked-fork detection are game approximations. No real navigation accuracy is claimed.
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
- `tools/prepare_map.py`: bounded OSM importer and reproducible database builder.
- `tests`: Python rules/API checks, JavaScript physics checks, and browser flows.
