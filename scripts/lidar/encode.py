"""Binary encoder for `lidar/chunk_{x}_{y}.bin`.

Byte-for-byte the layout `twin_core::schema::FileWriter` produces: a 16-byte
header, a table of 24-byte section entries, then 8-byte-aligned payloads.
`crates/twin-pipeline/src/lidar.rs` decodes what this writes, and its unit test
is the proof the two stay in step.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

import numpy as np

SECTION_ALIGN = 8
MAGIC_LIDAR = b"TWLD"
VERSION_LIDAR = 1

SectionKind = int
KIND_XYZ: SectionKind = 90
KIND_RGB: SectionKind = 91
KIND_CLASS: SectionKind = 92

_HEADER = struct.Struct("<4sIII")
_SECTION = struct.Struct("<IIIIQ")


def _align_up(n: int) -> int:
    return -(-n // SECTION_ALIGN) * SECTION_ALIGN


@dataclass(frozen=True)
class Section:
    kind: SectionKind
    elem_size: int
    length: int  # elements, not bytes
    payload: bytes


def write_file(sections: list[Section], magic: bytes, version: int, flags: int = 0) -> bytes:
    cursor = _align_up(_HEADER.size + _SECTION.size * len(sections))
    table = bytearray()
    offsets: list[int] = []
    for s in sections:
        offsets.append(cursor)
        table += _SECTION.pack(s.kind, s.elem_size, s.length, 0, cursor)
        cursor = _align_up(cursor + len(s.payload))

    out = bytearray(cursor)
    out[: _HEADER.size] = _HEADER.pack(magic, version, flags, len(sections))
    out[_HEADER.size : _HEADER.size + len(table)] = table
    for s, off in zip(sections, offsets):
        out[off : off + len(s.payload)] = s.payload
    return bytes(out)


def encode_chunk(
    lon: np.ndarray, lat: np.ndarray, height_m: np.ndarray, rgb: np.ndarray, cls: np.ndarray
) -> bytes:
    """`xyz: f32[N*3]` interleaved (lon, lat, height), `rgb: u8[N*3]`, `class: u8[N]`."""
    n = lon.size
    assert lat.size == n and height_m.size == n and cls.size == n and rgb.shape == (n, 3)
    xyz = np.empty((n, 3), dtype="<f4")
    xyz[:, 0] = lon
    xyz[:, 1] = lat
    xyz[:, 2] = height_m
    return write_file(
        [
            Section(KIND_XYZ, 4, n * 3, xyz.tobytes()),
            Section(KIND_RGB, 1, n * 3, np.ascontiguousarray(rgb, dtype=np.uint8).tobytes()),
            Section(KIND_CLASS, 1, n, np.ascontiguousarray(cls, dtype=np.uint8).tobytes()),
        ],
        MAGIC_LIDAR,
        VERSION_LIDAR,
    )
