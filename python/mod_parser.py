"""
MOD file parser for the Amiga ProTracker format.
Spec: https://www.eblong.com/zarf/blorb/mod-spec.txt
"""

import struct
from dataclasses import dataclass, field
from typing import List, Optional

import numpy as np


@dataclass
class SampleInfo:
    name: str
    length: int         # in bytes
    finetune: int       # signed -8 to +7
    volume: int         # 0-64
    loop_start: int     # in bytes
    loop_len: int       # in bytes
    data: bytes = field(default_factory=bytes)
    data_float: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.float32))

    @property
    def loop_end(self) -> int:
        return self.loop_start + self.loop_len

    @property
    def has_loop(self) -> bool:
        return self.loop_len > 2


@dataclass
class Note:
    sample_num: int   # 1-31 (0 = no sample)
    period: int       # 0 = no note
    effect_cmd: int   # 0x0-0xF
    effect_data: int  # 0x00-0xFF


@dataclass
class Pattern:
    rows: List[List[Note]]  # 64 rows × num_channels notes


@dataclass
class ModFile:
    title: str
    num_channels: int
    samples: List[Optional[SampleInfo]]  # index 0 is a sentinel; samples are 1-indexed
    song_length: int
    restart_pos: int
    pattern_table: List[int]   # 128 entries (0-127), each is a pattern index
    patterns: List[Pattern]


def parse_mod(filename: str) -> ModFile:
    with open(filename, 'rb') as f:
        data = f.read()

    title = data[0:20].rstrip(b'\x00').decode('latin-1', errors='replace')

    # Parse 31 sample headers (offset 20, 30 bytes each)
    samples: List[Optional[SampleInfo]] = [None]  # index 0 unused; 1-indexed
    for i in range(31):
        off = 20 + i * 30
        name = data[off:off + 22].rstrip(b'\x00').decode('latin-1', errors='replace')
        length = struct.unpack_from('>H', data, off + 22)[0] * 2   # words → bytes
        finetune_raw = data[off + 24] & 0x0F
        finetune = finetune_raw if finetune_raw < 8 else finetune_raw - 16
        volume = min(64, data[off + 25])
        loop_start = struct.unpack_from('>H', data, off + 26)[0] * 2
        loop_len = struct.unpack_from('>H', data, off + 28)[0] * 2
        samples.append(SampleInfo(
            name=name, length=length, finetune=finetune,
            volume=volume, loop_start=loop_start, loop_len=loop_len,
        ))

    song_length = data[950]
    restart_pos = data[951]
    pattern_table = list(data[952:1080])

    # Identify channel count from the 4-byte tag at offset 1080
    tag = data[1080:1084]
    if tag in (b'M.K.', b'M!K!', b'4CHN', b'FLT4'):
        num_channels = 4
    elif tag == b'6CHN':
        num_channels = 6
    elif tag in (b'8CHN', b'FLT8', b'OCTA'):
        num_channels = 8
    else:
        # Older 15-sample format has no tag; default to 4 channels
        num_channels = 4

    num_patterns = max(pattern_table[:song_length]) + 1

    offset = 1084
    patterns: List[Pattern] = []
    for _ in range(num_patterns):
        rows = []
        for _row in range(64):
            notes = []
            for _ch in range(num_channels):
                b = data[offset:offset + 4]
                offset += 4
                sample_num = (b[0] & 0xF0) | (b[2] >> 4)
                period = ((b[0] & 0x0F) << 8) | b[1]
                effect_cmd = b[2] & 0x0F
                effect_data = b[3]
                notes.append(Note(sample_num, period, effect_cmd, effect_data))
            rows.append(notes)
        patterns.append(Pattern(rows=rows))

    # Load PCM sample data (signed 8-bit)
    for i in range(1, 32):
        s = samples[i]
        raw = data[offset:offset + s.length]
        offset += s.length
        if len(raw) < s.length:
            raw = raw + bytes(s.length - len(raw))
        s.data = raw
        # Pre-convert to float32 [-1, 1] for fast mixing
        s.data_float = np.frombuffer(raw, dtype=np.int8).astype(np.float32) / 128.0

    return ModFile(
        title=title,
        num_channels=num_channels,
        samples=samples,
        song_length=song_length,
        restart_pos=restart_pos,
        pattern_table=pattern_table,
        patterns=patterns,
    )
