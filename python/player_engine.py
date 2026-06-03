"""
ProTracker MOD player engine.

Tick-based engine that mirrors the original Amiga CIA-timer playback model:
  - speed  ticks per row (default 6)
  - bpm    sets the tick rate (default 125 BPM → 882 samples/tick @ 44100 Hz)
  - 4 channels mixed to stereo (Amiga hard-pan: L R R L)
"""

import math
from dataclasses import dataclass, field
from typing import Optional, List

import numpy as np

from python.mod_parser import ModFile, SampleInfo, Note

OUTPUT_RATE = 44100
PAULA_CLOCK = 7093789.2  # PAL Amiga

# Vibrato / tremolo sine table: 64 entries, range ≈ -255 … +255
SINE_TABLE = [round(255 * math.sin(math.pi * 2 * i / 64)) for i in range(64)]


def _wave_value(pos: int, waveform: int) -> int:
    """Return oscillator value (-255 … +255) for the given waveform and phase."""
    pos = pos & 63
    wf = waveform & 3
    if wf == 0:      # sine
        return SINE_TABLE[pos]
    elif wf == 1:    # ramp down: 255 at pos 0, linear to -249 at pos 63
        return 255 - pos * 8
    else:            # square
        return 255 if pos < 32 else -255


@dataclass
class Channel:
    # Sample playback
    sample: Optional[SampleInfo] = None
    pos: float = 0.0           # fractional sample position
    period: int = 0            # stored period (affected by slides etc.)
    effective_period: int = 0  # period used for rendering (vibrato etc. modify this)
    volume: int = 0            # stored volume 0-64
    effective_volume: int = 0  # volume used for rendering (tremolo modifies this)

    # Per-row effect state
    effect_cmd: int = 0
    effect_data: int = 0

    # Portamento (effects 3, 5)
    port_target: int = 0
    port_speed: int = 0

    # Vibrato (effects 4, 6)
    vib_speed: int = 0
    vib_depth: int = 0
    vib_pos: int = 0
    vib_waveform: int = 0   # 0-3: shape; 4-7: same shape but don't reset on new note

    # Tremolo (effect 7)
    trem_speed: int = 0
    trem_depth: int = 0
    trem_pos: int = 0
    trem_waveform: int = 0

    # Arpeggio: base period saved when a note starts
    arp_base_period: int = 0

    # Pattern loop (E5 / E6)
    loop_row: int = 0
    loop_count: int = 0

    # Note delay (ED)
    note_delay: int = 0
    delayed_note: Optional[Note] = None

    # Note cut tick (EC)
    note_cut_tick: int = -1

    # Retrig counter (E9)
    retrig_count: int = 0


class ModPlayer:
    def __init__(self, mod: ModFile):
        self.mod = mod
        self.channels: List[Channel] = [Channel() for _ in range(mod.num_channels)]

        # Playback position
        self.song_pos: int = 0     # index into pattern_table
        self.row: int = 0
        self.tick: int = 0         # current tick within row (0 … speed-1)

        # Timing
        self.speed: int = 6
        self.bpm: int = 125
        self.samples_per_tick: int = self._calc_spt(125)

        # How many samples of the current tick have been rendered
        self.tick_sample_pos: int = 0

        # Jump / break flags set by effects, applied at end of row
        self.jump_flag: bool = False
        self.jump_pos: int = -1
        self.break_row: int = -1

        # Pattern delay (EE effect): row lasts (1 + delay) × speed ticks
        self.pattern_delay: int = 0

        # Amiga hard panning: channels alternate L R R L (0-indexed)
        self._pan = [0, 1, 1, 0][:mod.num_channels]  # 0 = left, 1 = right

        # Process the very first row immediately so the first render() has notes
        self._process_row()
        self.tick = 1  # tick 0 already processed above

        self.finished: bool = False

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def render(self, n_frames: int) -> np.ndarray:
        """Return n_frames of stereo float32 audio in shape (n_frames, 2)."""
        output = np.zeros((n_frames, 2), dtype=np.float32)
        done = 0

        while done < n_frames:
            remaining_in_tick = self.samples_per_tick - self.tick_sample_pos
            to_render = min(n_frames - done, remaining_in_tick)

            for ch_idx, ch in enumerate(self.channels):
                samples = self._render_channel(ch, to_render)
                col = self._pan[ch_idx] if ch_idx < len(self._pan) else 0
                output[done:done + to_render, col] += samples

            done += to_render
            self.tick_sample_pos += to_render

            if self.tick_sample_pos >= self.samples_per_tick:
                self.tick_sample_pos = 0
                self._advance_tick()

        np.clip(output, -1.0, 1.0, out=output)
        return output

    # ------------------------------------------------------------------
    # Internal: tick / row advancement
    # ------------------------------------------------------------------

    def _calc_spt(self, bpm: int) -> int:
        """Samples per tick at the given BPM."""
        return max(1, round(OUTPUT_RATE * 2.5 / bpm))

    def _advance_tick(self):
        """Process one tick and advance the tick counter."""
        effective_speed = self.speed * (1 + self.pattern_delay)

        if self.tick == 0:
            self._process_row()
        else:
            tick_in_speed = self.tick % self.speed
            self._process_tick_effects(tick_in_speed)

        self.tick += 1

        if self.tick >= effective_speed:
            self.tick = 0
            self.pattern_delay = 0
            self._advance_position()

    def _advance_position(self):
        """Move to next row / pattern, honoring jump/break flags."""
        if self.jump_flag:
            self.jump_flag = False
            next_pos = self.jump_pos if self.jump_pos >= 0 else self.song_pos + 1
            next_row = self.break_row if self.break_row >= 0 else 0
            self.jump_pos = -1
            self.break_row = -1
            self.song_pos = next_pos % self.mod.song_length
            self.row = next_row
        else:
            self.row += 1
            if self.row >= 64:
                self.row = 0
                self.song_pos += 1
                if self.song_pos >= self.mod.song_length:
                    self.song_pos = self.mod.restart_pos % self.mod.song_length
                    self.finished = True

    # ------------------------------------------------------------------
    # Internal: row processing (tick 0)
    # ------------------------------------------------------------------

    def _process_row(self):
        pattern = self.mod.patterns[self.mod.pattern_table[self.song_pos]]
        notes = pattern.rows[self.row]

        for ch, note in zip(self.channels, notes):
            ch.note_cut_tick = -1
            ch.note_delay = 0
            ch.delayed_note = None
            ch.effect_cmd = note.effect_cmd
            ch.effect_data = note.effect_data

            # Note delay (EDx): postpone note trigger until tick x
            is_note_delay = (note.effect_cmd == 0xE and
                             (note.effect_data >> 4) == 0xD and
                             (note.effect_data & 0xF) > 0)
            if is_note_delay:
                ch.note_delay = note.effect_data & 0xF
                ch.delayed_note = note
            else:
                if note.period > 0 or note.sample_num > 0:
                    self._trigger_note(ch, note)

            self._process_tick0_effect(ch, note)
            # Sync effective period/volume for non-modulating effects
            if note.effect_cmd not in (0x4, 0x6, 0x7):
                ch.effective_period = ch.period
            if note.effect_cmd != 0x7:
                ch.effective_volume = ch.volume

    def _trigger_note(self, ch: Channel, note: Note):
        """Load sample and/or set period for a new note."""
        if note.sample_num > 0:
            s = self.mod.samples[note.sample_num]
            if s and s.length > 0:
                ch.sample = s
                ch.volume = s.volume
                ch.effective_volume = ch.volume

        if note.period > 0:
            if note.effect_cmd in (0x3, 0x5):
                # Tone portamento: set target but don't retrigger
                ch.port_target = note.period
                if note.effect_cmd == 0x3 and note.effect_data:
                    ch.port_speed = note.effect_data
            else:
                # Normal note trigger: apply finetune and reset position
                ft = ch.sample.finetune if ch.sample else 0
                if ft != 0:
                    ch.period = max(1, round(note.period * (2 ** (-ft / 96.0))))
                else:
                    ch.period = note.period
                ch.effective_period = ch.period
                ch.pos = 0.0
                ch.arp_base_period = ch.period
                if ch.vib_waveform < 4:
                    ch.vib_pos = 0
                if ch.trem_waveform < 4:
                    ch.trem_pos = 0

    def _process_tick0_effect(self, ch: Channel, note: Note):
        """Handle effects that fire once on tick 0."""
        cmd = note.effect_cmd
        data = note.effect_data
        x = (data >> 4) & 0xF
        y = data & 0xF

        if cmd == 0x4:  # Vibrato: update params
            if x:
                ch.vib_speed = x
            if y:
                ch.vib_depth = y
        elif cmd == 0x7:  # Tremolo: update params
            if x:
                ch.trem_speed = x
            if y:
                ch.trem_depth = y
        elif cmd == 0x9:  # Set sample offset
            ch.pos = data * 256.0
        elif cmd == 0xB:  # Position jump
            self.jump_pos = data
            self.jump_flag = True
        elif cmd == 0xC:  # Set volume
            ch.volume = min(64, data)
            ch.effective_volume = ch.volume
        elif cmd == 0xD:  # Pattern break (BCD row number)
            self.break_row = x * 10 + y
            if self.jump_pos < 0:
                self.jump_pos = self.song_pos + 1
            self.jump_flag = True
        elif cmd == 0xF:  # Set speed / BPM
            if data < 0x20:
                self.speed = max(1, data)
            else:
                self.bpm = data
                self.samples_per_tick = self._calc_spt(data)
        elif cmd == 0xE:
            sub = x
            val = y
            if sub == 0x1:    # Fine slide up
                ch.period = max(1, ch.period - val)
            elif sub == 0x2:  # Fine slide down
                ch.period = min(0xFFF, ch.period + val)
            elif sub == 0x4:  # Set vibrato waveform
                ch.vib_waveform = val
            elif sub == 0x5:  # Set loop point
                ch.loop_row = self.row
                ch.loop_count = 0
            elif sub == 0x6:  # Jump to loop
                if val == 0:
                    ch.loop_row = self.row
                    ch.loop_count = 0
                elif ch.loop_count == 0:
                    ch.loop_count = val
                    self.break_row = ch.loop_row
                    self.jump_pos = self.song_pos
                    self.jump_flag = True
                else:
                    ch.loop_count -= 1
                    if ch.loop_count > 0:
                        self.break_row = ch.loop_row
                        self.jump_pos = self.song_pos
                        self.jump_flag = True
            elif sub == 0x7:  # Set tremolo waveform
                ch.trem_waveform = val
            elif sub == 0x9:  # Retrig note (set interval)
                ch.retrig_count = val
            elif sub == 0xA:  # Fine volume slide up
                ch.volume = min(64, ch.volume + val)
                ch.effective_volume = ch.volume
            elif sub == 0xB:  # Fine volume slide down
                ch.volume = max(0, ch.volume - val)
                ch.effective_volume = ch.volume
            elif sub == 0xC:  # Note cut: save target tick
                ch.note_cut_tick = val
            elif sub == 0xD:  # Note delay handled above in _process_row
                pass
            elif sub == 0xE:  # Pattern delay
                self.pattern_delay = val

    # ------------------------------------------------------------------
    # Internal: ongoing effects (ticks 1..speed-1)
    # ------------------------------------------------------------------

    def _process_tick_effects(self, tick_in_speed: int):
        """Process per-tick continuous effects for all channels."""
        for ch in self.channels:
            self._process_channel_tick(ch, tick_in_speed)

    def _process_channel_tick(self, ch: Channel, tick: int):
        cmd = ch.effect_cmd
        data = ch.effect_data
        x = (data >> 4) & 0xF
        y = data & 0xF

        # Note cut
        if ch.note_cut_tick >= 0 and tick == ch.note_cut_tick:
            ch.volume = 0
            ch.effective_volume = 0

        # Note delay: trigger deferred note
        if ch.note_delay > 0 and tick == ch.note_delay and ch.delayed_note is not None:
            self._trigger_note(ch, ch.delayed_note)
            ch.effective_period = ch.period
            ch.effective_volume = ch.volume
            self._process_tick0_effect(ch, ch.delayed_note)
            ch.delayed_note = None
            ch.note_delay = 0

        if cmd == 0x0 and data != 0:   # Arpeggio
            phase = tick % 3
            if phase == 0:
                ch.effective_period = ch.arp_base_period
            elif phase == 1:
                ch.effective_period = max(1, round(ch.arp_base_period / (2 ** (x / 12.0))))
            else:
                ch.effective_period = max(1, round(ch.arp_base_period / (2 ** (y / 12.0))))

        elif cmd == 0x1:               # Slide up (lower period = higher pitch)
            ch.period = max(1, ch.period - data)
            ch.effective_period = ch.period

        elif cmd == 0x2:               # Slide down
            ch.period = min(0xFFF, ch.period + data)
            ch.effective_period = ch.period

        elif cmd == 0x3:               # Tone portamento
            if ch.port_target and ch.period:
                if ch.period < ch.port_target:
                    ch.period = min(ch.port_target, ch.period + ch.port_speed)
                else:
                    ch.period = max(ch.port_target, ch.period - ch.port_speed)
            ch.effective_period = ch.period

        elif cmd == 0x4:               # Vibrato
            ch.vib_pos = (ch.vib_pos + ch.vib_speed) & 63
            delta = (_wave_value(ch.vib_pos, ch.vib_waveform) * ch.vib_depth) >> 7
            ch.effective_period = max(1, ch.period + delta)

        elif cmd == 0x5:               # Tone portamento + volume slide
            if ch.port_target and ch.period:
                if ch.period < ch.port_target:
                    ch.period = min(ch.port_target, ch.period + ch.port_speed)
                else:
                    ch.period = max(ch.port_target, ch.period - ch.port_speed)
            ch.effective_period = ch.period
            self._do_volume_slide(ch, data)

        elif cmd == 0x6:               # Vibrato + volume slide
            ch.vib_pos = (ch.vib_pos + ch.vib_speed) & 63
            delta = (_wave_value(ch.vib_pos, ch.vib_waveform) * ch.vib_depth) >> 7
            ch.effective_period = max(1, ch.period + delta)
            self._do_volume_slide(ch, data)

        elif cmd == 0x7:               # Tremolo
            ch.trem_pos = (ch.trem_pos + ch.trem_speed) & 63
            delta = (_wave_value(ch.trem_pos, ch.trem_waveform) * ch.trem_depth) >> 6
            ch.effective_volume = max(0, min(64, ch.volume + delta))

        elif cmd == 0xA:               # Volume slide
            self._do_volume_slide(ch, data)

        elif cmd == 0xE:
            sub = x
            val = y
            if sub == 0x9 and ch.retrig_count > 0:   # Retrig note
                if tick % ch.retrig_count == 0:
                    ch.pos = 0.0

    def _do_volume_slide(self, ch: Channel, data: int):
        x = (data >> 4) & 0xF
        y = data & 0xF
        if x:
            ch.volume = min(64, ch.volume + x)
        elif y:
            ch.volume = max(0, ch.volume - y)
        ch.effective_volume = ch.volume

    # ------------------------------------------------------------------
    # Internal: per-channel audio rendering
    # ------------------------------------------------------------------

    def _render_channel(self, ch: Channel, n: int) -> np.ndarray:
        """Render n samples for one channel; returns float32 array."""
        if (ch.sample is None or ch.effective_period == 0
                or len(ch.sample.data_float) == 0):
            return np.zeros(n, dtype=np.float32)

        data = ch.sample.data_float
        slen = len(data)
        rate = PAULA_CLOCK / (ch.effective_period * 2.0 * OUTPUT_RATE)
        volume = ch.effective_volume / 64.0

        has_loop = ch.sample.has_loop
        loop_start = ch.sample.loop_start
        loop_end = min(ch.sample.loop_end, slen)
        loop_len = loop_end - loop_start if has_loop and loop_end > loop_start else 0

        out = np.zeros(n, dtype=np.float32)
        pos = ch.pos

        for i in range(n):
            ipos = int(pos)
            if ipos >= slen:
                break
            out[i] = data[ipos] * volume
            pos += rate
            if has_loop and loop_len > 0 and pos >= loop_end:
                pos -= loop_len

        ch.pos = pos
        return out
