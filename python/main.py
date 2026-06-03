#!/usr/bin/env python3
"""
MOD Player — command-line Amiga ProTracker module player.
Usage: python3 main.py <file.mod>
"""

import sys
import time

import numpy as np
import sounddevice as sd

from python.mod_parser import parse_mod
from python.player_engine import ModPlayer, OUTPUT_RATE

BLOCK_SIZE = 1024   # frames per audio callback


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 main.py <file.mod>")
        sys.exit(1)

    filename = sys.argv[1]
    print(f"Loading {filename}...")
    mod = parse_mod(filename)

    print(f"\n  Title    : {mod.title}")
    print(f"  Channels : {mod.num_channels}")
    print(f"  Samples  : {sum(1 for s in mod.samples[1:] if s and s.length > 0)}")
    print(f"  Patterns : {len(mod.patterns)}")
    print(f"  Length   : {mod.song_length} positions")
    print()

    # Print sample names so the user can see what's in the module
    for i, s in enumerate(mod.samples[1:], 1):
        if s and s.name.strip():
            print(f"  Sample {i:2d}: {s.name}")
    print()

    player = ModPlayer(mod)

    last_display = [-1, -1]

    def callback(outdata: np.ndarray, frames: int, time_info, status):
        audio = player.render(frames)
        outdata[:] = audio

        # Throttled progress display (only when position changes)
        sp = player.song_pos
        rw = player.row
        if sp != last_display[0] or rw != last_display[1]:
            last_display[0] = sp
            last_display[1] = rw
            pat = mod.pattern_table[sp] if sp < len(mod.pattern_table) else 0
            print(
                f"\r  Pos {sp:3d}/{mod.song_length}  "
                f"Pat {pat:3d}  Row {rw:2d}  "
                f"BPM {player.bpm:3d}  Spd {player.speed}   ",
                end='', flush=True,
            )

    print("Playing — press Ctrl+C to stop\n")
    with sd.OutputStream(
        samplerate=OUTPUT_RATE,
        channels=2,
        dtype='float32',
        blocksize=BLOCK_SIZE,
        callback=callback,
    ):
        try:
            while True:
                time.sleep(0.1)
        except KeyboardInterrupt:
            print("\n\nStopped.")


if __name__ == '__main__':
    main()
