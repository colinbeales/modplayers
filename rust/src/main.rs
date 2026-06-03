use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

mod mod_parser;
mod player_engine;

use mod_parser::parse_mod;
use player_engine::{ModPlayer, OUTPUT_RATE};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: mod_player <file.mod>");
        std::process::exit(1);
    }
    let filename = &args[1];

    println!("Loading {}...", filename);
    let mod_file = match parse_mod(filename) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("Error loading file: {}", e);
            std::process::exit(1);
        }
    };

    println!();
    println!("  Title    : {}", mod_file.title);
    println!("  Channels : {}", mod_file.num_channels);
    let sample_count = mod_file.samples[1..]
        .iter()
        .filter(|s| s.as_ref().map_or(false, |s| s.length > 0))
        .count();
    println!("  Samples  : {}", sample_count);
    println!("  Patterns : {}", mod_file.patterns.len());
    println!("  Length   : {} positions", mod_file.song_length);
    println!();
    for (i, s) in mod_file.samples[1..].iter().enumerate() {
        if let Some(s) = s {
            if !s.name.trim().is_empty() {
                println!("  Sample {:2}: {}", i + 1, s.name);
            }
        }
    }
    println!();

    let song_length = mod_file.song_length;
    let pattern_table = mod_file.pattern_table.clone();

    let player = Arc::new(Mutex::new(ModPlayer::new(mod_file)));

    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .expect("No output device available");

    let config = cpal::StreamConfig {
        channels: 2,
        sample_rate: cpal::SampleRate(OUTPUT_RATE as u32),
        buffer_size: cpal::BufferSize::Default,
    };

    let player_cb = Arc::clone(&player);
    let stream = device
        .build_output_stream(
            &config,
            move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                let n_frames = data.len() / 2;
                let mut p = player_cb.lock().unwrap();
                let frames = p.render(n_frames);
                for (i, frame) in frames.iter().enumerate() {
                    data[i * 2] = frame[0];
                    data[i * 2 + 1] = frame[1];
                }
            },
            |err| eprintln!("Audio stream error: {}", err),
            None,
        )
        .expect("Failed to build output stream");

    stream.play().expect("Failed to start audio stream");

    // Ctrl+C handling
    let running = Arc::new(Mutex::new(true));
    let running_ctrlc = Arc::clone(&running);
    ctrlc::set_handler(move || {
        *running_ctrlc.lock().unwrap() = false;
    })
    .expect("Failed to set Ctrl+C handler");

    println!("Playing — press Ctrl+C to stop\n");

    let mut last_pos = -1i32;
    let mut last_row = -1i32;

    loop {
        if !*running.lock().unwrap() {
            break;
        }

        let (sp, rw, bpm, speed) = {
            let p = player.lock().unwrap();
            (p.song_pos as i32, p.row as i32, p.bpm, p.speed)
        };

        if sp != last_pos || rw != last_row {
            last_pos = sp;
            last_row = rw;
            let pat = if (sp as usize) < pattern_table.len() {
                pattern_table[sp as usize] as i32
            } else {
                0
            };
            print!(
                "\r  Pos {:3}/{:3}  Pat {:3}  Row {:2}  BPM {:3}  Spd {}   ",
                sp, song_length, pat, rw, bpm, speed
            );
            std::io::stdout().flush().ok();
        }

        std::thread::sleep(Duration::from_millis(10));
    }

    println!("\n\nStopped.");
}
