# twin-web

Vite + React + MapLibre + deck.gl client. `pnpm dev`, `pnpm test`, `pnpm bench`.

## Imagery basemap

**Endpoint (dev):** `/imagery/{z}/{x}/{y}`, proxied by `vite.config.ts` to

```
https://vginmaps.vdem.virginia.gov/arcgis/rest/services/VBMP_Imagery/MostRecentImagery_WGS/MapServer/tile/{z}/{y}/{x}
```

VGIN's VBMP "most recent imagery" service — Virginia Base Mapping Program
orthoimagery, spring 2022/2023/2025 whichever is newest per area, true colour,
~1 ft ground sample distance. It is an ArcGIS **cached** MapServer
(`singleFusedMapCache: true`) in EPSG:3857 with 256 px tiles, the standard
top-left origin and 24 LODs, so the cache is an XYZ pyramid with the row and
column transposed. No `exportImage` and no bbox math are needed — the proxy rule
is one argument swap.

Verified: `GET .../tile/15/12540/9347` (Fairfax, -77.30/38.85, z15) → `200`,
`image/jpeg`, 256×256, 21 KB.

**License / attribution:** public Virginia government data, free to use with
credit. The map's attribution control carries
*"Imagery © Virginia Geographic Information Network (VBMP)"*, wired through the
raster source's `attribution` in `buildStyle`.

**Why proxy at all in dev:** the app is cross-origin isolated for threaded wasm
(`Cross-Origin-Embedder-Policy: require-corp`) and the VGIN host sends neither
`Access-Control-Allow-Origin` nor `Cross-Origin-Resource-Policy`, so a direct
raster source would have every tile refused by the browser. The proxy makes the
tiles same-origin.

**Production plan:** do not proxy. Pre-render the county once and serve raster
PMTiles from our own origin next to `world.pmtiles`:

```
gdalwarp -t_srs EPSG:3857 ...            # VBMP GeoTIFFs, county clip
gdal2tiles.py --xyz -z 10-16 --processes 8 ...
pmtiles convert tiles/ imagery.pmtiles   # or: rio pmtiles
```

Estimated size, Fairfax County (1,051 km²), JPEG q75 256 px tiles:

| z | tiles | size |
|---|------:|-----:|
| 10–13 | ~96 | 2.6 MB |
| 14 | 290 | 7.9 MB |
| 15 | 1,159 | 22.6 MB |
| 16 | 4,634 | 90.5 MB |
| **total z10–z16** | **~6,180** | **~124 MB** |

z17 would add ~360 MB and is not worth it: VBMP's native resolution runs out
around z16–17 anyway. One archive, HTTP range requests, no per-tile origin.

## LiDAR point cloud

`data/build/lidar/chunk_{x}_{y}.bin` (produced by the pipeline, Phase 4
contract): the standard header + section table, sections `90` xyz `f32[N*3]`
(lon, lat, height m), `91` rgb `u8[N*3]`, `92` classification `u8[N]`, plus
`lidar/index.json` mapping each chunk to its byte count, point count and
`ground_min`. Decoder: `src/lidar/schema.ts`. Chunks intersecting the viewport
are loaded at z ≥ 16 through a dedicated `AssetLoader` with a 300 MB byte budget
and drawn by `LidarOverlay` with deck.gl's `PointCloudLayer`; out-of-view chunks
are dropped. Heights are rendered relative to each chunk's `ground_min` so a
flat (terrain-less) map does not float the cloud.

`public/data/lidar` is a symlink to `../../../data/build/lidar` when the
pipeline output exists; `pnpm fixture:lidar` writes a small synthetic chunk set
there instead when it does not.

### Roof shapes

Skipped. The vector tiles carry no `roof:shape` attribute (`world.pmtiles`
`building` layer has `height`, `render_height`, `min_height`,
`building:levels`), so roof geometry would mean a pipeline change, which belongs
to the tile build and not to `web/`.
