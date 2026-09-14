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
- **Colour**: `USGSImageryOnly` XYZ tiles from `basemap.nationalmap.gov` at
  z17 (~1.1 m/px at this latitude), nearest-pixel per point. Override with
  `TWIN_IMAGERY_TEMPLATE` (an `{z}/{y}/{x}` template) to match whatever raster
  basemap the web app settles on.
- **Licence**: public domain. 3DEP and the USGS national orthoimagery mosaic
  are US Government works, no attribution required (crediting USGS is polite).

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
voxel size together; `--jobs` chunks in parallel, `--threads` EPT fetches
within a chunk; `--force` re-does chunks that already have a sidecar.

The run is **resumable**: each finished chunk writes
`data/build/lidar/_meta/chunk_x_y.json`, and a chunk with a sidecar is skipped.
Kill it and restart it freely. Imagery tiles are cached under
`data/raw/imagery/`, so a re-run costs no imagery bandwidth.

## Output

`data/build/lidar/chunk_{x}_{y}.bin`, in the same container as every other
binary (DESIGN.md section 5): a 16-byte header `TWLD`/version 1, a table of
24-byte section entries, then 8-byte-aligned payloads.

| kind | name  | element  | length |
|------|-------|----------|--------|
| 90   | xyz   | `f32`    | `3N` — interleaved lon, lat, height in metres |
| 91   | rgb   | `u8`     | `3N` |
| 92   | class | `u8`     | `N` — raw LAS classification |

Classifications kept: 2 ground, 3/4/5 low/medium/high vegetation, 6 building.
Everything else, noise (7, 18) included, is dropped at read time.

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

Measured on chunk 10 13 (Fairfax City, dense suburb, 2 km cell = 4.0 km²), 12
fetch threads on a home connection:

| pts/m² | EPT depth | nodes fetched | points | file | wall |
|--------|-----------|---------------|--------|------|------|
| 0.077  | 8         | 68            | 0.33 M | 5.2 MB   | 29 s |
| 1.0    | 10        | 747           | 6.48 M | 103.7 MB | 67 s |

Per chunk the file is **16 bytes a point** (12 xyz + 3 rgb + 1 class), so
`bytes ≈ 16 × area_m² × pts_per_m²`. Depth `d` costs roughly 4× the nodes and
4× the points of depth `d-1`, and one depth step is a factor 4 in density.

Extrapolating to the 469 graph chunks of the county:

| pts/m² | county points | county bytes | wall at `--jobs 3` |
|--------|---------------|--------------|--------------------|
| 1.0    | ~3.0 G        | ~48 GB       | ~3 h               |
| 0.25   | ~0.76 G       | ~12 GB       | ~1 h               |
| 0.077  | ~0.23 G       | ~3.7 GB      | ~25 min            |

A 104 MB chunk is more than a browser wants to hold: at 1 pt/m² a 3×3 viewport
is ~0.9 GB. If the point-cloud layer needs to stay inside a sane LRU, build the
county at `--pts-per-m2 0.25` (26 MB a chunk) or 0.077 (5 MB a chunk) and keep
1 pt/m² for the handful of chunks a demo flies over.

Everything under `data/` is gitignored; only this pipeline is committed.
