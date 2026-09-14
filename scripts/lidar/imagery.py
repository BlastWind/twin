"""Per-point RGB sampled from public orthoimagery XYZ tiles.

Default source is VGIN's VBMP statewide orthoimagery, which is what the web
app's raster basemap draws. Tiles are cached on disk, so a re-run of a chunk
costs no imagery bandwidth.
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import requests
from PIL import Image

TILE_PX = 256
#: VGIN's VBMP "most recent imagery" cache — the same service the web app's
#: raster basemap uses (`web/src/map/imagery.ts`), so a point's colour matches
#: the imagery underneath it. An ArcGIS cached MapServer in EPSG:3857 with the
#: standard top-left origin, i.e. XYZ with the row and column transposed.
DEFAULT_TEMPLATE = (
    "https://vginmaps.vdem.virginia.gov/arcgis/rest/services/"
    "VBMP_Imagery/MostRecentImagery_WGS/MapServer/tile/{z}/{y}/{x}"
)
#: Mid-grey stand-in where a tile is missing, so a hole never reads as black.
FALLBACK_RGB = (140, 140, 140)


@dataclass(frozen=True)
class ImagerySource:
    template: str = os.environ.get("TWIN_IMAGERY_TEMPLATE", DEFAULT_TEMPLATE)
    zoom: int = 17
    cache_dir: Path = Path("data/raw/imagery")

    def url(self, z: int, x: int, y: int) -> str:
        return self.template.format(z=z, x=x, y=y)


def _tile_xy(lon: np.ndarray, lat: np.ndarray, z: int) -> tuple[np.ndarray, np.ndarray]:
    """Fractional slippy-tile coordinates."""
    n = 1 << z
    fx = (lon + 180.0) / 360.0 * n
    rad = np.radians(lat)
    fy = (1.0 - np.log(np.tan(rad) + 1.0 / np.cos(rad)) / math.pi) / 2.0 * n
    return fx, fy


class TileCache:
    def __init__(self, session: requests.Session, source: ImagerySource):
        self._session = session
        self._source = source
        self._mem: dict[tuple[int, int, int], np.ndarray | None] = {}
        source.cache_dir.mkdir(parents=True, exist_ok=True)

    def _path(self, z: int, x: int, y: int) -> Path:
        return self._source.cache_dir / f"{z}_{x}_{y}.jpg"

    def get(self, z: int, x: int, y: int) -> np.ndarray | None:
        hit = self._mem.get((z, x, y), "miss")
        if hit != "miss":
            return hit  # type: ignore[return-value]
        path = self._path(z, x, y)
        if not path.exists():
            try:
                raw = self._session.get(self._source.url(z, x, y), timeout=60)
                raw.raise_for_status()
                path.write_bytes(raw.content)
            except Exception:
                self._mem[(z, x, y)] = None
                return None
        try:
            arr = np.asarray(Image.open(path).convert("RGB"), dtype=np.uint8)
        except Exception:
            path.unlink(missing_ok=True)
            arr = None
        self._mem[(z, x, y)] = arr
        return arr


def sample_rgb(cache: TileCache, source: ImagerySource, lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    """Nearest-pixel RGB for every point; `u8[N, 3]`."""
    out = np.empty((lon.size, 3), dtype=np.uint8)
    out[:] = FALLBACK_RGB
    z = source.zoom
    fx, fy = _tile_xy(lon, lat, z)
    tx, ty = np.floor(fx).astype(np.int64), np.floor(fy).astype(np.int64)
    px = np.clip(((fx - tx) * TILE_PX).astype(np.int64), 0, TILE_PX - 1)
    py = np.clip(((fy - ty) * TILE_PX).astype(np.int64), 0, TILE_PX - 1)

    order = np.lexsort((tx, ty))
    tiles = np.stack([tx[order], ty[order]], axis=1)
    bounds = np.flatnonzero(np.any(tiles[1:] != tiles[:-1], axis=1)) + 1
    for group in np.split(order, bounds):
        if group.size == 0:
            continue
        img = cache.get(z, int(tx[group[0]]), int(ty[group[0]]))
        if img is None:
            continue
        out[group] = img[py[group], px[group]]
    return out
