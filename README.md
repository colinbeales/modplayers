# MOD Player

A command-line Amiga ProTracker MOD file player implemented in three languages: Python, Go, and Rust, plus a browser UI for visual playback of MOD and WAV files.

## What is a MOD file?

MOD (or "module") files are a music format originating from the Amiga computer in the late 1980s. They contain:
- Up to 31 short PCM audio samples (instruments)
- A sequence of **patterns**, each with 64 rows of per-channel note/effect data
- A **song** that sequences patterns via a pattern table

The format was popularised by Karsten Obarski's *Ultimate Soundtracker* (1987) and refined by *ProTracker*. Thousands of MOD files are freely available at sites like [The Mod Archive](https://modarchive.org).

## Structure

```
modPlayer/
├── web/             # Browser ProTracker-style player and visualizer
│   ├── src/
│   │   ├── audio.ts
│   │   ├── main.ts
│   │   ├── mod.ts
│   │   └── styles.css
│   ├── index.html
│   └── package.json
├── python/          # Reference implementation
│   ├── main.py
│   ├── mod_parser.py
│   ├── player_engine.py
│   └── requirements.txt
├── go/              # Go port
│   ├── main.go
│   ├── mod_parser.go
│   ├── player_engine.go
│   ├── go.mod
│   └── go.sum
└── rust/            # Rust port
    ├── src/
    │   ├── main.rs
    │   ├── mod_parser.rs
    │   └── player_engine.rs
    └── Cargo.toml
```

## Running

### Browser UI

Requires Node.js 20+:

```bash
cd web
npm install
npm run dev
```

Open the local Vite URL and load or drag in a `.mod` or `.wav` file. The browser UI recreates the ProTracker main-screen playback dashboard with transport controls, song/pattern/row/timing readouts, quadratscope-style channel scopes, sample metadata, channel mute/solo controls, and a scrolling pattern grid for MOD files.

To create a production build:

```bash
cd web
npm run build
```

### Python

Requires Python 3.9+ and the dependencies in `requirements.txt`:

```bash
cd python
pip install -r requirements.txt
python3 main.py path/to/file.mod
```

### Go

Requires Go 1.21+:

```bash
cd go
go run . path/to/file.mod

# Or build a binary:
go build -o mod_player .
./mod_player path/to/file.mod
```

### Rust

Requires Rust (install via [rustup.rs](https://rustup.rs)):

```bash
cd rust
cargo run --release -- path/to/file.mod

# Or build a binary:
cargo build --release
./target/release/mod_player path/to/file.mod
```

> Use `--release` for the Rust build — the debug build may not render fast enough for real-time playback.

## Implementation details

### Playback model

All three implementations follow the original **Amiga CIA-timer tick model**:

- The song is divided into **rows**. Each row lasts `speed` ticks (default: 6).
- The tick rate is set by the BPM (default: 125 BPM → 882 samples/tick at 44 100 Hz).
- On **tick 0** of each row, notes are triggered and one-shot effects are applied.
- On **ticks 1–(speed−1)**, continuous effects (slides, vibrato, etc.) update channel state.
- Each tick's worth of samples is rendered and mixed before advancing to the next tick.

### Audio pipeline

| Language | Audio library | How bytes reach the hardware |
|----------|--------------|------------------------------|
| Python   | `sounddevice` | Callback-based; OS pulls `render()` from a background thread |
| Go       | `ebitengine/oto` | `ModReader` implements `io.Reader`; oto pulls bytes internally via CoreAudio / ALSA / WASAPI |
| Rust     | `cpal`        | Callback-based stream; OS calls the closure, which locks the player and calls `render()` |
| Browser  | Web Audio     | ScriptProcessor pulls rendered MOD frames from the TypeScript player; WAV files use native `decodeAudioData()` |

### Mixing and output

- **Sample rate:** 44 100 Hz stereo
- **Amiga hard-panning:** channels are hard-panned L–R–R–L (the original Amiga hardware had no stereo mixing)
- **Paula clock:** 7 093 789.2 Hz (PAL). The playback rate for each channel is `PAULA_CLOCK / (period × 2 × OUTPUT_RATE)`
- **Sample data:** signed 8-bit PCM, pre-converted to float32 `[−1, 1]` on load
- **Output clipped** to `[−1.0, 1.0]` after mixing

### Effects implemented

| Cmd | Effect |
|-----|--------|
| `0` | Arpeggio |
| `1` | Slide up |
| `2` | Slide down |
| `3` | Tone portamento |
| `4` | Vibrato |
| `5` | Tone portamento + volume slide |
| `6` | Vibrato + volume slide |
| `7` | Tremolo |
| `9` | Set sample offset |
| `B` | Position jump |
| `C` | Set volume |
| `D` | Pattern break |
| `E1` | Fine slide up |
| `E2` | Fine slide down |
| `E4` | Set vibrato waveform |
| `E5` | Set pattern loop point |
| `E6` | Pattern loop |
| `E7` | Set tremolo waveform |
| `E9` | Retrigger note |
| `EA` | Fine volume slide up |
| `EB` | Fine volume slide down |
| `EC` | Note cut |
| `ED` | Note delay |
| `EE` | Pattern delay |
| `F` | Set speed / BPM |

### Supported formats

Channel count is detected from the 4-byte tag at file offset 1080:

| Tag | Channels |
|-----|----------|
| `M.K.`, `M!K!`, `4CHN`, `FLT4` | 4 |
| `6CHN` | 6 |
| `8CHN`, `FLT8`, `OCTA` | 8 |
| *(no tag / unknown)* | 4 (legacy 15-sample format) |

## References

- [ProTracker MOD format spec](https://www.eblong.com/zarf/blorb/mod-spec.txt)
- [The Mod Archive](https://modarchive.org) — large collection of free MOD files
- [Amiga Hardware Reference Manual — Paula](https://amigadev.elowar.com/read/ADCD_2.1/Hardware_Manual_guide/node0060.html)
