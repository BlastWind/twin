# Existing tools survey (2026-09-13)

Verdict key: **(a)** use directly · **(b)** borrow component · **(c)** learn only.

## Headline

No existing project is a "browser digital twin of a city with what-if traffic sim in Rust/WASM." Closest:

1. **A/B Street** (Rust, WASM, real what-if sim). Frozen since Jan 2025, bespoke UI, not a data twin.
2. **a-b-street/ltn + od2net** (Rust→WASM + MapLibre + Svelte). Live, closest architectural template. Routing-based flow estimation, not equilibrium assignment; no 3D, no transit.
3. **2025-26 Cesium/deck.gl "digital twin" repos** (stl-digital-twin, nus-digital-twin, mumbai-urban-digital-twin, Delhi real-time sim). JS-only, live feeds, toy sims.

There is **no Rust/WASM static traffic assignment crate**. Nearest pieces: `cch` / `fast_paths` for shortest paths, `od2net` for OD→flows (all-or-nothing). BPR + Frank-Wolfe on top is a few hundred lines; AequilibraE is the reference to port.

## 1. City digital twin platforms

| Name | URL | License | Stack | Activity | Verdict |
|---|---|---|---|---|---|
| A/B Street | github.com/a-b-street/abstreet | Apache-2.0 | Rust native+WASM, own renderer | v0.3.49 Jan 2025, effectively frozen | (b) map_model / osm2streets importer, sim crates |
| ltn, od2net, severance_snape, osm2streets | github.com/a-b-street/* | Apache-2.0 | Rust→WASM, Svelte, MapLibre | 2025-26 active | (b) architecture template; od2net = naive assignment |
| DTCC Platform | github.com/dtcc-platform | MIT | Python/C++ | May 2025 | (c) desktop, not browser |
| Digital Twin City Viewer | github.com/paramountric/digitaltwincityviewer | MIT | TS, deck.gl/MapLibre | stale 2024 | (c) |
| digital-twin-toolbox | github.com/geosolutions-it/digital-twin-toolbox | OSS (unverified) | Python/Node, 3D Tiles | 2024-25 | (b) only if we want 3D Tiles |
| PLATEAU | github.com/Project-PLATEAU | MIT/Apache | CesiumJS, CityGML | 2025 | (c) Japan data, CityGML |
| VC Map | cesium.com blog 2025-12 | MIT | Cesium + OpenLayers | 2025 | (c) |
| CityScope | github.com/CityScope | MIT | Python/JS | 2023-24 | (c) interaction ideas |
| UrbanSim | github.com/UDST/urbansim | BSD-3 | Python | low | (c) |
| Streetmix | github.com/streetmix/streetmix | AGPL-3.0 | TS/React | 2025 | (c) lane-editing UX |
| Snap4City | snap4city.org | AGPL/Apache | Java/PHP/Node, Cesium | 2026 | (c) heavy |
| Cesium twin MVPs (stl, nus, mumbai, Delhi sim) | github.com | MIT | Cesium/deck.gl + React | 2025-26 | (c) |

## 2. Traffic what-if / assignment / routing

| Name | URL | License | Stack | Verdict |
|---|---|---|---|---|
| AequilibraE | github.com/AequilibraE/aequilibrae | MIT | Python/Cython | (c) reference BFW/FW + BPR to port |
| SimWrapper | github.com/matsim-vsp/simwrapper | GPL-3.0 | Vue, deck.gl | (c) flow/trajectory viz patterns |
| MATSim | matsim.org | GPL-2.0 | Java | (c) |
| SUMO | eclipse.dev/sumo | EPL-2.0 | C++ | (c) offline ground truth |
| Conveyal R5 | github.com/conveyal/r5 | MIT | Java | (c) scenario JSON schema for transit edits |
| OpenTripPlanner 2 | github.com/opentripplanner/OpenTripPlanner | LGPL-3.0 | Java | (a) only if a JVM backend is acceptable |
| osmix | github.com/conveyal/osmix | MIT | TS, workers | (b) in-browser OSM |
| fast_paths | github.com/easbar/fast_paths | MIT | Rust, WASM-proven | (a) CH; rebuild per weight change is costly |
| cch | github.com/Rodeapps/cch | MIT | Pure Rust | (a) customizable CH: recustomize per FW iteration. Verify WASM build |
| osm4routing2 | github.com/rust-transit/osm4routing2 | MIT | Rust | (b) OSM→edge list |
| routx | github.com/MKuranowski/routx | MIT | Rust | (b) |
| osm2streets | github.com/a-b-street/osm2streets | Apache-2.0 | Rust→WASM | (b) lane-level geometry |
| Valhalla | github.com/valhalla/valhalla | MIT | C++ | (c) tiled graph + dynamic costing model |
| Citybound | github.com/citybound/citybound | AGPL-3.0 | Rust | dead 2020, (c) |

## 3. Rendering / data plumbing

| Name | License | Status | Verdict |
|---|---|---|---|
| PMTiles / Protomaps | BSD-3 | active 2026, MapLibre plugin | (a) |
| MapLibre GL JS | BSD-3 | v6, MLT format Jan 2026 | (a) fill-extrusion with Overture height/num_floors |
| deck.gl | MIT | v9, `@deck.gl/maplibre` interleaved | (a) |
| Planetiler | Apache-2.0 | v0.9.x | (a) OSM extract → PMTiles in seconds |
| tilemaker | FTL | maintained | (a) alternative |
| Overture Maps | CDLA-P-2.0 / ODbL | monthly, GeoParquet + PMTiles | (a) `overturemaps download --bbox=-77.34,38.83,-77.28,38.87 -t building` / `-t segment` |
| gtfs-structures | MIT | maintained | (a) Rust GTFS parsing |
| transit_model (Hove) | AGPL-3.0 | maintained | (c) license |

## 4. Fairfax data sources

| Source | URL | Format |
|---|---|---|
| City of Fairfax GeoHub (parcels, zoning, streets, addresses) | https://data-cityoffairfax.opendata.arcgis.com/ (e.g. `datasets/CityofFairfax::city-of-fairfax-zoning`) | GeoJSON, Shapefile, FeatureServer |
| Fairfax County GIS Open Data (surrounds the City, does not cover it) | https://data-fairfaxcountygis.opendata.arcgis.com/ ; REST https://www.fairfaxcounty.gov/mercator/rest/services/OpenData/OpenData_A9/MapServer | GeoJSON, FGDB, REST |
| VDOT traffic volume AADT 2022-2025 | https://data.virginia.gov/dataset/vdot-bidirectional-traffic-volume-2025 ; FeatureServer https://services.arcgis.com/p5v98VHDX9Atv3l7/arcgis/rest/services/VDOT_Traffic_Volume_2024/FeatureServer/0 | Shapefile, CSV, REST |
| VDOT crash data (TREDS, updated Jun 2026) | https://virginiaroads-vdot.opendata.arcgis.com/ ; https://data.virginia.gov/dataset/crashdata-basic | CSV, GeoJSON, REST |
| CUE bus GTFS | https://www.fairfaxva.gov/files/assets/city/v/2/public-works/documents/schedules-and-maps/cue-gtfs.zip (transit.land f-dqcj1-fairfaxcue) | GTFS zip, no RT |
| Fairfax Connector GTFS + RT | https://www.fairfaxcounty.gov/connector/sites/connector/files/Assets/connector_gtfs.zip ; RT https://www.fairfaxcounty.gov/gtfsrt | GTFS zip, GTFS-RT |
| WMATA GTFS | https://api.wmata.com/gtfs/bus-gtfs-static.zip , rail-gtfs-static.zip (key from developer.wmata.com) | GTFS zip |
| DRPT GTFS clearinghouse | https://drpt.virginia.gov/data/gtfs-feed-clearinghouse/ | links |
| LEHD LODES 8.4 (2020 blocks, through 2023) | https://lehd.ces.census.gov/data/lodes/LODES8/va/od/ (`va_od_main_JT00_2023.csv.gz`) | gzip CSV |
| Building permits, City | Accela portal only, no bulk export. **Gap.** | HTML |
| Building permits, County | https://data-fairfaxcountygis.opendata.arcgis.com/datasets/Fairfaxcountygis::building-records-plus | polygons |
| 311, City | No open dataset found. **Gap.** | — |

## Recommended composition

Overture + Planetiler → PMTiles. MapLibre v6 + deck.gl for extrusions and flows. osm4routing2 or osm2streets for graph extraction. `cch` (or `fast_paths`) plus hand-written BPR/Frank-Wolfe in `twin-core`, ported from AequilibraE. gtfs-structures for CUE/Connector/WMATA. LODES OD as demand seed, VDOT AADT as calibration targets.

## To verify before building

- `cch` compiles to wasm32.
- A/B Street LICENSE file.
- Exact City GeoHub layer list (catalogue fetch returned page chrome only).
- Whether Overture buildings for Fairfax carry heights, or fall back to OSM `building:levels`.
