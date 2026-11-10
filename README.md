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
Safe citizen walking paths are prepared once at startup, which can take several
seconds; entering new streets does not build this geometry during driving.
After a code update, restart the backend and refresh the browser to load the
matching scripts. An already-open page keeps its old scripts until refreshed;
refreshing starts a new shift.

## Map loading and larger districts

The browser starts with `/api/map?stream=true`: the complete road graph,
restrictions, driving parameters and road/terrain heights remain available before
driving starts. Detailed building footprints and their height/base metadata are
not in this bootstrap. A coarse footprint overview covers unloaded areas and
district-scale maps. `/api/map` still provides the complete document for tools.

- `map_streaming.py` partitions building/park visuals into **256 m chunks**.
  Footprints crossing a boundary are included in every intersected chunk and
  deduplicated by their original ID in the browser.
- `web/map-stream.mjs` shares downloads across driving, the map popup and the
  minimap. It prioritizes a **384 m player buffer**, prefetches up to **160 m**
  ahead, downloads at most **two chunks at once**, and retains at most
  **64 chunks** using an LRU cache. Detailed popup requests follow its camera;
  zoomed-out views use the overview rather than downloading the whole district.
- Chunk URLs contain a dataset-content version, support ETag revalidation and
  immutable browser caching, and responses support gzip compression. Mixed
  dataset versions are rejected. Failed downloads show an alert and retry after
  five seconds; missing visuals never remove road collision protection.
- `web/map.mjs` indexes primitives spatially and caches up to **128 raster tiles**
  per map at half-octave zoom levels. Tiles are **256 raster pixels**, with a
  two-pixel gutter to avoid seams; at most two are built per render. Existing
  tiles remain visible while updated tiles are prepared.
- `web/map3d.mjs` constructs nearby building groups progressively, using a
  four-millisecond scheduling budget and a maximum of eight building steps per
  render. Building meshes outside the buffered area are disposed; chunk data
  can remain cached for revisits. Road deck tiles are built nearest-first with
  a separate four-millisecond scheduling budget. These are cooperative budgets,
  not hard execution limits for a single polygon. Terrain texture refreshes
  still use a worker and progressive GPU uploads.

To extend the map, rebuild the packaged district/elevation data with the existing
tools and restart the backend. Chunk manifests and content versions are generated
automatically. This is runtime visual streaming, not development hot reload:
an existing shift must be refreshed after a dataset change. The road graph,
height grid, terrain mesh initialization and server sidewalk preparation still
scale with the whole district; this pipeline does not stream gameplay topology.

## Play

- **W / Up:** accelerate. **S / Down:** brake; keep holding after stopping to
  reverse at up to 4 m/s. Release the pedal to slow down. **A/D / Left/Right:** steer.
- **Space:** handbrake; it slows the taxi without engaging reverse. **Esc:** toggle
  the pause menu; closing it resumes the shift. Losing focus or changing browser tabs clears held controls
  without opening the pause menu. Use Pause or Esc to pause explicitly.
- Phones show separate touch steering, brake, and accelerator controls.
- Tap the phone tab on the right edge or press **Tab** to slide the dispatch
  phone in or out (Shift+Tab still moves keyboard focus); swipe left/right on
  touchscreens. Its badge counts available offers. Opening
  the phone does not pause driving. Each time it opens, it starts on **Available**;
  accepting an order still switches to **Accepted** to show the trip.
- **Available** lists fictional customers, reachable street pickups/destinations,
  estimated fares, and distance to pickup. Offers arrive every random **45–180
  seconds** and disappear after **30–180 seconds**, with no offer cap or visible
  countdown. One initial offer is available when the shift starts.
  If no legal passenger trip is reachable when a scheduled offer is due,
  dispatch logs the deferral and tries again after 45–180 seconds; driving
  continues without rejecting the movement update.
- Accept a phone order, then stop at its **green** pickup marker. The customer
  waits waving at the curb and walks into the taxi automatically once you stop.
  **Accepted** stores the current pickup and any waiting order.
  Carry one passenger per trip; while carrying one, you can accept **one pending
  phone order**. Waiting accepted customers cancel after **120–300 seconds**,
  without a money penalty. The timer stops applying once they board.
- Citizens walk along safe roadside paths on both sides of nearby ground-level
  streets, never through road surfaces or building footprints. Blocked paths
  turn back rather than cutting through buildings or across junction roads.
  Movement is sampled continuously between server updates, with varied walking
  speeds, alternating arms/legs, and eased facing changes.
  Only the normal **3D view** can trigger a new street hail: a citizen must be
  inside its screen bounds and within **80 m** of an empty taxi. Buildings do not
  block this eligibility check; overview, 2D and the minimap never trigger it.
  Accepted phone orders prevent new street hails; existing hails and curb
  approaches continue. Each eligible citizen gets a **5%** chance per **300 seconds** of simulation
  time. There are no hails at spawn. Successful citizens walk to a validated
  roadside curb before stopping and waving for a random **45–120 seconds**.
  Uncollected hails then stop, enter a **300-second** cooldown, and walk back
  to their original sidewalk path. These timers use simulation time and pause
  with the game. **Orange** hailing
  citizens show a floating **Taxi! / 的士！** speech bubble in the main 2D and
  3D views (the minimap keeps its orange markers).
  Bubble arrow tips stay anchored above their citizens when resized, and 3D
  bubbles render over the red road-boundary lines.
  Hailing citizens can be picked up by stopping alongside on the same road, then using
  **Open door / E**. A short boarding animation holds the taxi still; the street
  passenger's destination appears only after boarding. Phone pickups do not
  require the door button. In 3D, citizens and waiting, boarding, and alighting
  passengers follow their road's elevation rather than the flat map plane.
  Citizen population is configured in `game.py`: `Game.create` starts
  with 60 citizens, and `Game.advance_city` adds up to five every 0.5 simulation
  seconds until 100 are within the spawn radius. An empty stationary area refills
  in about 10 seconds when safe sidewalks are available; moving can keep the
  nearby count below 100. `CITIZEN_LIMIT`, `CITIZEN_SPAWN_BATCH`, and
  `CITIZEN_SPAWN_INTERVAL` control this gradual refill. Citizens outside the radius do not
  count toward this local limit. `CITIZEN_HAIL_PROBABILITY = 0.05` controls the passenger
  chance; `CITIZEN_HAIL_COOLDOWN = 300` controls repeat rolls, and
  `CITIZEN_HAIL_DISTANCE = 80` controls the distance requirement.
  `CITIZEN_HAIL_DURATION = (45, 120)` controls the waving timeout range.
  Drop-off animations always use the taxi's left door relative to its heading;
  pickup doors still use the passenger's side. Map Y points down, so the left
  offset is `(sin(heading), -cos(heading))`, not the mathematical left normal.
  `CITIZEN_RADIUS` limits spawning to 220 metres around the taxi, matching the
  normal 3D driving fog distance (not the zoomed-out overview). Citizens leaving
  that radius remain until their original 80–150 second expiry time is reached.
  Citizens whose timer already expired are removed when they leave the radius.
  That timer does not remove citizens while they remain nearby. If no safe
  roadside path is nearby, the population can temporarily be lower. Walking
  and existing orange hailing markers remain visible in 2D and the minimap.
  Phone orders and trip stops are not
  restricted to this radius.
- Street pickups can temporarily put an accepted phone pickup on hold; its
  original waiting deadline still applies. Stop at the **yellow** destination
  marker and use **Drop off passenger / E** to earn the fare. The passenger
  steps out and walks to the curb while the taxi is held still. The door opens
  on whichever side is nearer the passenger. Any waiting phone
  pickup becomes the next trip automatically.
- Offer, waiting, and boarding timers use simulated shift time, so explicit
  pauses (including junction choices) freeze them. Passenger animations include
  unacknowledged movement time, so network updates do not rewind their progress.
  Passenger actions wait for an in-flight movement acknowledgement instead of
  discarding the click.
- The route is a suggestion; you may choose another legal route.
  Overlapping road guides render in this priority, highest first: cyan selected
  or previewed exit, green pickup route, then yellow destination route.
  Current-road and unselected available-exit highlights are not drawn in 2D,
  3D, or the minimap.
- Steering remains under your control. Ordinary junctions do not open a popup.
  Junctions with more than two available exits and connected stacked-road forks pause to offer
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
  selected or previewed exit to its following junction or dead end, including
  short segments and bends. Closed roads and disconnected crossings are excluded.
  The selected-road highlight clears on entry.
- An unconnected flyover crossing never opens a selector or changes the current
  road level. Reach other levels through actual connecting roads/ramps.
- Steering sensitivity is configured by `STEERING_SENSITIVITY` in
  `web/physics.mjs`; increase it for faster turning and decrease it for slower,
  gentler normal steering.
  Manual keyboard and touch steering ease toward the requested direction rather
  than switching instantly, following a parabola: `(held time / duration)^2`,
  clamped at full steering. `STEERING_RESPONSE_SECONDS = 0.2` controls turn-in
  and direction changes; `STEERING_RETURN_SECONDS = 0.08` controls return to
  centre after release, in `web/physics.mjs`. Larger values give slower smoothing.
  Turn-in reaches full strength after the response duration; release uses an
  exponential return (about three return durations to centre by 95%). Pausing, losing focus,
  or resetting controls clears the buffered steering. Junction snaps are unchanged.
- The taxi uses a rotated rectangular body collider, configured in metres by
  `taxi_length` and `taxi_width` in `roads.py`'s `DRIVING` settings. The rendered
  body uses the same dimensions, including its outline, and scales with map zoom.
  The current metric footprint is 4.7 m long by 1.7 m wide.
  Normal movement and reverse keep the full body within connected road corridors.
  Collision checks and red outlines follow the same connected road-surface union.
  Connected straight sections with matching way, width and road level share
  collider geometry instead of repeating opposing-direction capsules.
  `STRAIGHT_ANGLE` (1 degree) and `STRAIGHT_DEVIATION` (0.01 metre) in
  `roads.py` and `web/straight-lines.mjs` limit merging; both sides must match.
  Routing nodes, closures and junction selection remain unchanged.
  The local junction search includes short connector segments just outside the
  taxi footprint, so a slip-road boundary cannot block an overlapping main road.
  Disconnected crossings and separate road levels remain isolated.
  Manual steering is not cancelled by wall contact: rotation may overlap
  the boundary. An overlapping taxi can slide along the wall or drive/reverse
  back onto the road, but movement deeper into the wall remains blocked.
  Junction selection also remains available during existing boundary overlap:
  queuing an exit does not move or rotate the taxi.
  The selector appears as a top-centre HUD with one card per road and its
  keyboard shortcut underneath. The HUD uses 70% opacity, with road cards ordered
  by relative turn angle from left to right. Larger groups scroll horizontally;
  ×N means tap the side key N times while holding the main key.
  Arrow keys mirror WASD.
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
  Reaching zero fuel stops the taxi without rejecting subsequent stationary
  updates or losing the onboard passenger. Buffered browser movement is discarded
  when the server confirms the empty tank.
- **繁中 / EN:** switch language. **+ / −:** zoom. **⌖:** district overview.
- **M / map button:** open or close a top-down map popup without changing or pausing
  the driving view underneath. Use the mouse wheel to zoom around the cursor
  and drag to pan; **Esc** closes the map before opening the pause menu.
  The default initial driving view is 3D and can be
  changed in Settings.
  In 3D, a north-up minimap in the bottom-left follows the taxi and shows the
  same routes, junction guidance, and stop markers as the 2D map. It updates at
  up to 60 Hz, limited by the browser's animation frame rate.
  The compact window is 240 × 168 CSS pixels on desktop and 168 × 120 on mobile.
  Its canvas and cached map render at a minimum 2× pixel density, retaining
  native density on higher-DPI screens without enlarging a low-resolution image.
  Taxi marker minimum lengths are set by `TAXI_ICON_MIN_LENGTH` near the top of
  `web/map.mjs`: `map: 32` and `minimap: 24`, in CSS pixels. Increase these values
  to enlarge the icons; these display sizes do not change taxi physics.

**Settings** is available from the welcome and pause menus. It includes the
**Interface → Enable junction selector** toggle. Turning it off disables automatic
junction pauses and selection, allowing manual driving while retaining road guidance.
It defaults on and is saved with your other preferences.

Settings also includes the
default 2D/3D view and graphics preset; chase-camera smoothing, turn speed,
distance, and reduced motion; steering sensitivity and junction-key grace time;
minimap visibility, size, zoom, and refresh rate; junction HUD opacity, shortcut
hints, and English / Traditional Chinese. Changes apply immediately. Settings
are stored separately in this browser's local storage; read/write failures are
shown in the interface.

There is **no shift-progress saving**. Reloading starts a new shift, while
settings remain in this browser. A server restart also clears sessions. Money
and fares are arcade game values, not Hong Kong taxi tariffs.

## What is included

- Locally packaged, attributed district roads, buildings, parks, and bilingual road names.
- Directed road routing with node and ordered via-way turn restrictions.
- Keyboard/touch manual driving, low-speed reverse, road boundaries, warnings,
  pause/resume, and advisory stacked-road choices.
- Sliding dispatch phone, timed random offers, an accepted-order queue, walking
  street-hail citizens, pickup/boarding validation, earnings, and bilingual personalities.
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

Press **3D** in the map tools after starting a shift. The packaged district now
contains official LandsD terrain and one highest-detail infrastructure-model pilot:
**Yau Ma Tei Interchange over Hoi Wang Road**. Taxi height/pitch, road decks,
road-surface guides, rings, building bases and chase camera use offline elevations.
The source-confirmed pilot is **not survey verified**: its vertical datum alignment
is estimated. Elsewhere ground/road/tunnel profiles are explicitly estimated from
the DTM and OSM topology. Tagged building heights replace artistic random heights;
floor counts × 3.2 m and an 18 m fallback remain labelled estimates.

Slope gravity affects acceleration/braking in both views; client and server share
the same surface and slope-speed-limit equations. Connected road heights use
monotone cubic vertical profiles: ramps and crests blend their slopes instead
of changing taxi pitch abruptly. Ordinary two-segment continuations share
endpoint grades. At mixed-class junctions, the main road keeps its grade and
side roads conform across its full width, easing back to their own profile over
8 m beyond the main curb. Priority is motorway, trunk, primary, secondary,
tertiary, unclassified, residential, then service; link roads yield to their
parent class. Short connected side-road pieces share the adjustment so their
endpoints do not split apart. Equal-class multi-road junctions and sharp bends
still flatten at the shared node. Main-road source heights, horizontal road layout,
turn controls and disconnected levels are preserved; minor-road heights near
the junction may adjust to meet the main surface.
The estimated source profiles limit average segment grades to 12%;
local curved grades can be steeper, with the speed penalty still capped at 12%.
Road decks, bridge/tunnel shells, markings, collision outlines and GPS guides
sample the same profile. Curved decks use at most 2 m steps, refined where needed
to bound vertical interpolation error to 5 mm. Profiles and geometry are prepared
once, not rebuilt while driving.
The 2D map presentation, preferences, junction controls and existing corridor
collider remain unchanged. No discarded boundary/blocker update is restored.
No rigid-body jumps, suspension or rollover physics are added. Cars remain on their
connected road surface, never switching to an unconnected bridge at a crossing.
Solid bridge decks and estimated tunnel floors/walls/ceilings render separately;
obstructing structures fade, and terrain fades for readable tunnel interiors.
These are constrained arcade road-surface collisions, not surveyed 3D building/
pillar collision meshes. Building collision still relies on staying on roads.

See [elevation provenance and limitations](data/ELEVATION-SOURCES.md).
The Government datasets retain their own attribution/terms, separate from ODbL.
The game makes no external terrain/model requests at runtime.

To reproduce the district package (map-build dependency only):

```sh
.venv/bin/python -m pip install -r requirements-map.txt
.venv/bin/python tools/prepare_elevation.py --refresh
.venv/bin/python tools/prepare_pilot.py
```

The DTM importer streams at most 40 MB compressed via HTTP ranges and retains
only district samples, not the whole-Hong-Kong archive or expanded raster.
The pilot importer downloads at most 5 MB and retains only a 200 m crossing clip.
Without `--refresh`, the retained district DTM is reused. After refreshing OSM,
rebuild both packages; stale map/elevation versions are rejected at server startup.

The view includes a red-and-silver procedural taxi, extruded OSM building
footprints, road directions, route/exit highlights, pickup/drop-off/rest-stop
beacons, and a bilingual current-road label. Nearby building blocks fade when
they obscure the taxi. Location rings and beacons respect scene depth, so they
do not draw over the taxi. Walking and hailing citizens, plus street boarding,
appear in both views and the minimap. The dispatch phone slides away to leave
room for the camera. Switch back to **2D** at any time for the detailed map.
The chase camera filters steering changes and limits its heading-follow speed
to 0.9 radians/second, easing junction turns without changing taxi steering.
Reload an already-open game after renderer updates; ES modules stay loaded for
the lifetime of the page. The current app and 3D entry points use versioned URLs
to bypass older cached code, including in the VS Code browser.
Nearby roads use a cached local texture at 16 pixels
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
distant blocks are culled, and Quality renders the city at screen resolution
(up to 2 times CSS resolution on high-DPI screens). Auto starts at the same
resolution and can fall to 55% on slow devices without reducing terrain-cache
texture detail or road-guide resolution. Up to 4x
multisample anti-aliasing smooths building and terrain silhouettes. Performance
mode starts at 75% of screen resolution and can fall to 50% on slow devices.
Red boundaries use a separate depth-tested pass at screen resolution, independent
of city quality. Derivative-based edge anti-aliasing smooths the boundary silhouette
without blurring it or drawing seams across its triangles. The 2D renderer retains
its native high-DPI resolution. Free-steering Chromium reference tests cover both
2D and 3D, requiring 55 FPS on desktop and 30 FPS in phone emulation; actual
hardware/browser performance varies.
Driving guidelines use the same screen-resolution, depth-aware anti-aliasing
pass, with round end caps and round joins. Overlapping segments are merged so
bends do not leave cracks or darker overlapping patches;
the selected/pickup/yellow drawing priority remains unchanged.
GPS, traffic, closure, and selected-turn overlays are cached independently.
Following an elevated GPS route hides completed segments with a draw range;
it does not rebuild the route or unrelated traffic geometry at each road.
Straight GPS sections omit duplicate internal round caps and retain per-road
draw offsets. Height curves keep their sampled subdivisions, and red outlines
only merge when their elevations also align.
Internal GPS subdivision joins stay opaque: anti-aliasing applies only to
the exposed perimeter, preventing faded seams along sloped roads.
Reroutes reuse a bounded cache of 512 sampled road-segment shapes, assembling
the new guide without retriangulating roads already used by the same view.
In the elevated view, new GPS geometry is prepared in the terrain worker so
first-time routes do not block acceleration after pickup. The previous guide
stays visible until its replacement arrives; obsolete worker replies are ignored.
Advancing along the same route while its worker build is pending keeps that
request alive. Its completed geometry is trimmed to the latest remaining legs,
so crossing short road segments cannot repeatedly cancel and hide the guide.
Elevated collision outlines share static vertices in 80 m tiles; off-screen
and distant tiles are culled instead of submitting the entire district each
frame. This does not rebuild geometry or change collision rules.
Nearby road-direction arrows also use rounded, anti-aliased vector strokes in
this pass, preserving the same legal directions and left-side offsets as 2D.
After the initial view loads, nearby boundary/arrow geometry and the high-resolution
road texture are computed together in a module worker using a CPU-backed 2D
canvas. Completed RGBA pixels are transferred without copying and uploaded to
one reused DataTexture, keeping the same resolution, filtering, and orientation.
This avoids the ImageBitmap/canvas-to-WebGL synchronization that can freeze
the Windows GPU pipeline even when main-thread JavaScript timings look fast.
The previous detail stays visible until its replacement is ready, avoiding
main-thread polygon-triangulation and texture-redrawing stalls at 64 m cache changes.
Browsers without worker-side OffscreenCanvas 2D retain the main-thread texture
refresh and log a compatibility warning; geometry still runs in the worker.
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
On Windows, tests select ANGLE's Direct3D 11 backend so headless Chromium uses
the GPU rather than measuring SwiftShader software rasterization. For normal
Chrome/Edge play, enable graphics acceleration in the browser settings and check
`chrome://gpu` or `edge://gpu` if 3D remains slow. A WebGL 2 context alone does
not guarantee hardware acceleration. Performance tests also check frame-time
tails and cache-refresh work, not only average FPS. A 20-second drive crosses
multiple cache cells and asserts a maximum frame gap below 250 ms, including
the actual texture upload/render rather than only the refresh function call.

### Order system checks

The order rules are covered by `tests/test_orders.py`; phone controls and boarding
in both views are covered by `tests/browser/orders.spec.mjs`. Animation geometry
is covered by `tests/citizens.test.mjs`. Run the focused checks with:

```powershell
python -m unittest discover -s tests -p test_orders.py
node --test tests/citizens.test.mjs
npx playwright test orders.spec.mjs
```

The order update passed all 60 Python tests, 19 focused JavaScript tests, and all
10 order browser tests across desktop and phone emulation. The broader suites
still report failures in the unchanged boundary-drag physics test and older
junction tests; those are not addressed by the order update.

### Earlier baseline measurements

- 25 Python rule/API tests pass, including a complete real-graph passenger trip,
  replay-safe rewards, road containment, advisory choices, warning-only turns,
  and acceptance at/rejection above the shared 150 km/h cap.
- 15 JavaScript physics tests pass, including boundary sliding, reverse, extended
  footprint containment, disconnected flyovers, full forward/exit paths across short
  segments, exact speed caps, acceleration upgrades, and high-speed corridor travel.
- 24 Chromium browser tests pass across desktop and phone-emulated viewports,
  including manual junctions, cyan selection rendering/clearing, reverse,
  hidden current-road/available-exit guides, thicker 80%-opacity outlines,
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

Geographic scale is unchanged: centre lines and building footprints retain the
same local metre coordinates derived from OSM latitude/longitude. Zoom changes
the camera, not road geometry. Enlarging the entire map would also enlarge
building blocks and is not a correction for oversized carriageways.

`data/road-widths.json` supplies per-segment widths shared by Python validation,
browser physics, 2D textures, minimap, 3D decks/joints, direction arrows and red
boundaries. It prefers a usable OSM `width`, then estimates **3 m per tagged
lane**, then uses one-way-aware class estimates. `lanes` is a carriageway total,
not a per-direction count. These are tagged/estimated widths, not surveyed ones.
The old broad `DRIVING.widths` values remain only for legacy maps/test fixtures
without per-edge widths.

A spatial audit constrains neighboring, near-parallel, same-level carriageways
to leave at least **0.3 m** between their physical edges. Widths are reduced
proportionally toward a 2.2 m minimum; coordinates are never shifted. Connected
junctions, merging sections within 15 m of a shared node, and tagged
bridge/tunnel/layer differences intentionally remain exempt. This is not a
survey or a guarantee for missing/mistagged topology, nonparallel intersections,
or road furniture. Impossible spacing is recorded as a conflict and reported
when building/loading the package, not hidden by allowing the taxi through.
The package includes provenance, requested widths, adjustments and spacing checks;
its map version is validated on load. The current district audit has zero
unresolved eligible pairs. The Ferry/Ching Ping pair that previously overlapped
now retains at least the 0.3 m gap, and the 4.7 x 1.7 m taxi fits both roads.
Red boundary strokes are 0.25 m wide rather than the previous 0.8 m, so the
strokes themselves do not visually fill the minimum parallel-road gap.
Their 3D segments use rounded, anti-aliased caps to close gaps at angled joins,
without smoothing or moving the actual collision boundary.
At acute or unequal-width junctions, the connected same-level road surfaces
form one collision corridor throughout their overlap, not just within a small
radius of the shared node. Internal red edges are clipped at that opening.
This shared rule runs in browser and server physics; disconnected crossings,
different-level approaches and queued-exit restrictions do not gain shortcuts.

Other physical visual dimensions are centralized in `web/world-scale.mjs`.
The 4.7 x 1.7 m taxi now has a 1.5 m roof, a 0.12 m taxi sign and 0.31 m-radius,
0.19 m-wide wheels; its horizontal footprint still matches collision validation.
Road paint is 0.1 m wide, with estimated 3 m dashes / 6 m gaps and 3 x 0.8 m
direction arrows. Single narrow carriageways no longer get a centre divider.
Building footprints and tagged/estimated heights are preserved; facade floors
repeat every 3.2 m and window bays every 3 m. Missing building heights use the
same labelled 18 m estimate rather than randomized heights, including flat 3D.
Bridge thickness (0.65 m) and tunnel clearance (5 m) remain estimates, not
surveyed dimensions; official pilot geometry is not rescaled. Terrain and
geographic coordinates retain their original metre scale. Pickup beacons,
route/junction highlights, map labels and HUD remain deliberately readable game
overlays, not physical objects or surveyed road markings.

The elevated driving view projects a scrolling 256 m terrain-detail texture
at 16 pixels/metre (subject to the GPU texture-size limit) onto the existing
terrain mesh. Building footprints and parks retain sharp edges near the taxi
without flattening slopes or drawing a decal over bridges. The cache refreshes
in the worker at 64 m intervals and fades into the district backdrop over its
outer 16 m. Elevated cache replacements upload into a second texture in chunks
of at most 2 MiB per frame. The worker also prepares the mipmaps, avoiding a
full-texture upload and GPU mipmap rebuild during driving. The previous texture
and its coordinates stay active until every replacement mip level is ready.
The distant terrain backdrop is built once at up to 3 pixels/metre, capped at
8192 pixels and the GPU's texture limit. Mipmaps and anisotropic filtering
remain enabled for distant and oblique surfaces; overview keeps its lighter
district-wide texture.

The complete rotated taxi footprint must stay inside the connected road
capsules. Red lines are static, full-district collision geometry built once
per map, independent of taxi movement or its current road. Passable connected junction openings are removed using
the physics candidate rules; disconnected overlapping roads do not erase an
edge. In 3D the lines follow the associated road height, including ramps and
tunnels. The same fixed boundaries appear in 2D, the minimap and district overview.
District limits are also marked where they cross a road.
These are physical road edges, not an inset taxi-centre limit: the taxi's front
or side touches them before its centre does. Geometry is shared across map views
and never rebuilt while driving. Normal camera/depth visibility still applies.
Traffic and closure indicators
remain separate from physical boundaries.

Movement checkpoints carry the intervening positions. The backend checks the
connected road corridor along those paths, rejecting off-road movement and
unconnected level changes rather than silently snapping the taxi.
Browser collision handling also validates intermediate positions at the same
0.4 m sampling interval, preventing boundary slides from cutting across concave
road corners and triggering a rejected movement.
If the server nevertheless rejects a taxi-footprint movement, the browser restores
the last server-confirmed position, heading and road, stops the taxi, discards
unconfirmed movement and resumes without a blocking dialog. Held controls remain
active, and a four-second notice explains the recovery. Other command conflicts,
network failures and rule errors retain their existing error handling.
Each boundary rejection includes diagnostic movement/trail data (at most 240
client samples), the rejected sample, confirmed road and selected junction in the
browser console. Server warnings contain the same bounded data, limited to one
entry per session every five seconds, with a count of suppressed repeats.

On roads no wider than **2 times the taxi width** (3.4 m for the current taxi), steering toward either
direction along the current segment gains smooth alignment assistance when
the heading difference is **strictly below 30 degrees**. This works forward and
in reverse, ignoring official road direction for alignment only. Assistance
changes heading, never teleports sideways, and adds rotation only if the entire
angular sweep fits the connected road footprint. Steering away, no steering,
stationary taxis and wider roads retain manual steering; closures and route
restrictions are unchanged. The assist's exponential response time is
`NARROW_ROAD_ASSIST_SECONDS` (0.25 seconds) in `web/physics.mjs`, separate from
manual steering response and sensitivity.
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

The map importer also rebuilds `data/road-widths.json`. To revise width rules
without regenerating geographic/elevation data:

```sh
python tools/prepare_road_widths.py
```

Restart the Python server and reload the page after scale changes; existing
shifts use the previous geometry and cannot be migrated safely.

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
