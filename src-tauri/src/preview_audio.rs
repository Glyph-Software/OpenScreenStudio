//! Native preview playback of the sidecar WAVs. WKWebView's Web Audio output
//! stays silent in this app, so the editor drives CoreAudio (via cpal) instead.

use std::path::Path;
use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use parking_lot::Mutex;
use tauri::State;

struct Track {
    map: memmap2::Mmap,
    data: usize,
    frames: usize,
    channels: usize,
    sr: f64,
    bits: u16,
}

impl Track {
    fn open(path: &Path) -> Result<Self, String> {
        let file = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let map = unsafe { memmap2::Mmap::map(&file) }.map_err(|e| e.to_string())?;
        let (mut channels, mut sr, mut bits, mut data, mut len) = (0usize, 0f64, 0u16, 0usize, 0usize);
        let mut i = 12;
        while i + 8 <= map.len() {
            let id = &map[i..i + 4];
            let size = u32::from_le_bytes(map[i + 4..i + 8].try_into().unwrap()) as usize;
            let body = i + 8;
            if id == b"fmt " && body + 16 <= map.len() {
                channels = u16::from_le_bytes([map[body + 2], map[body + 3]]) as usize;
                sr = u32::from_le_bytes(map[body + 4..body + 8].try_into().unwrap()) as f64;
                bits = u16::from_le_bytes([map[body + 14], map[body + 15]]);
            } else if id == b"data" {
                data = body;
                len = size.min(map.len() - body);
                break;
            }
            i = body + size + (size & 1);
        }
        if channels == 0 || sr <= 0.0 || data == 0 || !(bits == 16 || bits == 32) {
            return Err(format!("{}: unsupported WAV", path.display()));
        }
        let frames = len / (channels * bits as usize / 8);
        Ok(Self { map, data, frames, channels, sr, bits })
    }

    fn sample(&self, frame: usize, ch: usize) -> f32 {
        let idx = frame * self.channels + ch.min(self.channels - 1);
        if self.bits == 32 {
            let o = self.data + idx * 4;
            let v = f32::from_le_bytes(self.map[o..o + 4].try_into().unwrap());
            if v.is_finite() { v } else { 0.0 }
        } else {
            let o = self.data + idx * 2;
            i16::from_le_bytes([self.map[o], self.map[o + 1]]) as f32 / 32_768.0
        }
    }
}

#[derive(Default)]
struct Player {
    tracks: Vec<Track>,
    gains: Vec<f32>,
    pos: f64,
    rate: f64,
    playing: bool,
}

#[derive(Default)]
pub struct PreviewAudio {
    player: Arc<Mutex<Player>>,
    started: Mutex<bool>,
}

fn start_output(player: Arc<Mutex<Player>>) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    std::thread::spawn(move || {
        let build = || -> Result<cpal::Stream, String> {
            let device = cpal::default_host()
                .default_output_device()
                .ok_or("No audio output device")?;
            let config = device.default_output_config().map_err(|e| e.to_string())?;
            if config.sample_format() != cpal::SampleFormat::F32 {
                return Err(format!("Unsupported output format {:?}", config.sample_format()));
            }
            let out_sr = config.sample_rate().0 as f64;
            let out_ch = config.channels() as usize;
            let stream = device
                .build_output_stream(
                    &config.into(),
                    move |out: &mut [f32], _: &cpal::OutputCallbackInfo| {
                        out.fill(0.0);
                        let Some(mut p) = player.try_lock() else { return };
                        if !p.playing {
                            return;
                        }
                        let step = p.rate / out_sr;
                        let mut pos = p.pos;
                        for frame in out.chunks_mut(out_ch) {
                            for (ti, t) in p.tracks.iter().enumerate() {
                                let g = p.gains.get(ti).copied().unwrap_or(0.0);
                                let f = pos * t.sr;
                                let i = f as usize;
                                if g <= 0.0 || f < 0.0 || i + 1 >= t.frames {
                                    continue;
                                }
                                let frac = (f - i as f64) as f32;
                                for (c, o) in frame.iter_mut().enumerate() {
                                    let a = t.sample(i, c);
                                    *o += (a + (t.sample(i + 1, c) - a) * frac) * g;
                                }
                            }
                            for o in frame.iter_mut() {
                                *o = o.clamp(-1.0, 1.0);
                            }
                            pos += step;
                        }
                        p.pos = pos;
                    },
                    |e| eprintln!("[preview-audio] stream error: {e}"),
                    None,
                )
                .map_err(|e| e.to_string())?;
            stream.play().map_err(|e| e.to_string())?;
            Ok(stream)
        };
        match build() {
            Ok(_stream) => {
                let _ = tx.send(Ok(()));
                loop {
                    std::thread::park();
                }
            }
            Err(e) => {
                let _ = tx.send(Err(e));
            }
        }
    });
    rx.recv().map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn preview_audio_load(state: State<'_, PreviewAudio>, paths: Vec<String>) -> Result<(), String> {
    let tracks = paths.iter().map(|p| Track::open(Path::new(p))).collect::<Result<Vec<_>, _>>()?;
    {
        let mut p = state.player.lock();
        p.gains = vec![0.0; tracks.len()];
        p.tracks = tracks;
        p.playing = false;
        p.rate = 1.0;
    }
    let mut started = state.started.lock();
    if !*started {
        start_output(Arc::clone(&state.player))?;
        *started = true;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn preview_audio_set(state: State<'_, PreviewAudio>, playing: bool, t: f64, rate: f64) {
    let mut p = state.player.lock();
    p.playing = playing;
    p.pos = t.max(0.0);
    p.rate = if rate.is_finite() && rate > 0.0 { rate } else { 1.0 };
}

#[tauri::command]
pub(crate) fn preview_audio_gains(state: State<'_, PreviewAudio>, gains: Vec<f32>) {
    state.player.lock().gains = gains;
}

#[tauri::command]
pub(crate) fn preview_audio_pos(state: State<'_, PreviewAudio>) -> f64 {
    state.player.lock().pos
}
