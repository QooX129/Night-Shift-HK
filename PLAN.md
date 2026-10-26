# Night Shift HK: Project Plan

## Goal

Create a single-player browser game about driving a taxi in Hong Kong, using
Python game rules and a JavaScript driving interface over real road data.
Start with Mong Kok / Yau Ma Tei before considering expansion across Hong Kong.

The current delivery scope is a runnable local prototype with web-deployment
instructions. Public hosting was explicitly deferred by the user.
See [PROCESS.md](PROCESS.md) for implementation history and verification results,
and [README.md](README.md) for setup and controls.

## Agreed gameplay

- Manual steering, acceleration, braking, and low-speed reverse using keyboard
  or phone touch controls. Hold brake after stopping to reverse.
- A GPS-style, top-down map showing the destination and a suggested route.
  Players may choose a different route.
- Ordinary junctions highlight all connected exits without a popup, with a
  brighter GPS recommendation. There is no automatic steering.
  Highlight the entire road ahead from the taxi to the next junction, then all
  available exits to their following junctions/dead ends, including short geometry
  segments and bends. Show it while stopped facing forward; exclude closed roads
  and disconnected crossings. Keep stacked-popup timing separate and unchanged.
  Draw the yellow destination route above all other road highlights.
  Add legal traffic-direction arrows, with left-side opposing arrows on two-way
  roads; exclude synthetic wrong-way edges and omit very short segments.
- Only connected forks involving stacked-road exits pause for an advisory choice.
  Cyan marks the selected exit locally and clears after entry; the player may
  steer into another connected exit.
- Unconnected flyover crossings never allow switching road levels or open choices.
- Real road layout, one-way directions, and supported turn restrictions.
- Enforce approximate road corridors with boundary sliding and a conservative
  full-taxi footprint. Wrong-way entry and restricted turns remain possible
  with warnings; GPS recommendations remain legal.
  Draw light-red road-edge outlines at 80% opacity with a 1.6 m stroke centred on
  the approximate boundary, leaving the rest of the interiors unchanged.
- Cap both standard and tuned taxis at 150 km/h, an agreed arcade approximation,
  not a verified Crown Comfort specification or road speed limit. The $160 engine
  tune increases forward acceleration by 30%; congestion still lowers speed.
- Passenger pickup and drop-off require stopping at the appropriate roadside point.
- Passenger personalities and authored dialogue.
- Simulated congestion and road closures, fuel, refuelling, and vehicle upgrades.
- English and Traditional Chinese.
- No accounts or persistent saving in the prototype.

## Technical approach

### Python backend

Use FastAPI to serve the client, map assets, and game API from one origin.

- [app.py](app.py): request validation, HTTP endpoints, and static delivery.
- [game.py](game.py): in-memory sessions, orders, earnings, dialogue state,
  traffic events, fuel, refuelling, and upgrades.
- [roads.py](roads.py): metric geometry, road matching, directed routing, and
  turn restrictions.

Movement is animated in the browser. Send bounded movement checkpoints and
discrete commands to Python rather than a network request for every frame.
Validate command order and gameplay conditions; make retries idempotent so they
cannot pay a fare or purchase an upgrade twice.

On network failure, pause and offer explicit recovery. Sessions are in process
memory, so reloading starts a new shift and server restarts lose active sessions.
Use one worker and one instance for the prototype.

### Browser client

Use HTML/CSS and JavaScript with a single Canvas renderer for the map and taxi.

- [web/app.mjs](web/app.mjs): input, API coordination, dialogs, and gameplay UI.
- [web/map.mjs](web/map.mjs): road/building backdrop, camera, route, and taxi rendering.
- [web/physics.mjs](web/physics.mjs): fixed-step manual movement, reverse, connected
  road confinement, and boundary sliding.
- [web/i18n.mjs](web/i18n.mjs): bilingual interface strings.

Share road-class widths and a 2.5 m conservative taxi radius through the map API,
so rendering, browser physics, and backend validation use the same corridor model.
Share the speed cap and standard/tuned acceleration settings through the same API.
Cache the union of road-edge outlines in the backdrop to avoid internal segment
seams and additional per-frame geometry work.
Include intermediate positions in movement checkpoints to validate the travelled
path, not only its final point. Reverse geometry is explicitly marked and must not
become legal GPS routing data.

Keep simulation coordinates in metres. Provide keyboard-accessible junction
choices and touch controls without covering map attribution. Pause when the tab
loses visibility, and avoid movement jumps when it returns.

Canvas replaces the initially considered Leaflet-plus-overlay approach.
For this bounded district it avoids a runtime mapping dependency and external tiles.

### Map preparation

Use [tools/prepare_map.py](tools/prepare_map.py) to prepare a bounded OpenStreetMap
extract offline. Package the source extract and derived district database in
[data](data).

- Preserve road geometry, connectivity, direction, and bridge/tunnel/layer metadata.
- Parse supported node and ordered via-way turn restrictions.
- Do not join roads merely because their lines cross visually.
- Exclude unsuitable/private roads and disconnected components.
- Select reachable roadside game stops and a rest/refuelling point.
- Record unsupported restrictions and dataset versions explicitly.
- Do not fetch map data or geocode on each player's visit.

The importer uses Python's standard library and routing uses a heap-based graph
search, replacing the initially considered OSMnx/NetworkX dependency stack.

## Map licensing

Use OpenStreetMap rather than extracted Google Maps content.
Build an original GPS-style interface without copying Google branding or assets.

Display OpenStreetMap attribution and the ODbL notice. Offer downloads of the
source extract and adapted database, and keep OSM-derived data separate from
original game code and passenger content.
The game includes a [map data licence page](web/data-license.html).

Free map data does not imply unlimited free tile hosting. The prototype serves
its own district backdrop and does not scrape or bulk-download public map tiles.

## Delivery stages and acceptance gates

| Stage | Work | Acceptance gate |
|---|---|---|
| 1. Foundation | Python app, browser shell, API contracts, rules, tests, setup documentation | New sessions load; invalid commands fail explicitly |
| 2. District data | Bounded extract, backdrop, graph, restrictions, roadside stops | Stops are reachable; grade-separated roads stay distinct; no live map API needed during play |
| 3. Driving slice | Manual controls, reverse, road confinement, warnings, exit highlights, stacked-road choices, GPS route | Full taxi footprint stays on connected roads; choices never steer; ordinary junctions do not pause; unconnected crossings never switch levels |
| 4. Passenger loop | Accept, drive to pickup, stop, collect, drive, stop, complete, earn | A complete trip succeeds; invalid or duplicate completion cannot pay |
| 5. Passenger content | Bilingual personalities and scripted dialogue | Appropriate dialogue appears without blocking driving |
| 6. Traffic and closures | Congestion affects speed/routing; closures affect exits and reachability | Routes update; blocked destinations produce explicit recovery/cancellation choices |
| 7. Fuel and upgrades | Movement-based fuel, refuelling, purchases, empty-fuel recovery | No paused fuel drain, remote refuelling, negative balances, or duplicate charges |
| 8. Validation and delivery | Rule/physics/browser tests, performance measurements, deployment documentation | Local flows pass; unverified platforms and deferred public hosting are disclosed |

### Dependencies

- Foundation precedes district preparation and driving.
- District data and driving precede the passenger loop.
- The passenger loop precedes dialogue and traffic.
- Passenger earnings and traffic/movement integration precede fuel and upgrades.
- Validate each playable stage; final local verification covers the expanded prototype.

## Publishing approach

Publish later as one HTTPS Python service serving both the client and data.
A static-only host cannot run the backend. An optional
[Dockerfile](Dockerfile) and provider-independent instructions are included in
[README.md](README.md).

Before public release:

1. Choose a hosting provider and confirm its current costs and resource limits.
2. Configure a single worker/instance and the provider's required port.
3. Verify health, map delivery, and a complete trip through the public URL.
4. Test real phone browsers, including Safari where relevant.
5. Review attribution, distributed data, and licence obligations for that release.

No cloud account, domain, or paid service is part of the current local delivery.

## Boundaries and risks

- Approximate class-based road corridors, not surveyed kerbs, realistic lanes,
  or full vehicle physics. The readable icon is separate from the collision footprint.
- No collisions with buildings, vehicles, or pedestrians, or physical traffic-light simulation.
- Dense junctions and stacked roads can remain ambiguous. Recovery must stay available.
- Closely spaced OSM nodes can appear as separate junctions; further junction
  grouping is a possible refinement, not a completed feature.
- No guarantee of real navigation accuracy or complete local/time-dependent taxi rules.
- No multiplayer, competitive anti-cheat, live traffic feeds, paid AI dialogue,
  accounts, or persistent saves.
- Expansion beyond the district requires more data, audits, and asset partitioning.
- Phone emulation does not certify physical phone performance.
- Stacked-road detection uses branch lookahead bounded by 100 m/the next fork;
  incomplete level, bridge, or tunnel tags can cause missed choices.

## Sources

- [Google Maps Platform terms](https://cloud.google.com/maps-platform/terms)
- [OpenStreetMap copyright and ODbL overview](https://www.openstreetmap.org/copyright)
- [OSM public tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
