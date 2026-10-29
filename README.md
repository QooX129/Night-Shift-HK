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
- **Space:** handbrake; it slows the taxi without engaging reverse. **Esc:** toggle
  the pause menu; closing it resumes the shift. Losing focus or changing browser tabs clears held controls
  without opening the pause menu. Use Pause or Esc to pause explicitly.
- Phones show separate touch steering, brake, and accelerator controls.
- Accept an order, stop at the **green** pickup marker, and click **Pick up passenger**.
  Stop at the **yellow** destination marker to complete the trip and receive earnings.
- The route is a suggestion; you may choose another legal route.
  Overlapping road guides render in this priority, highest first: cyan selected
  or previewed exit, green pickup route, yellow destination/recommended route,
  then normal forward/exit guidance. This applies in both 2D and 3D.
- Steering remains under your control. Ordinary junctions highlight the connected exits
  without opening a popup; the GPS-recommended exit is brighter. Junctions with
  more than two available exits and connected stacked-road forks pause to offer
  a route choice before the junction in a compact, scrollable bottom-right GPS
  panel, without dimming or blurring the map. The GPS-recommended exit is identified in
  the list. Hover over an option or focus it with the keyboard to preview its
  road in cyan without selecting it. Selection queues the exit and resumes the
  approach without moving or rotating the taxi. Only when the taxi reaches the
  junction does it snap to face along the chosen road, preserving its speed.
  Junction detection spans the full drivable width, including at the road edges
  and on short approach segments. Overlapping exit corridors cannot bypass a
  queued turn before the taxi reaches the junction.
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
- The taxi uses a rotated rectangular body collider, configured in metres by
  `taxi_length` and `taxi_width` in `roads.py`'s `DRIVING` settings. The rendered
  body uses the same dimensions, including its outline, and scales with map zoom.
  Normal movement and reverse keep the full body within connected road corridors.
  Manual steering is not cancelled by wall contact: rotation may overlap
  the boundary. An overlapping taxi can slide along the wall or drive/reverse
  back onto the road, but movement deeper into the wall remains blocked.
  Junction selection also remains available during existing boundary overlap:
  queuing an exit does not move or rotate the taxi.
  In the junction selector, hold **W / ↑** for straight, **A / ←** for left,
  **D / →** for right, or **S / ↓** for a U-turn to preview an exit; release
  all direction keys to confirm the latest preview. Single-road directions follow
  the latest key pressed. Selecting a direction with multiple exits locks into
  its sub-road group while its main key remains held.
  For a forward fan, **W+A / W / W+D** choose left / middle / right.
  Other fans rotate this mapping: **A+S / A / A+W** for left,
  **D+W / D / D+S** for right, **S+D / S / S+A** for U-turns.
  When the main direction has multiple exits, side keys select its leftmost or
  rightmost sub-road without switching groups. For example, W+A selects
  the left Waterloo branch rather than the sharper Ferry Street turn.
  With two exits, the main key chooses the closest angle; a side key chooses
  that side. With more than three, tap side keys while holding the main key to
  cycle through every exit (wrapping at the ends), after the first tap selects
  that side's outermost exit. Key auto-repeat does not cycle.
  Release a side key first to update the preview from the remaining keys.
  Release the main key while a side key remains held to leave the sub-road group
  and switch to the remaining direction. At the Waterloo/Ferry fork, W then A
  previews the left Waterloo branch; releasing W while A remains switches to Ferry.
  Sub-road key releases have a 150 ms grace period: release all keys within that
  window to confirm the combined preview; hold a remaining key longer to switch.
  Within sub-road mode, opposite directions or both side keys cancel the preview. Directions with no
  matching exit do nothing. Losing focus cancels keyboard confirmation; mouse
  hover and click remain available.
  Boundary contact applies continuous speed-dependent drag in both forward and
  reverse, including while accelerating. Tune `BOUNDARY_DRAG` in
  `web/physics.mjs` (2 per second, exponential speed decay). Queued junction
  snaps still check rotation clearance. The rectangle conservatively encloses the
  rounded visual corners. `taxi_radius` is only used by older map fixtures.
  A single light-red outline marks the physical road edges at 80% opacity,
  using 1 m strokes without tinting the road interior.
  Contact with a road edge removes outward movement and allows sliding along
  the edge, including around rounded endpoints and tight corners. Swept body
  checks still prevent cutting through concave corners or disconnected roads.
  If conflicting corner contacts reject the normal slide, the collider checks
  nearby forward slide directions, reducing travel rather than adding speed.
  Head-on contact limits attempted speed to 3 m/s rather than disabling steering;
  brake/reverse or steer away from the obstruction.
  The outline follows the physical road width (`road width / 2` from the centre),
  including narrow roads and joined junction perimeters, without a decorative
  outer road outline.
- Wrong-way entry and restricted turns remain possible with warnings. GPS routes
  still respect the directed road graph and supported turn restrictions.
  Small arrows show legal traffic directions, not the taxi's chosen direction.
  One-way roads point one way; two-way roads have opposing arrows on the left
  side of each travel direction. Segments shorter than 16 m omit arrows to limit
  clutter. Arrows reflect the packaged graph, not live road signage.
- Orange roads have simulated congestion; red roads are closed. A new simulated
  closure is selected approximately every 100 seconds of active game time.
  Closures block entry, not the controls: reversing and steering away remain
  available. If a closure appears on the taxi's current way, it may drive out,
  but cannot re-enter once it has left.
- The **blue** marker is the taxi rest stop. Stop there to refuel or buy upgrades.
  Fuel efficiency costs $100; the engine tune costs $160. Upgrades last one shift.
  The engine tune improves forward acceleration by 30%, not top speed.
- Standard and tuned engines share a **150 km/h** top-speed cap; congestion can
  lower it. This is the agreed Crown Comfort-inspired arcade approximation,
  **not a verified Toyota specification or a legal road speed limit**.
- If stuck or out of fuel, pause and use **Return to rest stop**. Recovery costs up
  to $20, adds emergency fuel, and does not complete the passenger trip.
- **繁中 / EN:** switch language. **+ / −:** zoom. **⌖:** district overview.
- **3D / 2D:** switch between the experimental chase-camera view and the original
  top-down map without restarting your shift. Zoom changes chase distance in 3D;
  overview shows the whole district. The initial view remains 2D.
  In 3D, a north-up minimap in the bottom-left follows the taxi and shows the
  same routes, junction guidance, and stop markers as the 2D map. It updates at
  up to 60 Hz, limited by the browser's animation frame rate.
  The compact window is 200 × 140 CSS pixels on desktop and 140 × 100 on mobile.

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

The 2D renderer uses **one Canvas layer** rather than Leaflet plus a separate driving
overlay, avoiding external tile hosting. Likewise, the offline importer uses Python's
standard library instead of the larger OSMnx/geospatial dependency stack; the
packaged graph is small enough for direct geometry and heap-based routing.
The map cache is rendered from vector geometry at the current zoom and native
screen pixel density, keeping roads and bilingual labels sharp on high-DPI screens.
Only the visible area plus a small scrolling margin is cached, rather than a
high-resolution bitmap of the entire district.

### Experimental 3D view

Press **3D** in the map tools after starting a shift. This is a visual conversion,
not a new driving simulation: the Python game, road matching, rectangular collider,
wall drag, junction selection, orders, fuel, and controls are unchanged. Roads
remain flat even at stacked crossings; there is no gravity, suspension, slope
handling, or 3D building collision. Building heights (10–38 m) and window details
are deterministic artistic approximations, not measured Hong Kong architecture.

The view includes a red-and-silver procedural taxi, extruded OSM building
footprints, road directions, route/exit highlights, pickup/drop-off/rest-stop
beacons, and a bilingual current-road label. Nearby building blocks fade when
they obscure the taxi. Location rings and beacons respect scene depth, so they
do not draw over the taxi. On phones the dispatch panel scrolls to leave room for
the camera. Switch back to **2D** at any time for the detailed map.
The chase camera filters steering changes and limits its heading-follow speed
to 0.9 radians/second, easing junction turns without changing taxi steering.
Reload an already-open game after renderer updates; ES modules stay loaded for
the lifetime of the page. The current app and 3D entry points use versioned URLs
to bypass older cached code, including in the VS Code browser.
Nearby roads use a cached local texture at 8 pixels
per metre (subject to the GPU texture-size limit), rather than enlarging the
district overview texture. The cache follows the taxi without changing collision
geometry; overview keeps the lighter district-wide texture.
Red collider outlines are drawn separately as anti-aliased vector geometry,
not enlarged texture pixels. Polygon unions retain the joined road perimeter
without drawing lines across junction openings.
Narrow holes are split before triangulation to avoid spurious filled triangles
across building blocks; shared cut edges remain invisible.

Three.js 0.180.0 is packaged locally in `web/vendor/three/`, including its MIT
licence. There are no CDN, model, font, or texture downloads while playing.
The locally packaged MIT-licensed `polygon-clipping` helper joins the road
outline geometry without overlapping lines.
`npm install` / `npm ci` runs `tools/vendor-three.mjs` to refresh these generated
files from the locked dependency. Commit the generated files when updating Three.js;
Python-only startup and the existing Docker image need no Node.js runtime.

3D requires WebGL 2. Initialization failures and context loss are reported on
screen and leave the 2D view usable. Buildings are batched into small blocks,
distant blocks are culled, and the city pass can fall to 55% of CSS resolution
on slow devices. Red boundaries use a separate depth-tested pass at screen
resolution (up to 1.5 times CSS resolution on high-DPI screens), independent
of city quality. Derivative-based edge anti-aliasing smooths the boundary silhouette
without blurring it or drawing seams across its triangles. The 2D renderer retains
its native high-DPI resolution. Chromium reference tests require at least 24 FPS
for 3D; actual hardware/browser performance varies.
Driving guidelines use the same screen-resolution, depth-aware anti-aliasing
pass, with round end caps and round joins. Overlapping segments are merged so
bends do not leave cracks or darker overlapping patches;
the selected/pickup/yellow/normal drawing priority remains unchanged.
Nearby road-direction arrows also use rounded, anti-aliased vector strokes in
this pass, preserving the same legal directions and left-side offsets as 2D.
After the initial view loads, nearby boundary and arrow geometry is computed in
a module worker. The previous detail stays visible until its replacement is
ready, avoiding main-thread polygon-triangulation stalls while driving.
Chase mode omits the low-resolution texture copies of road lines; the district
overview retains them. Local vector boundaries are clipped to their cache area
so incomplete neighboring roads cannot create extra perimeter lines outside it.
Anti-aliasing applies only to original polygon contours, not internal hole cuts.

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
