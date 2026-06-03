/// MOD file parser for the Amiga ProTracker format.
/// Spec: https://www.eblong.com/zarf/blorb/mod-spec.txt
use std::fs;

#[derive(Debug, Clone)]
pub struct SampleInfo {
    pub name: String,
    pub length: usize,      // in bytes
    pub finetune: i32,      // signed -8 to +7
    pub volume: u8,         // 0-64
    pub loop_start: usize,  // in bytes
    pub loop_len: usize,    // in bytes
    pub data: Vec<u8>,
    pub data_float: Vec<f32>,
}

impl SampleInfo {
    pub fn loop_end(&self) -> usize {
        self.loop_start + self.loop_len
    }

    pub fn has_loop(&self) -> bool {
        self.loop_len > 2
    }
}

#[derive(Debug, Clone)]
pub struct Note {
    pub sample_num: u8,   // 1-31 (0 = no sample)
    pub period: u16,      // 0 = no note
    pub effect_cmd: u8,   // 0x0-0xF
    pub effect_data: u8,  // 0x00-0xFF
}

#[derive(Debug, Clone)]
pub struct Pattern {
    pub rows: Vec<Vec<Note>>,  // 64 rows × num_channels notes
}

#[derive(Debug)]
pub struct ModFile {
    pub title: String,
    pub num_channels: usize,
    pub samples: Vec<Option<SampleInfo>>,  // index 0 is sentinel; 1-indexed
    pub song_length: usize,
    pub restart_pos: usize,
    pub pattern_table: Vec<u8>,  // 128 entries
    pub patterns: Vec<Pattern>,
}

pub fn parse_mod(filename: &str) -> Result<ModFile, Box<dyn std::error::Error>> {
    let data = fs::read(filename)?;

    let title = decode_latin1_trimmed(&data[0..20.min(data.len())]);

    // Parse 31 sample headers (offset 20, 30 bytes each)
    let mut samples: Vec<Option<SampleInfo>> = vec![None]; // index 0 unused; 1-indexed
    for i in 0..31 {
        let off = 20 + i * 30;
        if off + 30 > data.len() {
            samples.push(None);
            continue;
        }
        let name = decode_latin1_trimmed(&data[off..off + 22]);
        let length = u16::from_be_bytes([data[off + 22], data[off + 23]]) as usize * 2;
        let finetune_raw = data[off + 24] & 0x0F;
        let finetune = if finetune_raw < 8 { finetune_raw as i32 } else { finetune_raw as i32 - 16 };
        let volume = data[off + 25].min(64);
        let loop_start = u16::from_be_bytes([data[off + 26], data[off + 27]]) as usize * 2;
        let loop_len = u16::from_be_bytes([data[off + 28], data[off + 29]]) as usize * 2;
        samples.push(Some(SampleInfo {
            name,
            length,
            finetune,
            volume,
            loop_start,
            loop_len,
            data: vec![],
            data_float: vec![],
        }));
    }

    if data.len() < 952 {
        return Err("File too short".into());
    }

    let song_length = data[950] as usize;
    let restart_pos = data[951] as usize;
    let pattern_table: Vec<u8> = data[952..1080.min(data.len())].to_vec();

    // Identify channel count from the 4-byte tag at offset 1080
    let num_channels = if data.len() >= 1084 {
        match &data[1080..1084] {
            b"M.K." | b"M!K!" | b"4CHN" | b"FLT4" => 4,
            b"6CHN" => 6,
            b"8CHN" | b"FLT8" | b"OCTA" => 8,
            _ => 4,
        }
    } else {
        4
    };

    let num_patterns = pattern_table[..song_length.min(pattern_table.len())]
        .iter()
        .cloned()
        .max()
        .unwrap_or(0) as usize + 1;

    let mut offset = 1084;
    let mut patterns: Vec<Pattern> = Vec::new();
    for _ in 0..num_patterns {
        let mut rows = Vec::with_capacity(64);
        for _ in 0..64 {
            let mut notes = Vec::with_capacity(num_channels);
            for _ in 0..num_channels {
                if offset + 4 > data.len() {
                    notes.push(Note { sample_num: 0, period: 0, effect_cmd: 0, effect_data: 0 });
                    continue;
                }
                let b = &data[offset..offset + 4];
                offset += 4;
                let sample_num = (b[0] & 0xF0) | (b[2] >> 4);
                let period = ((b[0] & 0x0F) as u16) << 8 | b[1] as u16;
                let effect_cmd = b[2] & 0x0F;
                let effect_data = b[3];
                notes.push(Note { sample_num, period, effect_cmd, effect_data });
            }
            rows.push(notes);
        }
        patterns.push(Pattern { rows });
    }

    // Load PCM sample data (signed 8-bit)
    for i in 1..32usize {
        if let Some(Some(ref mut s)) = samples.get_mut(i) {
            let end = (offset + s.length).min(data.len());
            let raw = &data[offset..end];
            let mut raw_vec = raw.to_vec();
            if raw_vec.len() < s.length {
                raw_vec.resize(s.length, 0);
            }
            offset += s.length;
            // Pre-convert to float32 [-1, 1]
            let data_float: Vec<f32> = raw_vec.iter()
                .map(|&b| (b as i8) as f32 / 128.0)
                .collect();
            s.data = raw_vec;
            s.data_float = data_float;
        }
    }

    Ok(ModFile {
        title,
        num_channels,
        samples,
        song_length,
        restart_pos,
        pattern_table,
        patterns,
    })
}

fn decode_latin1_trimmed(bytes: &[u8]) -> String {
    let trimmed = match bytes.iter().position(|&b| b == 0) {
        Some(pos) => &bytes[..pos],
        None => bytes,
    };
    trimmed.iter().map(|&b| b as char).collect()
}
