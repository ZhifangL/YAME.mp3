"""Shared pytest fixtures.

Audio files are generated on the fly so the suite never depends on the
sample folders (and never writes to them). WAV is produced with the standard
library and tagged by mutagen through the same ID3 adapter that MP3 uses, so
the I/O tests exercise a real read/write cycle with no binary fixtures.
"""
from __future__ import annotations

import struct
import wave
import zlib
from pathlib import Path

import pytest


def _tone(path: Path, seconds: float = 0.05, rate: int = 8000) -> None:
    """Write a small, valid mono 16-bit PCM WAV file."""
    frames = int(seconds * rate)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(b"".join(struct.pack("<h", (i * 37) % 2000 - 1000) for i in range(frames)))


@pytest.fixture
def audio_file(tmp_path: Path) -> Path:
    """A taggable audio file (WAV + ID3, the same adapter path as MP3)."""
    target = tmp_path / "song.wav"
    _tone(target)
    return target


def _png_chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


@pytest.fixture(scope="session")
def png_bytes() -> bytes:
    """A minimal valid 2x2 PNG."""
    header = struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0)
    raw = b"".join(b"\x00" + b"\xff\x00\x00" * 2 for _ in range(2))
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", header)
        + _png_chunk(b"IDAT", zlib.compress(raw))
        + _png_chunk(b"IEND", b"")
    )
