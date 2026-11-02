# Offline elevation provenance

Audited 2026-11-02. Coverage remains the existing Mong Kok / Yau Ma Tei district.
`elevation.json` records source URLs, hashes, datum, per-building quality, source
model profile nodes and the pilot's unmodified source-model heights.

## Government sources and terms

© Hong Kong SAR Government, Lands Department, DATA.GOV.HK.

- [Official 5 m DTM description](https://data.gov.hk/en-data/dataset/hk-landsd-openmap-5m-grid-dtm)
  explicitly gives **±5 m accuracy**, includes elevated roads/bridges, and depicts
  vegetation height. It is not bare earth. The published
  [ASC ZIP](https://www.landsd.gov.hk/landsd_psi_data/SMO/data/Whole_HK_DTM_5m.zip)
  contains one 302 MB ASC compressed to 28.7 MB. The importer streams compressed
  ranges, discards out-of-district rows, and resamples the district to a 10 m
  rendering grid in the game's metric coordinates via HK1980 / EPSG:2326.
  The retained `dtm` is source-derived; the lower-envelope `terrain` is an estimate.
- [CSDI 3D Spatial Data API](https://portal.csdi.gov.hk/csdi-webpage/apidoc/3d-spatial-data-api)
  documents freely available WGS84 Cesium 3D Tiles for **building** and
  **infrastructure**. Both root metadata endpoints were inspected. The public
  documentation example key is a public access example, not a private credential.
  `prepare_pilot.py` retrieves infrastructure tile `F_Tile_+3_1_0+R0_67.b3dm`,
  extracts glTF triangles, applies the official root ECEF translation/Y-up
  conversion, clips a 200 m square, and tests disconnected OSM bridge/ground
  intersections against the official surface triangles.
- The resulting pilot is **Yau Ma Tei Interchange over Hoi Wang Road** near
  22.312°N, 114.16485°E. R0 is the highest-detail published tile, not a survey
  certification. Source-model relative profiles are applied to covered bridge
  nodes; vertical alignment with the estimated district road datum is explicitly
  estimated, and grades are limited for the arcade simulation. Raw source-model
  ellipsoidal heights remain separately recorded. Do not treat this alignment as
  a verified ellipsoid-to-Hong-Kong-Principal-Datum conversion.
- [3D-BIT00](https://data.gov.hk/en-data/dataset/hk-landsd-openmap-development-hkms-digital-3d-bit00)
  publishes building/infrastructure/terrain models in Max, 3ds, FBX and VRML.
  That bulk package is not downloaded: the bounded public infrastructure tile
  provides the pilot without a whole-city asset collection.

[DATA.GOV.HK terms](https://data.gov.hk/en/terms-and-conditions) and the
[3D API terms](https://portal.csdi.gov.hk/csdi-webpage/apidoc/3d-spatial-data-api)
permit browsing, downloading, reproduction and redistribution for commercial
and non-commercial use, conditional on source/IP attribution, compliance and
indemnity. Data are supplied as-is; the API also has a shared-bandwidth fair-use
policy. Government copyright and these terms remain applicable to the clipped
Government data; they are **not relicensed as ODbL or MIT**.

## OSM sources and estimates

© OpenStreetMap contributors, ODbL-1.0, retained bounded `source.osm.json`.
Building footprints are matched to original way IDs. `height` tags are used as
tagged real-world claims, **not independently verified measurements**.
`building:levels × 3.2 m` and the 18 m fallback are separate estimate categories.
No building's height is randomized in the elevation view.

Outside the pilot, road profiles are estimated from a 30 m neighborhood lower
envelope of the DTM plus 6 m per bridge/tunnel OSM layer. Shared graph-node
heights and grade-bounded propagation ensure continuous ramps, including reverse
edges. A single DTM cannot establish ground under a flyover: reconstructed ground
and underpass clearances must not be described as measured.
Matching also rejects overlapping fork surfaces differing by more than 0.35 m
at the car's centre; actual level changes must follow continuous shared-node ramps.
The same filter and endpoint/path slope speed budgets run in Python and JavaScript.
For grade `g` projected along the heading, gravity is
`9.81 × g / sqrt(1 + g²)` m/s² and the arcade speed cap is
`base maximum × (1 - 2 × min(0.12, |g|))`. Gravity does not turn pedal braking into
reverse; holding S still engages the existing low-speed reverse. A stationary
handbraked taxi does not roll downhill.

Bridge thickness 0.65 m and tunnel clearance 5 m are visual/game estimates.
`building_passage` stays at the connected road level but gets an interior shell.
Terrain is visually carved around estimated ground roads and faded in tunnels.
Cars use existing swept 2D road-corridor containment on their current surface;
unconnected crossings never authorize a level switch. Decks support the car by
surface constraint, not rigid-body simulation. Buildings/pillars are not surveyed
3D solid colliders. Some non-pilot clearances may still be inaccurate.

## Rollout and validation

The district-wide estimated preview is enabled with the existing **3D** switch.
Only the source-confirmed pilot is official-model-derived; expanding surveyed
road/building/tunnel coverage is not claimed complete. 2D presentation/settings
remain unchanged; the desired slope driving and server limits are shared.
No freeze-fix stage or discarded blocker/collider code is reinstated.

Focused tests cover equations, slopes/reverse headings, braking, node continuity,
source labels, pilot level separation, server speed rejection, rendered taxi and
guides, offline requests and a bounded renderer timing sample. Validation uses
isolated Playwright pages, never the user's live shift.
Terrain, road batches and instanced junction discs are spatially culled; the
elevated auto preset starts at 75% scene resolution, while HUD/minimap stay native.
Quality/performance preferences remain available. Comparative performance tests
use the same-machine legacy renderer as a baseline; software WebGL does not
guarantee the hardware reference's 24/55 FPS thresholds.
