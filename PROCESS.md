# Night Shift HK: Project Process and Progress

## Current status

The local prototype is implemented and its recorded local test suites pass.
The user chose to finish with the runnable local game and deployment instructions,
without creating a public hosting service.

This document records work and verification performed during development,
including the accepted road-boundary and manual-junction redesign below.
See [PLAN.md](PLAN.md) for scope and roadmap, and [README.md](README.md) for running
and publishing the game.

## 1. Requirements discovery

The initial idea was a Python-built web game about taking taxi orders in
Hong Kong, with a 2D GPS-style map and direction choices at intersections.

Clarification established:

- Start in Mong Kok / Yau Ma Tei rather than all Hong Kong.
- Use free steering, not automatic travel between junctions.
- Initially pause at junctions and briefly assist the selected turn; superseded
  by manual junctions and advisory stacked-road choices in the subsequent redesign.
- Initially allow off-road/wrong-way movement with warnings; the redesign prohibits
  off-road movement while retaining warning-only wrong-way/restricted turns.
- Show suggested routes without requiring the player to follow them.
- Use OpenStreetMap instead of requiring Google Maps.
- Include bilingual content, passenger personalities, simulated traffic/closures,
  fuel, and upgrades.
- Deliver in playable stages, without saving in the prototype.

The workspace was empty when inspected, so implementation began as a new project.

## 2. Architecture and map decisions

| Decision | Reason |
|---|---|
| Python FastAPI rules/API plus JavaScript movement | Keep Python central without putting frame-by-frame steering behind network latency |
| One Canvas map and driving renderer | Simpler for a bounded GPS-style district than Leaflet plus a separate overlay |
| Locally packaged OSM extract and backdrop | Avoid Google data extraction, per-player map queries, external tiles, and API keys |
| Standard-library importer and heap-based routing | Avoid a large geospatial dependency stack for this district-sized graph |
| In-memory sessions and sequenced commands | Match the no-saving scope while preventing duplicate transaction effects |
| Scripted bilingual dialogue | Deliver passenger personalities without paid AI services |

Runtime dependencies and development tooling are declared in
[requirements.txt](requirements.txt), [requirements-dev.txt](requirements-dev.txt),
and [package.json](package.json).

## 3. District preparation

The bounded OpenStreetMap source was downloaded and processed using
[tools/prepare_map.py](tools/prepare_map.py).

Recorded packaged dataset:

| Item | Count |
|---|---:|
| Road nodes | 5,194 |
| Directed edges | 6,682 |
| Building/park backdrop shapes | 3,503 |
| Parsed turn restrictions | 291 |
| Unhandled restriction relations in the extract | 0 |
| Recorded length-conditional rules inapplicable to the prototype taxi | 2 |

Initial inspection revealed via-way restrictions in addition to node restrictions.
The importer and router were extended to handle ordered via-way restrictions
rather than treating every connected turn as legal.
Zero unhandled relations does not establish real-world navigation correctness.

Source and adapted data are packaged in [data](data), with attribution and download
links exposed through the [map data licence page](web/data-license.html).

## 4. Implementation progress

| Stage | Status | Delivered |
|---|---|---|
| Foundation | Complete locally | FastAPI service, strict API commands, sessions, static delivery, setup documentation |
| District data | Complete for prototype | Source extract, derived graph/backdrop, restrictions, versioning, service points |
| Driving slice | Updated locally | Manual keyboard/touch steering, reverse, full-footprint road confinement, sliding, ordinary exit highlights, advisory stacked-road choices |
| Passenger loop | Complete locally | Orders, roadside pickup/drop-off checks, route suggestions, fares, replay-safe rewards |
| Dialogue | Complete for prototype | Three authored passenger personalities with English and Traditional Chinese content |
| Traffic and closures | Complete for prototype | Seeded congestion, changing closures, route effects, blocked-road handling |
| Fuel and upgrades | Complete for prototype | Movement fuel use, rest-stop refuelling, efficiency/engine upgrades, emergency recovery |
| Validation and delivery | Complete for local scope | Automated checks, measured reference-browser performance, deployment instructions |
| Public deployment | Deferred by user | No hosting account, public URL, or paid service created |

Core implementation resides in [app.py](app.py), [game.py](game.py),
[roads.py](roads.py), and [web](web).

## 5. Issues found and addressed

### Browser module delivery on Windows

The first browser run could not start the game because the environment served
JavaScript modules as `text/plain`.
The server now explicitly registers the JavaScript module MIME type, and an API
test checks it.

### Junction prompts while parked

A prompt could open immediately when the taxi was parked near a junction.
Approach detection now requires movement and uses a trigger distance bounded by
the incoming segment's length.

### Restriction handling

Map inspection exposed ordered via-way restrictions and length conditions.
Routing tests were added for node restrictions, via-way prohibited turns, and
via-way mandatory turns. The two conditions for vehicles longer than eight
metres are recorded as inapplicable to the prototype taxi.

### Network sequencing and recovery

Commands use sequence IDs and duplicate requests return the original result.
Reusing an ID for a different command is rejected. Slow movement acknowledgements
apply backpressure instead of letting movement checkpoints grow without bound.
Connection failures pause play and offer retry.

### Rendering measurements

Map rendering was changed to draw only the visible backdrop region.
Browser trace capture was found to affect frame timing, so the dedicated
performance tests disable tracing rather than measuring the recorder's overhead.

## 6. Recorded verification

The initial prototype validation run recorded:

| Suite | Result | Coverage examples |
|---|---|---|
| Python rules/API | 17 passed | Real-graph passenger journey, pickup validation, replay-safe payment, fuel/upgrades, closures, routing restrictions, expiry, assets |
| JavaScript physics | 4 passed | Acceleration/steering/braking, fuel/traffic limits, boundaries, geometry, assisted-turn completion |
| Chromium browser | 12 passed | Desktop and phone-emulated controls, junction assistance, bilingual UI, garage transactions, retry, slow acknowledgements, animation budget |

Active free-steering animation measured approximately **60 FPS** in both the
reference desktop and phone-emulated Chromium viewports.
This is not a physical phone benchmark.

Tests are in [tests](tests), with browser configuration in
[playwright.config.mjs](playwright.config.mjs).

### Manual-driving redesign

The user accepted these changes after clarification:

- Confine the complete taxi footprint to approximate road corridors and slide
  along boundaries where possible.
- Derive width from road class; keep a conservative world-sized footprint
  separate from the readable screen-sized taxi icon.
- Remove steering assistance entirely.
- Highlight ordinary-junction exits without pausing or opening a popup.
- Pause for selection only at connected forks whose branches lead to different
  stacked-road levels. A simple unconnected flyover crossing never qualifies.
- Selecting an exit adds a local cyan highlight only; another exit is still
  permitted. Clear the highlight on entering an exit or leaving the approach.
- Allow wrong-way driving and prohibited turns with warnings.
- Add low-speed reverse by holding brake after stopping.

Implementation changes:

- Shared widths and a conservative 2.5 m taxi radius are exposed in the map API.
  Road rendering and physics use this same model.
- Browser movement is constrained to connected road capsules. Server checkpoints
  validate intermediate positions and reject off-road paths atomically.
- Wrong-way reverse edges are marked separately from legal GPS exits.
- Outgoing branch levels use bounded lookahead. Detection excludes the incoming
  road behind the taxi and recalculates available choices around closures.
- The old turn/assist-completion commands and automatic movement code were removed.
- Reverse uses signed speed, absolute-speed stopping checks, movement-based fuel,
  and reversed steering response.

Issues caught during the update:

- Reducing speed repeatedly during edge contact killed sliding momentum; boundary
  handling now removes outward displacement without automatically changing heading.
- Rendering before the initial session arrived could stop the animation loop;
  drawing now waits for both map and session state.
- Comparing all roads around a node could mistake a bridge behind the taxi for
  a stacked choice. Detection now compares only available exits ahead.

Manual-redesign verification:

| Suite | Result | Added coverage |
|---|---|---|
| Python rules/API | 23 passed | Corridor/path validation, warning-only restricted/wrong-way movement, reverse stopping checks, connected stacked choices without automatic movement |
| JavaScript physics | 8 passed | Sliding, reverse/dead ends, footprint confinement over 6,000 simulation steps, disconnected flyovers, traffic/fuel/closures/bounds |
| Chromium browser | 16 passed | Manual ordinary junctions, reverse, advisory stacked selector, clock pause, cyan render/clear, alternative exits, existing gameplay/network regressions |

The browser selector test uses a deterministic map fixture for repeatable visual
behavior; Python tests separately validate choices against the real district graph.
Reference-browser active-driving measurements remained approximately 60 FPS.
Physical phone/Safari coverage remains unverified.

### Earlier previews, visible boundaries, and taxi speed

The user requested earlier junction highlights, half-transparent light-red road
boundaries, and a Toyota Crown taxi-like maximum speed. Clarification selected:

- A four-second preview horizon, clamped to 60–180 m.
- Thin light-red outlines at 50% opacity, without filling the road red.
- A 150 km/h arcade cap for both standard and tuned engines.

Implementation:

- Rendering previews follow connected segments to the first fork, including
  bends and short OSM geometry segments. Closed exits, dead ends, disconnected
  flyovers, and loops do not introduce speculative choices.
- The near-junction trigger for the advisory stacked-road popup is unchanged.
- A cached road-union outline mask avoids internal segment/junction seams and
  opacity buildup. The road interior retains its original colours.
- Shared Python/map metadata supplies the 150 / 3.6 m/s cap and acceleration
  values to browser physics, API validation, and server travel validation.
- The $160 engine tune raises acceleration from 7 to 9.1 m/s² (+30%), not top
  speed. Reverse, congestion, fuel, and full-footprint confinement are retained.
- Toyota's checked heritage page did not establish a top speed. Documentation
  therefore identifies 150 km/h as the agreed game approximation, not a
  manufacturer claim or legal speed limit.

Verification for the speed/early-preview update:

| Suite | Result | Added coverage |
|---|---|---|
| Python rules/API | 25 passed | Exact-cap movement and API acceptance, above-cap rejection, shared map speed metadata |
| JavaScript physics | 13 passed | Four-second/minimum/maximum preview horizons, connected bends, closures, loops, disconnected flyovers, equal engine caps, +30% acceleration, high-speed short-segment continuity |
| Chromium browser | 18 passed | Early exits before stacked popup, unchanged advisory flow, actual light-red boundary pixels/50% compositing, unchanged interior, existing gameplay and performance checks |

The first JavaScript run exposed a strict floating-point distance assertion
(59.999999999999986 versus 60 m); the test now uses a numerical tolerance.
Boundary screenshots were inspected. Physical devices and realistic vehicle
dynamics remain unverified.

### Full forward-road highlights and stronger boundaries

The user requested the entire road ahead and possible exits be highlighted, and
increased light-red boundary opacity to 80%. Clarification selected the stretch
from the taxi to the next junction, then each exit to its following junction.
This supersedes the four-second/60–180 m highlight range above.

- Highlights start at the taxi's projected position, not behind it. They follow
  bends and short OSM segments, stopping at forks, dead ends, closures, or loops.
- Available exits are highlighted for their entire stretch to the following
  junction; the GPS exit stays brighter and a selected exit stays cyan.
- Forward highlights remain visible while stopped facing forward. No steering,
  speed, road confinement, or stacked-popup timing changed.
- Light-red boundary outlines now composite at 80% opacity; road interiors stay
  unchanged.

Latest verification: **14 JavaScript tests and 18 Chromium browser tests passed**,
including full multi-segment exit extents, stopped/distant forward visibility,
closure/loop/flyover isolation, actual highlight path coordinates, 80% compositing,
the existing advisory-selector flow, and desktop/phone-emulated performance.
`git diff --check` passed. Python was unchanged and its suite was not rerun for
this rendering update. Physical phone/Safari coverage remains unverified.

### Reproduce the checks

After installing the development dependencies as described in
[README.md](README.md):

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -p "test_*.py" -v
npm test
npm run test:browser
```

Playwright starts and stops its own local validation server.
Screenshots and retained failure traces are test output, not game assets.

## 7. Delivery and remaining limitations

The project includes local startup instructions, a map licence page, and an
optional [Dockerfile](Dockerfile). The user explicitly deferred public deployment.

Not verified or completed:

- Physical phone performance and Safari behavior.
- Building/running the Docker image.
- A public hosting deployment, public-URL trip test, or hosting cost.
- Complete real-world navigation accuracy or every local taxi restriction.
- Subjective driving feel across representative players and devices.
- Grouping all closely spaced OSM nodes into one player-facing junction.

Known scope limits:

- Road centre lines are an arcade approximation, not collision or lane geometry.
- Ambiguous stacked roads can require recovery.
- Pickup points are fictional nearby game stops, not verified taxi stands.
- Sessions have no persistent saves and disappear on server restart.
- No multiplayer, live traffic, realistic collisions, or competitive anti-cheat.

## 8. Next work when requested

1. Play-test on physical phones and desktop browsers; refine control feel and
   dense junction presentation based on observed problems.
2. Verify the selected deployment method and choose a hosting provider.
3. Publish with HTTPS, check attribution/data delivery, and complete a trip
   through the public URL.
4. Consider district expansion or persistence only after the core experience is
   validated and those features are explicitly requested.
