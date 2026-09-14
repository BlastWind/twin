# LiDAR chunks (Phase 4)

Point clouds for the 3-D basemap: USGS 3DEP returns, thinned to the graph grid,
coloured from national orthoimagery, written one binary per graph chunk.

## Source

- **Points**: USGS 3DEP via the public Entwine bucket,
  `https://s3-us-west-2.amazonaws.com/usgs-lidar-public/VA_NorthernVA_1_B22/`.
  That resource is 73.1 billion points and its conforming bounds
  (EPSG:3857 `-8678854, 4650340 .. -8575033, 4768403`) cover the whole Fairfax
  County bbox in `manifest.json`. The two neighbouring resources
  (`VA_NorthernVA_2_B22`, `_3_B22`) are further south and are not needed.
- **Colour**: VGIN's VBMP "most recent imagery" cache at z17 (~1.1 m/px here),
  nearest-pixel per point — the same service the web app's raster basemap uses
  (`web/src/map/imagery.ts`), so a point matches the imagery under it. Override
  with `TWIN_IMAGERY_TEMPLATE` (a `{z}/{y}/{x}` template).
- **Licence**: 3DEP is public domain (US Government work). VBMP imagery is
  public Virginia government data, free to use with credit to VGIN/VDEM; the
  web app carries that attribution in its MapLibre control.

No PDAL. EPT is a JSON octree over laszip blobs, so `requests` + `laspy`
(`lazrs` backend) reads it directly, which avoids a native GDAL/PDAL build.

## Running

```sh
python3 -m venv .venv-lidar
.venv-lidar/bin/pip install laspy lazrs numpy requests Pillow

# the 3x3 block around Fairfax City, the default centre
.venv-lidar/bin/python scripts/lidar/build.py --ring 1

# every chunk the road graph wrote (469 of them)
.venv-lidar/bin/python scripts/lidar/build.py --all --jobs 3

# rebuild only lidar/index.json from the per-chunk sidecars
.venv-lidar/bin/python scripts/lidar/build.py --index-only

# fold the index into data/build/manifest.json
cargo run -p twin-pipeline -- attach-lidar
```

Flags worth knowing: `--pts-per-m2` (default 1.0) picks the EPT depth and the
cell size together; `--jobs` chunks in parallel, `--threads` EPT fetches
within a chunk; `--force` re-does chunks that already have a sidecar.

The run is **resumable**: each finished chunk writes
`data/build/lidar/_meta/chunk_x_y.json`, and a chunk with a sidecar is skipped.
Kill it and restart it freely. Imagery tiles are cached under
`data/raw/imagery/`, so a re-run costs no imagery bandwidth.

## Output

`data/build/lidar/chunk_{x}_{y}.bin`, in the same container as every other
binary (DESIGN.md section 5): a 16-byte header `TWLD`/version 1, a table of
24-byte section entries, then 8-byte-aligned payloads.

| kind | name  | element  | elem_size | len |
|------|-------|----------|-----------|-----|
| 90   | xyz   | `[f32;3]` — lon, lat, height in metres | 12 | `N` |
| 91   | rgb   | `[u8;3]`  | 3 | `N` |
| 92   | class | `u8` — raw LAS classification | 1 | `N` |

`elem_size` is the record width, as it is for `node_lonlat: [f32;2]` in the
graph chunks, so the payload is `3N` floats and `3N` colour bytes.

Thinning keeps the **highest return per cell**, so a chunk is a digital surface
model at the requested density: roofs, canopy tops, and bare ground where
nothing is above it. The cell is sized in ground metres — Web-Mercator metres
run 1.28 short of a real metre at this latitude, and not dividing that out
inflates the density by 1.6x. A 3-D voxel thin was tried first and is wrong for this
data — canopy fills a column of 1 m voxels, so "1 pt/m²" came out at 4 pt/m²
and 265 MB a chunk, nearly all of it interior canopy no top-down view shows.

Classifications kept: 1 unclassified, 2 ground, 3/4/5 vegetation, 6 building,
9 water. Noise (7, 18) and the withheld/overlap classes are dropped at read
time.

Class 1 is kept because this delivery needs it: it classifies ground,
building, water and noise and leaves everything else at 1. A sample depth-10
node over Fairfax City is 41 % class 1, 48 % ground, 11 % building, 0.1 %
noise, and has no 3/4/5 at all — so filtering to the nominal vegetation
classes would delete every tree. Points that read as vegetation therefore
arrive labelled 1, and a renderer colouring by class should treat 1 as
"everything above ground that is not a building".

`lon`/`lat` are `f32` as the contract specifies, which quantises position to
about 0.4 m at this longitude. That is below the 1 m voxel, but a renderer that
wants exact positions should read the doubles from EPT itself.

**Height reference.** `xyz.z` is orthometric height in metres above NAVD88, as
delivered by 3DEP — not a height above ground. `index.json` records
`ground_min` per chunk (the lowest class-2 return) so a viewer can subtract a
local datum; the same sentence is in the index's `height_ref` field and is
copied into the manifest's `lidar` block.

`data/build/lidar/index.json`:

```json
{"version":1,"magic":"TWLD","sections":{"xyz":90,"rgb":91,"class":92},
 "source":{...},"pts_per_m2":1.0,"height_ref":"...","grid":{...},
 "totals":{"chunks":9,"points":0,"bytes":0},
 "chunks":{"10_13":{"id":296,"file":"lidar/chunk_10_13.bin",
                    "bytes":103730352,"points":6483141,"ground_min":58.2}}}
```

`crates/twin-pipeline/src/lidar.rs` decodes this container in Rust and its unit
test reads a produced chunk, so the Python encoder and the Rust reader cannot
drift apart. The test skips when `data/build/lidar/` is empty.

## Cost model

Measured on chunk 10 13 (Fairfax City, dense suburb; the grid cell is 2 km of
ground on a side, 4.0 km²), ten fetch threads on a home connection:

| pts/m² | EPT depth | nodes fetched | points | file | wall |
|--------|-----------|---------------|--------|------|------|
| 0.077  | 8         | 68            | 0.33 M | 5.2 MB  | 29 s |
| 1.0    | 10        | 747           | 3.99 M | 63.9 MB | 37 s |

The 3×3 block around Fairfax City (chunks 9..11 × 12..14) at 1 pt/m², three
chunks at a time with ten fetch threads each: **35,893,769 points,
574,301,192 bytes, about 3 minutes wall**; 3.98–4.00 M points and 63.6–64.0 MB
a chunk, 37–60 s a chunk. Composition is 61 % class 1 (canopy and everything
else unclassified), 26 % ground, 12 % building.

The file is **16 bytes a point** (12 xyz + 3 rgb + 1 class) and the thin puts
exactly one point in each ground square metre, so
`bytes ≈ 16 × area_m² × pts_per_m²` — 64 MB for a 2 km cell at 1 pt/m², and a
quarter of that per step down in density. Fetch cost does not fall as fast:
EPT depth `d` holds ~4× the points of `d-1`, so halving the linear density
saves one depth level, i.e. about 4× the nodes.

Extrapolating to the 469 graph chunks of the county:

| pts/m² | county points | county bytes | wall at `--jobs 3` |
|--------|---------------|--------------|--------------------|
| 1.0    | ~1.9 G        | ~30 GB       | ~2 h 15 m          |
| 0.25   | ~0.47 G       | ~7.5 GB      | ~40 min            |
| 0.077  | ~0.14 G       | ~2.3 GB      | ~20 min            |

A 64 MB chunk is a lot for a browser: `web/src/lidar/viewport.ts` holds a
300 MB budget, which is four or five of them, so a wide view at z16 will drop
chunks. If the layer needs a bigger footprint on screen, rebuild at
`--pts-per-m2 0.25` (16 MB a chunk) and keep 1 pt/m² for the chunks a demo
flies over.

Memory, not bandwidth, is what limits `--jobs`: a worker peaks around 1.5 GB
while it folds a chunk together, so three at a time is the ceiling on an 8 GB
box and the run gets OOM-killed at five.

Everything under `data/` is gitignored; only this pipeline is committed.
