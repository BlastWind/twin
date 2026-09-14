"""Entwine Point Tile (EPT) reader over plain HTTPS.

No PDAL: the public USGS 3DEP bucket stores laszip blobs plus a JSON octree
index, and `laspy` + `lazrs` decode a blob on their own. Everything here is a
pure function of the resource metadata except the two `fetch_*` calls.
"""

from __future__ import annotations

import io
import json
import math
from dataclasses import dataclass
from typing import Iterator

import laspy
import numpy as np
import requests

# --- domain types -----------------------------------------------------------

Metres = float
Deg = float
"""Web-Mercator (EPSG:3857) metres; the EPT resources we read are already in it."""
Mercator = float

BUCKET = "https://s3-us-west-2.amazonaws.com/usgs-lidar-public"
"""3DEP resource covering Northern Virginia, Fairfax County included."""
DEFAULT_RESOURCE = "VA_NorthernVA_1_B22"

EARTH_R: Metres = 6378137.0
MERC_MAX: Mercator = math.pi * EARTH_R

#: LAS classifications we keep. Ground, low/medium/high vegetation, building.
KEEP_CLASSES: tuple[int, ...] = (2, 3, 4, 5, 6)


@dataclass(frozen=True)
class Box3:
    """Axis-aligned box in EPT native units (mercator metres, z metres)."""

    xmin: float
    ymin: float
    zmin: float
    xmax: float
    ymax: float
    zmax: float

    @property
    def side(self) -> float:
        return self.xmax - self.xmin

    def overlaps_xy(self, other: "Box3") -> bool:
        return not (
            self.xmax <= other.xmin
            or self.xmin >= other.xmax
            or self.ymax <= other.ymin
            or self.ymin >= other.ymax
        )


@dataclass(frozen=True)
class NodeKey:
    d: int
    x: int
    y: int
    z: int

    def __str__(self) -> str:
        return f"{self.d}-{self.x}-{self.y}-{self.z}"

    def children(self) -> Iterator["NodeKey"]:
        for dx in (0, 1):
            for dy in (0, 1):
                for dz in (0, 1):
                    yield NodeKey(self.d + 1, self.x * 2 + dx, self.y * 2 + dy, self.z * 2 + dz)

    def bounds(self, root: Box3) -> Box3:
        step = root.side / (1 << self.d)
        return Box3(
            root.xmin + step * self.x,
            root.ymin + step * self.y,
            root.zmin + step * self.z,
            root.xmin + step * (self.x + 1),
            root.ymin + step * (self.y + 1),
            root.zmin + step * (self.z + 1),
        )


@dataclass(frozen=True)
class EptInfoDTO:
    """The fields of `ept.json` this pipeline uses; the rest is dropped."""

    resource: str
    bounds: Box3
    span: int
    points: int
    srs_epsg: int

    @property
    def base_url(self) -> str:
        return f"{BUCKET}/{self.resource}"

    def resolution_m(self, depth: int) -> Metres:
        """Nominal point spacing of the union of depths 0..depth."""
        return self.bounds.side / (self.span * (1 << depth))

    def depth_for_density(self, pts_per_m2: float) -> int:
        """Shallowest depth whose spacing is at least as fine as the target."""
        want = 1.0 / math.sqrt(pts_per_m2)
        return max(0, math.ceil(math.log2(self.bounds.side / (self.span * want))))


# --- projection (pure) ------------------------------------------------------


def lonlat_to_merc(lon: Deg, lat: Deg) -> tuple[Mercator, Mercator]:
    x = math.radians(lon) * EARTH_R
    y = math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * EARTH_R
    return x, y


def merc_to_lonlat(x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    lon = np.degrees(x / EARTH_R)
    lat = np.degrees(2.0 * np.arctan(np.exp(y / EARTH_R)) - math.pi / 2)
    return lon, lat


def merc_box(west: Deg, south: Deg, east: Deg, north: Deg) -> Box3:
    x0, y0 = lonlat_to_merc(west, south)
    x1, y1 = lonlat_to_merc(east, north)
    return Box3(x0, y0, -math.inf, x1, y1, math.inf)


# --- IO ---------------------------------------------------------------------


def fetch_info(session: requests.Session, resource: str = DEFAULT_RESOURCE) -> EptInfoDTO:
    raw = session.get(f"{BUCKET}/{resource}/ept.json", timeout=60)
    raw.raise_for_status()
    dto = raw.json()
    b = dto["bounds"]
    return EptInfoDTO(
        resource=resource,
        bounds=Box3(*[float(v) for v in b]),
        span=int(dto["span"]),
        points=int(dto["points"]),
        srs_epsg=int(dto["srs"]["horizontal"]),
    )


class Hierarchy:
    """Lazily paged octree index. `count(key)` is None for an absent node."""

    def __init__(self, session: requests.Session, info: EptInfoDTO):
        self._session = session
        self._info = info
        self._pages: dict[str, dict[str, int]] = {}
        self._counts: dict[str, int] = {}
        self._load_page("0-0-0-0")

    def _load_page(self, key: str) -> None:
        if key in self._pages:
            return
        url = f"{self._info.base_url}/ept-hierarchy/{key}.json"
        raw = self._session.get(url, timeout=120)
        raw.raise_for_status()
        page = raw.json()
        self._pages[key] = page
        self._counts.update(page)

    def count(self, key: NodeKey) -> int | None:
        n = self._counts.get(str(key))
        if n is None:
            return None
        if n == -1:  # pointer to a deeper page
            self._load_page(str(key))
            n = self._counts.get(str(key), 0)
            if n == -1:
                return 0
        return n

    def nodes_in(self, box: Box3, max_depth: int) -> list[tuple[NodeKey, int]]:
        """Every populated node overlapping `box` at depth <= max_depth."""
        root = self._info.bounds
        out: list[tuple[NodeKey, int]] = []
        stack = [NodeKey(0, 0, 0, 0)]
        while stack:
            key = stack.pop()
            if not key.bounds(root).overlaps_xy(box):
                continue
            n = self.count(key)
            if n is None or n == 0:
                continue
            out.append((key, n))
            if key.d < max_depth:
                stack.extend(key.children())
        return out


@dataclass(frozen=True)
class PointBatch:
    """Decoded, filtered points of one node. Columns are parallel arrays."""

    x: np.ndarray  # mercator metres
    y: np.ndarray  # mercator metres
    z: np.ndarray  # metres above the vertical datum
    cls: np.ndarray  # uint8 LAS classification

    def __len__(self) -> int:
        return int(self.x.size)


EMPTY = PointBatch(*(np.empty(0, dtype=t) for t in ("f8", "f8", "f8", "u1")))


def fetch_node(
    session: requests.Session, info: EptInfoDTO, key: NodeKey, box: Box3
) -> PointBatch:
    url = f"{info.base_url}/ept-data/{key}.laz"
    raw = session.get(url, timeout=180)
    if raw.status_code == 404:
        return EMPTY
    raw.raise_for_status()
    with laspy.open(io.BytesIO(raw.content)) as f:
        las = f.read()
    x, y, z = np.asarray(las.x), np.asarray(las.y), np.asarray(las.z)
    cls = np.asarray(las.classification).astype(np.uint8)
    keep = (
        (x >= box.xmin) & (x < box.xmax) & (y >= box.ymin) & (y < box.ymax)
    ) & np.isin(cls, KEEP_CLASSES)
    return PointBatch(x[keep], y[keep], z[keep], cls[keep])


def voxel_thin(batch: PointBatch, cell_m: Metres) -> PointBatch:
    """Keep one point per `cell_m` cube. Deterministic: the first in scan order."""
    if len(batch) == 0:
        return batch
    ix = np.floor(batch.x / cell_m).astype(np.int64)
    iy = np.floor(batch.y / cell_m).astype(np.int64)
    iz = np.floor(batch.z / cell_m).astype(np.int64)
    keys = np.stack([ix, iy, iz], axis=1)
    _, first = np.unique(keys, axis=0, return_index=True)
    first.sort()
    return PointBatch(batch.x[first], batch.y[first], batch.z[first], batch.cls[first])


def concat(batches: list[PointBatch]) -> PointBatch:
    live = [b for b in batches if len(b) > 0]
    if not live:
        return EMPTY
    return PointBatch(*(np.concatenate([getattr(b, f) for b in live]) for f in ("x", "y", "z", "cls")))
