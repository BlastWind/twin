#!/usr/bin/env python3
"""Build `data/build/lidar/chunk_{x}_{y}.bin` from USGS 3DEP EPT + orthoimagery.

Resumable: one output file plus one sidecar per chunk, and a chunk whose sidecar
is present is skipped unless `--force`. Parallel: chunks across processes, EPT
node fetches across threads inside each one.

    python scripts/lidar/build.py --center -77.30 38.85 --ring 1
    python scripts/lidar/build.py --all --jobs 8
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))

import ept  # noqa: E402
import imagery  # noqa: E402
from encode import encode_chunk  # noqa: E402

BUILD_DIR = Path("data/build")
OUT_DIR = BUILD_DIR / "lidar"
META_DIR = OUT_DIR / "_meta"

#: Points buffered before the running batch is re-thinned. Two million is about
#: 50 MB of float64 columns, so several chunk workers stay well inside 8 GB.
COMPACT_AT = 2_000_000

HEIGHT_REF = (
    "xyz.z is orthometric height in metres above NAVD88 as delivered by USGS 3DEP "
    "(EPT vertical units are metres); subtract the chunk's ground_min for a "
    "height-above-local-ground rendering."
)


# --- grid -------------------------------------------------------------------


@dataclass(frozen=True)
class GridDTO:
    """The `grid` block of `manifest.json`, which mirrors `twin_core::GridSchema`."""

    cols: int
    rows: int
    cell_lon_deg: float
    cell_lat_deg: float
    min_lon: float
    min_lat: float

    @staticmethod
    def load(path: Path) -> "GridDTO":
        g = json.loads(path.read_text())["grid"]
        return GridDTO(
            int(g["cols"]),
            int(g["rows"]),
            float(g["cell_lon_deg"]),
            float(g["cell_lat_deg"]),
            float(g["min_lon"]),
            float(g["min_lat"]),
        )

    def cell_xy(self, lon: float, lat: float) -> tuple[int, int]:
        cx = int(math.floor((lon - self.min_lon) / self.cell_lon_deg))
        cy = int(math.floor((lat - self.min_lat) / self.cell_lat_deg))
        return max(0, min(cx, self.cols - 1)), max(0, min(cy, self.rows - 1))

    def cell_bbox(self, cx: int, cy: int) -> tuple[float, float, float, float]:
        w = self.min_lon + cx * self.cell_lon_deg
        s = self.min_lat + cy * self.cell_lat_deg
        return w, s, w + self.cell_lon_deg, s + self.cell_lat_deg

    def chunk_id(self, cx: int, cy: int) -> int:
        return cy * self.cols + cx


ChunkXY = tuple[int, int]


def graph_chunks(build_dir: Path) -> list[ChunkXY]:
    """The chunks the road graph actually wrote; there is no point in lidar elsewhere."""
    out = []
    for p in sorted((build_dir / "graph").glob("chunk_*_*.bin")):
        x, y = p.stem.split("_")[1:3]
        out.append((int(x), int(y)))
    return out


# --- per-chunk work ---------------------------------------------------------


@dataclass(frozen=True)
class ChunkStatDTO:
    chunk: str
    id: int
    file: str
    bytes: int
    points: int
    ground_min: float | None
    nodes: int
    seconds: float


def _session() -> requests.Session:
    s = requests.Session()
    s.mount("https://", requests.adapters.HTTPAdapter(pool_maxsize=32, max_retries=3))
    return s


def build_chunk(
    cell: ChunkXY,
    grid: GridDTO,
    resource: str,
    pts_per_m2: float,
    zoom: int,
    threads: int,
    force: bool,
) -> ChunkStatDTO | None:
    cx, cy = cell
    name = f"chunk_{cx}_{cy}"
    sidecar = META_DIR / f"{name}.json"
    if sidecar.exists() and not force:
        return ChunkStatDTO(**json.loads(sidecar.read_text()))

    started = time.monotonic()
    session = _session()
    info = ept.fetch_info(session, resource)
    depth = info.depth_for_density(pts_per_m2)
    west, south, east, north = grid.cell_bbox(cx, cy)
    # Thinning happens in Web-Mercator metres, which are stretched by
    # 1/cos(lat) — 1.28 at this latitude. Divide the cell through by the same
    # factor so `pts_per_m2` means points per square metre of ground.
    mid_lat = math.radians(0.5 * (south + north))
    cell_m = (1.0 / math.sqrt(pts_per_m2)) / math.cos(mid_lat)

    box = ept.merc_box(west, south, east, north)
    nodes = ept.Hierarchy(session, info).nodes_in(box, depth)
    origin = (box.xmin, box.ymin)

    # Thin inside the worker: a deep node can hold a million points and only one
    # per cell survives, so the peak is a node rather than a chunk.
    def fetch_thinned(key: ept.NodeKey) -> ept.PointBatch:
        return ept.surface_thin(ept.fetch_node(session, info, key, box), cell_m, origin)

    # Fold the arriving nodes into one running batch whenever the backlog grows
    # past COMPACT_AT. Holding all ~800 nodes of a chunk and then thinning once
    # peaks at several GB and the box has 8; thinning is idempotent on the same
    # voxel grid, so folding early costs nothing but the extra sorts.
    kept = ept.EMPTY
    pending: list[ept.PointBatch] = []
    backlog = 0
    with ThreadPoolExecutor(max_workers=threads) as pool:
        futures = [pool.submit(fetch_thinned, key) for key, _ in nodes]
        for fut in as_completed(futures):
            batch = fut.result()
            pending.append(batch)
            backlog += len(batch)
            if backlog >= COMPACT_AT:
                kept = ept.surface_thin(ept.concat([kept, *pending]), cell_m, origin)
                pending, backlog = [], 0
    thinned = ept.surface_thin(ept.concat([kept, *pending]), cell_m, origin)
    del kept, pending

    lon, lat = ept.merc_to_lonlat(thinned.x, thinned.y)
    height = thinned.z.astype(np.float32)
    source = imagery.ImagerySource(zoom=zoom)
    rgb = imagery.sample_rgb(imagery.TileCache(session, source), source, lon, lat)

    blob = encode_chunk(lon, lat, height, rgb, thinned.cls)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    META_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / f"{name}.bin").write_bytes(blob)

    ground = thinned.z[thinned.cls == 2]
    stat = ChunkStatDTO(
        chunk=f"{cx}_{cy}",
        id=grid.chunk_id(cx, cy),
        file=f"lidar/{name}.bin",
        bytes=len(blob),
        points=int(lon.size),
        ground_min=round(float(ground.min()), 3) if ground.size else None,
        nodes=len(nodes),
        seconds=round(time.monotonic() - started, 2),
    )
    sidecar.write_text(json.dumps(asdict(stat)))
    return stat


# --- index ------------------------------------------------------------------


def write_index(grid: GridDTO, resource: str, pts_per_m2: float, zoom: int) -> dict:
    chunks = {}
    for p in sorted(META_DIR.glob("chunk_*.json")):
        s = json.loads(p.read_text())
        if not (OUT_DIR / Path(s["file"]).name).exists():
            continue
        chunks[s["chunk"]] = {
            "id": s["id"],
            "file": s["file"],
            "bytes": s["bytes"],
            "points": s["points"],
            "ground_min": s["ground_min"],
        }
    index = {
        "version": 1,
        "magic": "TWLD",
        "sections": {"xyz": 90, "rgb": 91, "class": 92},
        "source": {
            "ept_resource": resource,
            "bucket": ept.BUCKET,
            "imagery": imagery.ImagerySource(zoom=zoom).template,
            "imagery_zoom": zoom,
            "license": "USGS 3DEP: public domain. VBMP imagery: VGIN/VDEM, credit required.",
        },
        "pts_per_m2": pts_per_m2,
        "classes_kept": list(ept.KEEP_CLASSES),
        "height_ref": HEIGHT_REF,
        "grid": asdict(grid),
        "totals": {
            "chunks": len(chunks),
            "points": sum(c["points"] for c in chunks.values()),
            "bytes": sum(c["bytes"] for c in chunks.values()),
        },
        "chunks": chunks,
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "index.json").write_text(json.dumps(index, indent=1))
    return index


# --- cli --------------------------------------------------------------------


def select_cells(args: argparse.Namespace, grid: GridDTO) -> list[ChunkXY]:
    known = set(graph_chunks(BUILD_DIR))
    if args.all:
        return sorted(known)
    cx, cy = grid.cell_xy(args.center[0], args.center[1])
    r = args.ring
    wanted = [
        (x, y)
        for y in range(cy - r, cy + r + 1)
        for x in range(cx - r, cx + r + 1)
        if 0 <= x < grid.cols and 0 <= y < grid.rows
    ]
    return [c for c in wanted if c in known] or wanted


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--center", nargs=2, type=float, default=[-77.30, 38.85], metavar=("LON", "LAT"))
    ap.add_argument("--ring", type=int, default=1, help="ring radius; 1 = 3x3 block")
    ap.add_argument("--all", action="store_true", help="every chunk the road graph has")
    ap.add_argument("--resource", default=ept.DEFAULT_RESOURCE)
    ap.add_argument("--pts-per-m2", type=float, default=1.0)
    ap.add_argument("--zoom", type=int, default=17, help="imagery tile zoom")
    ap.add_argument("--jobs", type=int, default=4, help="chunks in parallel")
    ap.add_argument("--threads", type=int, default=8, help="EPT fetches per chunk")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--index-only", action="store_true")
    args = ap.parse_args()

    grid = GridDTO.load(BUILD_DIR / "manifest.json")
    if args.index_only:
        idx = write_index(grid, args.resource, args.pts_per_m2, args.zoom)
        print(json.dumps(idx["totals"]))
        return 0

    cells = select_cells(args, grid)
    print(f"{len(cells)} chunk(s); resource={args.resource} density={args.pts_per_m2}/m2", flush=True)
    done = 0
    with ProcessPoolExecutor(max_workers=args.jobs) as pool:
        futures = {
            pool.submit(
                build_chunk, c, grid, args.resource, args.pts_per_m2, args.zoom, args.threads, args.force
            ): c
            for c in cells
        }
        for fut in as_completed(futures):
            cell = futures[fut]
            done += 1
            try:
                s = fut.result()
            except Exception as exc:  # one bad chunk must not sink the run
                print(f"[{done}/{len(cells)}] chunk_{cell[0]}_{cell[1]} FAILED: {exc}", flush=True)
                continue
            print(
                f"[{done}/{len(cells)}] chunk_{s.chunk}: {s.points} pts, "
                f"{s.bytes / 1e6:.1f} MB, {s.nodes} nodes, {s.seconds}s",
                flush=True,
            )
    idx = write_index(grid, args.resource, args.pts_per_m2, args.zoom)
    print(json.dumps(idx["totals"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
