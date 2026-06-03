/// ProTracker MOD player engine.
///
/// Tick-based engine that mirrors the original Amiga CIA-timer playback model:
///   - speed  ticks per row (default 6)
///   - bpm    sets the tick rate (default 125 BPM → 882 samples/tick @ 44100 Hz)
///   - 4 channels mixed to stereo (Amiga hard-pan: L R R L)
use crate::mod_parser::{ModFile, Note};

pub const OUTPUT_RATE: f64 = 44100.0;
const PAULA_CLOCK: f64 = 7_093_789.2; // PAL Amiga

// Vibrato / tremolo sine table: 64 entries computed via round(255 * sin(2π * i / 64))
static SINE_TABLE: [i32; 64] = [
    0, 25, 50, 74, 98, 120, 142, 162,
    180, 197, 212, 225, 236, 244, 250, 254,
    255, 254, 250, 244, 236, 225, 212, 197,
    180, 162, 142, 120, 98, 74, 50, 25,
    0, -25, -50, -74, -98, -120, -142, -162,
    -180, -197, -212, -225, -236, -244, -250, -254,
    -255, -254, -250, -244, -236, -225, -212, -197,
    -180, -162, -142, -120, -98, -74, -50, -25,
];

fn wave_value(pos: i32, waveform: u8) -> i32 {
    let pos = (pos & 63) as usize;
    match waveform & 3 {
        0 => SINE_TABLE[pos],
        1 => 255 - pos as i32 * 8, // ramp down
        _ => if pos < 32 { 255 } else { -255 }, // square
    }
}

#[derive(Debug, Clone)]
pub struct Channel {
    pub sample: Option<usize>,      // index into mod_file.samples (1-indexed)
    pub pos: f64,                   // fractional sample position
    pub period: i32,                // stored period
    pub effective_period: i32,      // period used for rendering (vibrato etc.)
    pub volume: i32,                // stored volume 0-64
    pub effective_volume: i32,      // volume used for rendering (tremolo modifies)

    pub effect_cmd: u8,
    pub effect_data: u8,

    // Portamento (effects 3, 5)
    pub port_target: i32,
    pub port_speed: i32,

    // Vibrato (effects 4, 6)
    pub vib_speed: i32,
    pub vib_depth: i32,
    pub vib_pos: i32,
    pub vib_waveform: u8,  // 0-3: shape; 4-7: same but don't reset on new note

    // Tremolo (effect 7)
    pub trem_speed: i32,
    pub trem_depth: i32,
    pub trem_pos: i32,
    pub trem_waveform: u8,

    pub arp_base_period: i32,

    // Pattern loop (E5 / E6)
    pub loop_row: usize,
    pub loop_count: i32,

    // Note delay (ED)
    pub note_delay: i32,
    pub delayed_note: Option<Note>,

    // Note cut tick (EC)
    pub note_cut_tick: i32,

    // Retrig counter (E9)
    pub retrig_count: i32,
}

impl Channel {
    fn new() -> Self {
        Channel {
            sample: None,
            pos: 0.0,
            period: 0,
            effective_period: 0,
            volume: 0,
            effective_volume: 0,
            effect_cmd: 0,
            effect_data: 0,
            port_target: 0,
            port_speed: 0,
            vib_speed: 0,
            vib_depth: 0,
            vib_pos: 0,
            vib_waveform: 0,
            trem_speed: 0,
            trem_depth: 0,
            trem_pos: 0,
            trem_waveform: 0,
            arp_base_period: 0,
            loop_row: 0,
            loop_count: 0,
            note_delay: 0,
            delayed_note: None,
            note_cut_tick: -1,
            retrig_count: 0,
        }
    }
}

pub struct ModPlayer {
    pub mod_file: ModFile,
    pub channels: Vec<Channel>,

    pub song_pos: usize,
    pub row: usize,
    pub tick: i32,

    pub speed: i32,
    pub bpm: i32,
    pub samples_per_tick: usize,

    pub tick_sample_pos: usize,

    pub jump_flag: bool,
    pub jump_pos: i32,
    pub break_row: i32,

    pub pattern_delay: i32,

    pan: Vec<usize>, // 0 = left, 1 = right

    pub finished: bool,
}

impl ModPlayer {
    pub fn new(mod_file: ModFile) -> Self {
        let num_channels = mod_file.num_channels;
        let channels = (0..num_channels).map(|_| Channel::new()).collect();
        // Amiga hard panning: L R R L; channels beyond 4 default to left
        let pan_base = [0usize, 1, 1, 0];
        let pan = pan_base[..num_channels.min(4)].to_vec();

        let mut player = ModPlayer {
            mod_file,
            channels,
            song_pos: 0,
            row: 0,
            tick: 0,
            speed: 6,
            bpm: 125,
            samples_per_tick: 0,
            tick_sample_pos: 0,
            jump_flag: false,
            jump_pos: -1,
            break_row: -1,
            pattern_delay: 0,
            pan,
            finished: false,
        };
        player.samples_per_tick = player.calc_spt(125);
        player.process_row();
        player.tick = 1; // tick 0 already processed above
        player
    }

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    /// Return n_frames of stereo f32 audio as Vec<[f32; 2]>.
    pub fn render(&mut self, n_frames: usize) -> Vec<[f32; 2]> {
        let mut output = vec![[0.0f32; 2]; n_frames];
        let mut done = 0;

        while done < n_frames {
            let remaining = if self.samples_per_tick > self.tick_sample_pos {
                self.samples_per_tick - self.tick_sample_pos
            } else {
                1
            };
            let to_render = (n_frames - done).min(remaining);

            let num_channels = self.channels.len();
            for ch_idx in 0..num_channels {
                let col = if ch_idx < self.pan.len() { self.pan[ch_idx] } else { 0 };
                let samples = self.render_channel(ch_idx, to_render);
                for (i, &s) in samples.iter().enumerate() {
                    output[done + i][col] += s;
                }
            }

            done += to_render;
            self.tick_sample_pos += to_render;

            if self.tick_sample_pos >= self.samples_per_tick {
                self.tick_sample_pos = 0;
                self.advance_tick();
            }
        }

        for frame in &mut output {
            frame[0] = frame[0].clamp(-1.0, 1.0);
            frame[1] = frame[1].clamp(-1.0, 1.0);
        }

        output
    }

    // ------------------------------------------------------------------
    // Internal: timing
    // ------------------------------------------------------------------

    fn calc_spt(&self, bpm: i32) -> usize {
        ((OUTPUT_RATE * 2.5 / bpm as f64).round() as usize).max(1)
    }

    // ------------------------------------------------------------------
    // Internal: tick / row advancement
    // ------------------------------------------------------------------

    fn advance_tick(&mut self) {
        let effective_speed = self.speed * (1 + self.pattern_delay);

        if self.tick == 0 {
            self.process_row();
        } else {
            let tick_in_speed = self.tick % self.speed;
            self.process_tick_effects(tick_in_speed);
        }

        self.tick += 1;

        if self.tick >= effective_speed {
            self.tick = 0;
            self.pattern_delay = 0;
            self.advance_position();
        }
    }

    fn advance_position(&mut self) {
        if self.jump_flag {
            self.jump_flag = false;
            let next_pos = if self.jump_pos >= 0 {
                self.jump_pos as usize
            } else {
                self.song_pos + 1
            };
            let next_row = if self.break_row >= 0 { self.break_row as usize } else { 0 };
            self.jump_pos = -1;
            self.break_row = -1;
            let song_len = self.mod_file.song_length;
            self.song_pos = if song_len > 0 { next_pos % song_len } else { 0 };
            self.row = next_row;
        } else {
            self.row += 1;
            if self.row >= 64 {
                self.row = 0;
                self.song_pos += 1;
                let song_len = self.mod_file.song_length;
                if self.song_pos >= song_len {
                    let restart = self.mod_file.restart_pos;
                    self.song_pos = if song_len > 0 { restart % song_len } else { 0 };
                    self.finished = true;
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // Internal: row processing (tick 0)
    // ------------------------------------------------------------------

    fn process_row(&mut self) {
        let pat_idx = self.mod_file.pattern_table[self.song_pos] as usize;
        if pat_idx >= self.mod_file.patterns.len() {
            return;
        }
        let notes: Vec<Note> = self.mod_file.patterns[pat_idx].rows[self.row].clone();

        for (ch_idx, note) in notes.iter().enumerate() {
            if ch_idx >= self.channels.len() {
                break;
            }

            self.channels[ch_idx].note_cut_tick = -1;
            self.channels[ch_idx].note_delay = 0;
            self.channels[ch_idx].delayed_note = None;
            self.channels[ch_idx].effect_cmd = note.effect_cmd;
            self.channels[ch_idx].effect_data = note.effect_data;

            // Note delay (EDx): postpone note trigger until tick x
            let is_note_delay = note.effect_cmd == 0xE
                && (note.effect_data >> 4) == 0xD
                && (note.effect_data & 0xF) > 0;

            if is_note_delay {
                self.channels[ch_idx].note_delay = (note.effect_data & 0xF) as i32;
                self.channels[ch_idx].delayed_note = Some(note.clone());
            } else if note.period > 0 || note.sample_num > 0 {
                let note_clone = note.clone();
                self.trigger_note(ch_idx, &note_clone);
            }

            let note_clone = note.clone();
            self.process_tick0_effect(ch_idx, &note_clone);

            // Sync effective period/volume for non-modulating effects
            if note.effect_cmd != 0x4 && note.effect_cmd != 0x6 && note.effect_cmd != 0x7 {
                let p = self.channels[ch_idx].period;
                self.channels[ch_idx].effective_period = p;
            }
            if note.effect_cmd != 0x7 {
                let v = self.channels[ch_idx].volume;
                self.channels[ch_idx].effective_volume = v;
            }
        }
    }

    fn trigger_note(&mut self, ch_idx: usize, note: &Note) {
        if note.sample_num > 0 {
            let s_idx = note.sample_num as usize;
            let (has_sample, vol) = match self.mod_file.samples.get(s_idx) {
                Some(Some(s)) if s.length > 0 => (true, s.volume as i32),
                _ => (false, 0),
            };
            if has_sample {
                self.channels[ch_idx].sample = Some(s_idx);
                self.channels[ch_idx].volume = vol;
                self.channels[ch_idx].effective_volume = vol;
            }
        }

        if note.period > 0 {
            let cmd = note.effect_cmd;
            let data = note.effect_data;
            if cmd == 0x3 || cmd == 0x5 {
                // Tone portamento: set target but don't retrigger
                self.channels[ch_idx].port_target = note.period as i32;
                if cmd == 0x3 && data != 0 {
                    self.channels[ch_idx].port_speed = data as i32;
                }
            } else {
                let ft = match self.channels[ch_idx].sample {
                    Some(idx) => match self.mod_file.samples.get(idx) {
                        Some(Some(s)) => s.finetune,
                        _ => 0,
                    },
                    None => 0,
                };
                let period = if ft != 0 {
                    (note.period as f64 * 2.0f64.powf(-ft as f64 / 96.0))
                        .round()
                        .max(1.0) as i32
                } else {
                    note.period as i32
                };
                self.channels[ch_idx].period = period;
                self.channels[ch_idx].effective_period = period;
                self.channels[ch_idx].pos = 0.0;
                self.channels[ch_idx].arp_base_period = period;
                if self.channels[ch_idx].vib_waveform < 4 {
                    self.channels[ch_idx].vib_pos = 0;
                }
                if self.channels[ch_idx].trem_waveform < 4 {
                    self.channels[ch_idx].trem_pos = 0;
                }
            }
        }
    }

    fn process_tick0_effect(&mut self, ch_idx: usize, note: &Note) {
        let cmd = note.effect_cmd;
        let data = note.effect_data;
        let x = (data >> 4) & 0xF;
        let y = data & 0xF;

        match cmd {
            0x4 => { // Vibrato: update params
                if x != 0 { self.channels[ch_idx].vib_speed = x as i32; }
                if y != 0 { self.channels[ch_idx].vib_depth = y as i32; }
            }
            0x7 => { // Tremolo: update params
                if x != 0 { self.channels[ch_idx].trem_speed = x as i32; }
                if y != 0 { self.channels[ch_idx].trem_depth = y as i32; }
            }
            0x9 => { // Set sample offset
                self.channels[ch_idx].pos = data as f64 * 256.0;
            }
            0xB => { // Position jump
                self.jump_pos = data as i32;
                self.jump_flag = true;
            }
            0xC => { // Set volume
                let v = data.min(64) as i32;
                self.channels[ch_idx].volume = v;
                self.channels[ch_idx].effective_volume = v;
            }
            0xD => { // Pattern break (BCD row number)
                self.break_row = x as i32 * 10 + y as i32;
                if self.jump_pos < 0 {
                    self.jump_pos = self.song_pos as i32 + 1;
                }
                self.jump_flag = true;
            }
            0xF => { // Set speed / BPM
                if data < 0x20 {
                    self.speed = (data as i32).max(1);
                } else {
                    self.bpm = data as i32;
                    self.samples_per_tick = self.calc_spt(data as i32);
                }
            }
            0xE => {
                let sub = x;
                let val = y;
                match sub {
                    0x1 => { // Fine slide up
                        let p = (self.channels[ch_idx].period - val as i32).max(1);
                        self.channels[ch_idx].period = p;
                    }
                    0x2 => { // Fine slide down
                        let p = (self.channels[ch_idx].period + val as i32).min(0xFFF);
                        self.channels[ch_idx].period = p;
                    }
                    0x4 => { // Set vibrato waveform
                        self.channels[ch_idx].vib_waveform = val;
                    }
                    0x5 => { // Set loop point
                        self.channels[ch_idx].loop_row = self.row;
                        self.channels[ch_idx].loop_count = 0;
                    }
                    0x6 => { // Jump to loop
                        let loop_row = self.channels[ch_idx].loop_row;
                        let loop_count = self.channels[ch_idx].loop_count;
                        if val == 0 {
                            self.channels[ch_idx].loop_row = self.row;
                            self.channels[ch_idx].loop_count = 0;
                        } else if loop_count == 0 {
                            self.channels[ch_idx].loop_count = val as i32;
                            self.break_row = loop_row as i32;
                            self.jump_pos = self.song_pos as i32;
                            self.jump_flag = true;
                        } else {
                            self.channels[ch_idx].loop_count -= 1;
                            if self.channels[ch_idx].loop_count > 0 {
                                self.break_row = loop_row as i32;
                                self.jump_pos = self.song_pos as i32;
                                self.jump_flag = true;
                            }
                        }
                    }
                    0x7 => { // Set tremolo waveform
                        self.channels[ch_idx].trem_waveform = val;
                    }
                    0x9 => { // Retrig note (set interval)
                        self.channels[ch_idx].retrig_count = val as i32;
                    }
                    0xA => { // Fine volume slide up
                        let v = (self.channels[ch_idx].volume + val as i32).min(64);
                        self.channels[ch_idx].volume = v;
                        self.channels[ch_idx].effective_volume = v;
                    }
                    0xB => { // Fine volume slide down
                        let v = (self.channels[ch_idx].volume - val as i32).max(0);
                        self.channels[ch_idx].volume = v;
                        self.channels[ch_idx].effective_volume = v;
                    }
                    0xC => { // Note cut: save target tick
                        self.channels[ch_idx].note_cut_tick = val as i32;
                    }
                    0xD => {} // Note delay handled in process_row
                    0xE => { // Pattern delay
                        self.pattern_delay = val as i32;
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    // ------------------------------------------------------------------
    // Internal: ongoing effects (ticks 1..speed-1)
    // ------------------------------------------------------------------

    fn process_tick_effects(&mut self, tick_in_speed: i32) {
        for ch_idx in 0..self.channels.len() {
            self.process_channel_tick(ch_idx, tick_in_speed);
        }
    }

    fn process_channel_tick(&mut self, ch_idx: usize, tick: i32) {
        // Read all needed state upfront to avoid borrow conflicts
        let note_cut_tick = self.channels[ch_idx].note_cut_tick;
        let note_delay = self.channels[ch_idx].note_delay;
        let has_delayed_note = self.channels[ch_idx].delayed_note.is_some();
        let cmd = self.channels[ch_idx].effect_cmd;
        let data = self.channels[ch_idx].effect_data;
        let x = (data >> 4) & 0xF;
        let y = data & 0xF;

        // Note cut
        if note_cut_tick >= 0 && tick == note_cut_tick {
            self.channels[ch_idx].volume = 0;
            self.channels[ch_idx].effective_volume = 0;
        }

        // Note delay: trigger deferred note
        if note_delay > 0 && tick == note_delay && has_delayed_note {
            let delayed = self.channels[ch_idx].delayed_note.clone().unwrap();
            self.trigger_note(ch_idx, &delayed);
            let p = self.channels[ch_idx].period;
            self.channels[ch_idx].effective_period = p;
            let v = self.channels[ch_idx].volume;
            self.channels[ch_idx].effective_volume = v;
            self.process_tick0_effect(ch_idx, &delayed);
            self.channels[ch_idx].delayed_note = None;
            self.channels[ch_idx].note_delay = 0;
        }

        match cmd {
            0x0 if data != 0 => { // Arpeggio
                let phase = tick % 3;
                let base = self.channels[ch_idx].arp_base_period;
                let ep = if phase == 0 {
                    base
                } else if phase == 1 {
                    (base as f64 / 2.0f64.powf(x as f64 / 12.0)).round().max(1.0) as i32
                } else {
                    (base as f64 / 2.0f64.powf(y as f64 / 12.0)).round().max(1.0) as i32
                };
                self.channels[ch_idx].effective_period = ep;
            }
            0x1 => { // Slide up (lower period = higher pitch)
                let p = (self.channels[ch_idx].period - data as i32).max(1);
                self.channels[ch_idx].period = p;
                self.channels[ch_idx].effective_period = p;
            }
            0x2 => { // Slide down
                let p = (self.channels[ch_idx].period + data as i32).min(0xFFF);
                self.channels[ch_idx].period = p;
                self.channels[ch_idx].effective_period = p;
            }
            0x3 => { // Tone portamento
                let target = self.channels[ch_idx].port_target;
                let speed = self.channels[ch_idx].port_speed;
                let period = self.channels[ch_idx].period;
                if target != 0 && period != 0 {
                    let new_p = if period < target {
                        (period + speed).min(target)
                    } else {
                        (period - speed).max(target)
                    };
                    self.channels[ch_idx].period = new_p;
                    self.channels[ch_idx].effective_period = new_p;
                }
            }
            0x4 => { // Vibrato
                let speed = self.channels[ch_idx].vib_speed;
                let depth = self.channels[ch_idx].vib_depth;
                let waveform = self.channels[ch_idx].vib_waveform;
                let vib_pos = (self.channels[ch_idx].vib_pos + speed) & 63;
                self.channels[ch_idx].vib_pos = vib_pos;
                let delta = (wave_value(vib_pos, waveform) * depth) >> 7;
                let ep = (self.channels[ch_idx].period + delta).max(1);
                self.channels[ch_idx].effective_period = ep;
            }
            0x5 => { // Tone portamento + volume slide
                let target = self.channels[ch_idx].port_target;
                let speed = self.channels[ch_idx].port_speed;
                let period = self.channels[ch_idx].period;
                if target != 0 && period != 0 {
                    let new_p = if period < target {
                        (period + speed).min(target)
                    } else {
                        (period - speed).max(target)
                    };
                    self.channels[ch_idx].period = new_p;
                    self.channels[ch_idx].effective_period = new_p;
                }
                self.do_volume_slide(ch_idx, data);
            }
            0x6 => { // Vibrato + volume slide
                let speed = self.channels[ch_idx].vib_speed;
                let depth = self.channels[ch_idx].vib_depth;
                let waveform = self.channels[ch_idx].vib_waveform;
                let vib_pos = (self.channels[ch_idx].vib_pos + speed) & 63;
                self.channels[ch_idx].vib_pos = vib_pos;
                let delta = (wave_value(vib_pos, waveform) * depth) >> 7;
                let ep = (self.channels[ch_idx].period + delta).max(1);
                self.channels[ch_idx].effective_period = ep;
                self.do_volume_slide(ch_idx, data);
            }
            0x7 => { // Tremolo
                let speed = self.channels[ch_idx].trem_speed;
                let depth = self.channels[ch_idx].trem_depth;
                let waveform = self.channels[ch_idx].trem_waveform;
                let trem_pos = (self.channels[ch_idx].trem_pos + speed) & 63;
                self.channels[ch_idx].trem_pos = trem_pos;
                let delta = (wave_value(trem_pos, waveform) * depth) >> 6;
                let ev = (self.channels[ch_idx].volume + delta).clamp(0, 64);
                self.channels[ch_idx].effective_volume = ev;
            }
            0xA => { // Volume slide
                self.do_volume_slide(ch_idx, data);
            }
            0xE => {
                let sub = x;
                if sub == 0x9 {
                    let rc = self.channels[ch_idx].retrig_count;
                    if rc > 0 && tick % rc == 0 {
                        self.channels[ch_idx].pos = 0.0;
                    }
                }
            }
            _ => {}
        }
    }

    fn do_volume_slide(&mut self, ch_idx: usize, data: u8) {
        let x = (data >> 4) & 0xF;
        let y = data & 0xF;
        if x != 0 {
            let v = (self.channels[ch_idx].volume + x as i32).min(64);
            self.channels[ch_idx].volume = v;
            self.channels[ch_idx].effective_volume = v;
        } else if y != 0 {
            let v = (self.channels[ch_idx].volume - y as i32).max(0);
            self.channels[ch_idx].volume = v;
            self.channels[ch_idx].effective_volume = v;
        }
    }

    // ------------------------------------------------------------------
    // Internal: per-channel audio rendering
    // ------------------------------------------------------------------

    fn render_channel(&mut self, ch_idx: usize, n: usize) -> Vec<f32> {
        // Extract channel state into locals so we can borrow mod_file separately.
        let (sample_idx, effective_period, effective_volume, start_pos) = {
            let ch = &self.channels[ch_idx];
            match ch.sample {
                Some(idx) => (idx, ch.effective_period, ch.effective_volume, ch.pos),
                None => return vec![0.0f32; n],
            }
        };

        if effective_period <= 0 {
            return vec![0.0f32; n];
        }

        // Explicit field split: borrow mod_file immutably alongside mutable channels.
        let (channels, mod_file) = (&mut self.channels, &self.mod_file);

        let sample = match mod_file.samples.get(sample_idx) {
            Some(Some(s)) if !s.data_float.is_empty() => s,
            _ => return vec![0.0f32; n],
        };

        let slen = sample.data_float.len();
        let has_loop = sample.has_loop();
        let loop_start = sample.loop_start;
        let loop_end = sample.loop_end().min(slen);
        let loop_len = if has_loop && loop_end > loop_start { loop_end - loop_start } else { 0 };

        let rate = PAULA_CLOCK / (effective_period as f64 * 2.0 * OUTPUT_RATE);
        let volume = effective_volume as f64 / 64.0;

        let mut pos = start_pos;
        let mut out = vec![0.0f32; n];

        for i in 0..n {
            let ipos = pos as usize;
            if ipos >= slen {
                break;
            }
            out[i] = (sample.data_float[ipos] as f64 * volume) as f32;
            pos += rate;
            if has_loop && loop_len > 0 && pos >= loop_end as f64 {
                pos -= loop_len as f64;
            }
        }

        channels[ch_idx].pos = pos;
        out
    }
}
