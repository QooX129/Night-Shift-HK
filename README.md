# Night Shift HK

A single-player browser taxi game set on OpenStreetMap roads in Mong Kok and
Yau Ma Tei. Drive in 3D or 2D, take dispatch orders or street hails, and earn
simulated fares. The game is not a navigation tool.

## Run locally

Python 3.11 or newer is required. Run these commands from the project directory.

Windows (PowerShell):

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8000
```

macOS / Linux:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

Open <http://127.0.0.1:8000>. Preparing pedestrian paths at startup can take
several seconds. Stop the server with Ctrl+C. Restart it and refresh the page
after changing code or data.

Map data, JavaScript libraries and visual assets are packaged locally; playing
does not require map keys, external tiles or live geocoding. The 3D view requires
WebGL 2; if it fails, the game reports the error and falls back to 2D.

## Play

| Control | Action |
|---|---|
| W / Up | Accelerate |
| S / Down | Brake; hold after stopping to reverse |
| A / D or Left / Right | Steer |
| Space | Handbrake; steer at speed to drift |
| P | Open or close the dispatch phone |
| E | Open the door for a street hail or drop off a passenger |
| Tab | Toggle the trip panel |
| M | Open or close the map |
| Esc | Close the map or toggle pause |

Touch steering and pedals are available on phones. In 3D, hold the right mouse
button and drag to orbit. Use Settings to switch between 2D and 3D, and the map
tools to open the map or zoom.

- Accept a phone offer and stop at its green pickup marker; the passenger
  boards automatically. Street hails appear in normal 3D driving view; stop
  alongside and use the door. Stop at the yellow destination marker and drop
  off the passenger. One phone pickup can wait while another passenger is aboard.
- The meter uses an arcade adaptation of Hong Kong urban taxi fares. Phone
  booking, large luggage and animals add extras; tunnel fees are not simulated.
  Fares and pickup locations are not suitable for real-world use.
- Routes are suggestions, but GPS routing follows the packaged road directions
  and supported turn restrictions. Wrong-way driving and restricted turns
  remain possible with warnings. Closed roads block entry; traffic and closures
  are simulated, not live.
- The taxi is confined to connected road corridors. Road-edge contact can slow
  or slide it; disconnected flyovers cannot be crossed between levels. If stuck
  or out of fuel, pause and choose **Return to rest stop**. Refuel or buy
  upgrades at the blue rest stop. The arcade speed cap is 160 km/h before
  traffic and slope limits; it is not a real vehicle specification or speed limit.
- Settings are available from the welcome and pause menus. They include view,
  graphics, camera, controls, minimap, language and the junction selector.
  The selector is off by default. When enabled it pauses at qualifying junctions
  and queues an exit; selection aligns the taxi at the junction. Keyboard
  direction keys preview choices and releasing them confirms the selection.
  When a direction has multiple exits, hold its key and use a side key to
  select a branch; on larger groups, tap the side key to cycle.

The default view is 3D and the interface supports English and Traditional
Chinese. Preferences are stored in the browser; shift progress is not saved.
Reloading starts a new shift, and restarting the server clears active sessions.

## Map and elevation

The packaged data includes the road graph, buildings, parks, named places,
transport locations, road widths and elevation. The browser receives the road
graph at startup and streams visual chunks as needed. The map popup and minimap
share the chunk cache; chunk download errors are shown and retried.

Widths, road boundaries, markings, most road elevations and tunnel clearances
are estimates, not surveyed geometry or legal guidance. The elevation package
also includes a government-model-derived pilot at Yau Ma Tei Interchange; its
vertical alignment is estimated. See [elevation sources](data/ELEVATION-SOURCES.md)
and the in-game [data licence page](web/data-license.html) for provenance,
attribution and limitations. OpenStreetMap data and government data have
separate terms.

### Rebuild the data

These are preparation commands, not necessary for normal play. Install
`requirements-map.txt` in the virtual environment before rebuilding elevation.
Commands below assume the environment is active.

```sh
python -m pip install -r requirements-map.txt
python -X utf8 tools/prepare_map.py
python -X utf8 tools/prepare_elevation.py
```

`prepare_map.py` rebuilds the district graph, road widths and places from the
existing `data/source.osm.json`. Use `python -X utf8 tools/prepare_map.py --download`
to replace that extract with a fresh bounded download. `prepare_elevation.py`
reuses the retained district DTM; add `--refresh` to download new DTM samples.
Rebuild elevation after changing the map. The following optional commands refresh
the official pilot or the separate transport snapshot, both using network access:

```sh
python -X utf8 tools/prepare_pilot.py
python -X utf8 tools/prepare_transport.py
```

`tools/prepare_places.py` and `tools/prepare_road_widths.py` can rebuild those
individual derived packages from the existing source. UTF-8 mode makes source
text decoding consistent on Windows. Review dataset versions, provenance and
attribution after refreshing; restart the server and reload the page. A fresh
OSM download may differ from the checked-in supplemented extract.

## Tests

Install the Python development dependencies in the same `.venv` used to run
the app. JavaScript and browser tests require Node.js and npm:

```sh
python -m pip install -r requirements-dev.txt
python -X utf8 -m unittest discover -s tests -p "test_*.py" -v
npm ci
npm test
npx playwright install chromium
npm run test:browser
```

Activate `.venv` before running the Python commands, or invoke its Python
executable directly as shown above. Playwright starts its own server on port
8765 using the project `.venv` and tests desktop and phone-emulated Chromium.
Emulation does not validate physical phones or Safari. Failure traces and
screenshots in `test-results/` are generated artifacts, not game assets.

Known failures observed during the documentation cleanup:

- The Python speed-cap test expects 150 km/h, while the current cap is 160 km/h.
- Two JavaScript tests fail: boundary drag and the junction-selector default.
- The desktop and phone start/garage browser test can time out because the open
  dispatch phone intercepts the garage button. Browser performance and map
  chunk timing also depend on the machine and test load.

The checked-in Three.js and polygon-clipping files let the runtime work without
Node.js. `npm ci` runs `tools/vendor-three.mjs` to refresh vendored files from
the locked dependencies; retain their licences when updating them.

## Deployment

The backend and static client must be served together; a static-only host is
insufficient. The Dockerfile listens on port 8000 or the `PORT` environment
variable:

```sh
docker build -t night-shift-hk .
docker run --rm -p 8000:8000 night-shift-hk
```

For a Python host, install `requirements.txt` and start
`python -m uvicorn app:app --host 0.0.0.0 --port 8000`, substituting the
provider's port. Deploy all runtime Python modules, the complete `data/` and
`web/` directories, including vendored libraries and licences. Use one worker
and one instance: sessions live in process memory. Before publishing, enable
HTTPS, check `/api/health`, play a complete trip and review data licence
obligations and hosting costs. No public deployment is configured.

## Project layout

- `app.py`: FastAPI endpoints, validation and static delivery.
- `game.py`, `pedestrians.py`: sessions, fares, orders, citizens and simulation.
- `roads.py`, `elevation.py`, `tunnel_clearance.py`: routing and road geometry.
- `map_streaming.py`: visual map chunk generation.
- `web/`: interface, 2D and 3D renderers, physics, translations and local libraries.
- `data/`: packaged source and derived map data, elevation and provenance.
- `tools/`: offline data preparation and library vendoring.
- `tests/`: Python, JavaScript and Playwright regression tests.
- [PLAN.md](PLAN.md) and [PROCESS.md](PROCESS.md): historical scope and
  development record; earlier decisions and test counts are not current status.

## Limitations

This is a local prototype, not a production navigation or multiplayer service.
Roads, stop eligibility, scenery and physical behavior are approximations; OSM
tags and local restrictions may be incomplete or outdated. There are no
persistent shifts, live traffic feeds or realistic vehicle, building and
pedestrian collisions. Coverage is limited to the packaged district. Hardware,
browser and hosting performance vary; physical-device and deployment validation
must be performed for the intended environment.
