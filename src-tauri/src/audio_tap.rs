//! Per-segment audio taps.
//!
//! ScreenCaptureKit delivers system audio (`SCStreamOutputType::Audio`) and
//! microphone audio (`SCStreamOutputType::Microphone`, macOS 15+) as separate
//! PCM sample-buffer streams on the same SCStream that records the screen.
//! Each tap writes one of those streams to a WAV file next to the video
//! segment, so the editor gets independently editable audio tracks.
//!
//! Alignment: the WAV must start at the exact moment the video segment's
//! first frame was captured, or the tracks drift apart in the editor. The
//! stream's video and audio buffers share one clock, so we record the first
//! video frame's presentation timestamp (the "anchor") and, when the first
//! audio buffer arrives, either drop leading samples (audio started early)
//! or prepend silence (audio started late). Audio buffers that arrive before
//! the anchor is known are held in `pending`.

use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use screencapturekit::cm::CMSampleBuffer;
use screencapturekit::stream::output_type::SCStreamOutputType;

type WavWriter = hound::WavWriter<BufWriter<File>>;

/// Shared slot for the segment's first video-frame presentation timestamp
/// (seconds on the stream clock). Set once by a Screen output handler.
pub type VideoAnchor = Arc<Mutex<Option<f64>>>;

struct PendingBuf {
    pts: f64,
    channels: u16,
    sample_rate: u32,
    samples: Vec<f32>, // interleaved
}

struct TapState {
    writer: Option<WavWriter>,
    pending: Vec<PendingBuf>,
    anchored: bool,
    stopped: bool,
}

pub struct AudioTap {
    path: PathBuf,
    state: Arc<Mutex<TapState>>,
    anchor: VideoAnchor,
}

fn bytes_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// Pull (pts, channels, sample_rate, interleaved f32 samples) out of a PCM
/// sample buffer. SCK delivers non-interleaved f32 (one buffer per channel);
/// a single multi-channel buffer (already interleaved) is handled too.
fn extract(sample: &CMSampleBuffer) -> Option<PendingBuf> {
    let fmt = sample.format_description()?;
    if !fmt.is_audio() || !fmt.is_pcm() {
        return None;
    }
    let sample_rate = fmt.audio_sample_rate().unwrap_or(48_000.0).round() as u32;
    let pts = {
        let t = sample.presentation_timestamp();
        if t.timescale == 0 {
            return None;
        }
        t.value as f64 / t.timescale as f64
    };
    let list = sample.audio_buffer_list()?;
    let n = list.num_buffers();
    if n == 0 {
        return None;
    }
    let (channels, samples) = if n == 1 {
        let buf = list.get(0)?;
        ((buf.number_channels.max(1) as u16), bytes_to_f32(buf.data()))
    } else {
        let chans: Vec<Vec<f32>> = (0..n)
            .filter_map(|i| list.get(i).map(|b| bytes_to_f32(b.data())))
            .collect();
        if chans.len() != n {
            return None;
        }
        let frames = chans.iter().map(Vec::len).min().unwrap_or(0);
        let mut out = Vec::with_capacity(frames * n);
        for f in 0..frames {
            for c in &chans {
                out.push(c[f]);
            }
        }
        (n as u16, out)
    };
    Some(PendingBuf { pts, channels, sample_rate, samples })
}

fn write_interleaved(writer: &mut WavWriter, samples: &[f32]) {
    for &s in samples {
        let _ = writer.write_sample(s);
    }
}

/// Write `buf` as the first audio of the file: create the writer, then align
/// the stream to `anchor` by dropping early samples or prepending silence.
fn write_first(state: &mut TapState, path: &Path, anchor: f64, buf: PendingBuf) {
    let spec = hound::WavSpec {
        channels: buf.channels,
        sample_rate: buf.sample_rate,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut writer = match hound::WavWriter::create(path, spec) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[audio-tap] failed to create {path:?}: {e}");
            state.stopped = true;
            return;
        }
    };
    let offset = buf.pts - anchor;
    if offset >= 0.0 {
        // Audio starts after the first video frame: pad with silence.
        let pad_frames = (offset * buf.sample_rate as f64).round() as usize;
        for _ in 0..pad_frames * buf.channels as usize {
            let _ = writer.write_sample(0.0f32);
        }
        write_interleaved(&mut writer, &buf.samples);
    } else {
        // Audio started before the first video frame: drop the lead-in.
        let drop_frames = ((-offset) * buf.sample_rate as f64).round() as usize;
        let drop_samples = (drop_frames * buf.channels as usize).min(buf.samples.len());
        write_interleaved(&mut writer, &buf.samples[drop_samples..]);
    }
    state.writer = Some(writer);
}

impl AudioTap {
    pub fn new(path: PathBuf, anchor: VideoAnchor) -> Self {
        Self {
            path,
            anchor,
            state: Arc::new(Mutex::new(TapState {
                writer: None,
                pending: Vec::new(),
                anchored: false,
                stopped: false,
            })),
        }
    }

    /// Closure to register via `SCStream::add_output_handler` for this tap's
    /// output type (Audio or Microphone).
    pub fn handler(&self) -> impl Fn(CMSampleBuffer, SCStreamOutputType) + Send + Sync + 'static {
        let state = Arc::clone(&self.state);
        let anchor = Arc::clone(&self.anchor);
        let path = self.path.clone();
        move |sample, _of_type| {
            let Some(buf) = extract(&sample) else { return };
            let mut st = state.lock();
            if st.stopped {
                return;
            }
            if !st.anchored {
                let anchor_pts = *anchor.lock();
                // Safety valve: if no video frame ever arrives (shouldn't
                // happen — screen capture is always on), anchor to the first
                // audio buffer rather than buffering unboundedly.
                let anchor_pts = anchor_pts.or_else(|| {
                    (st.pending.len() >= 256)
                        .then(|| st.pending.first().map(|p| p.pts).unwrap_or(buf.pts))
                });
                match anchor_pts {
                    None => {
                        st.pending.push(buf);
                        return;
                    }
                    Some(a) => {
                        st.anchored = true;
                        let pending = std::mem::take(&mut st.pending);
                        for (i, p) in pending.into_iter().chain(std::iter::once(buf)).enumerate() {
                            if i == 0 {
                                write_first(&mut st, &path, a, p);
                            } else if let Some(w) = st.writer.as_mut() {
                                write_interleaved(w, &p.samples);
                            }
                        }
                        return;
                    }
                }
            }
            if let Some(w) = st.writer.as_mut() {
                write_interleaved(w, &buf.samples);
            }
        }
    }

    /// Stop accepting buffers and finalize the WAV. Returns the path if a
    /// non-empty file was written.
    pub fn finalize(&self) -> Option<PathBuf> {
        let mut st = self.state.lock();
        st.stopped = true;
        st.pending.clear();
        let writer = st.writer.take()?;
        let has_data = writer.len() > 0;
        if let Err(e) = writer.finalize() {
            eprintln!("[audio-tap] failed to finalize {:?}: {e}", self.path);
            return None;
        }
        if has_data {
            Some(self.path.clone())
        } else {
            let _ = std::fs::remove_file(&self.path);
            None
        }
    }
}

/// Concatenate WAV segments into `final_output`. One segment is renamed;
/// several are appended sample-by-sample (all segments come from the same
/// stream config, so their specs match). Segment files are removed on
/// success. Returns None when there is nothing to write.
pub fn concat_wav_segments(segments: &[PathBuf], final_output: &Path) -> Option<PathBuf> {
    if segments.is_empty() {
        return None;
    }
    if segments.len() == 1 {
        match std::fs::rename(&segments[0], final_output) {
            Ok(()) => return Some(final_output.to_path_buf()),
            Err(e) => {
                eprintln!("[audio-tap] rename {:?} failed: {e}", segments[0]);
                return None;
            }
        }
    }

    let first = match hound::WavReader::open(&segments[0]) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[audio-tap] open {:?} failed: {e}", segments[0]);
            return None;
        }
    };
    let spec = first.spec();
    drop(first);

    let mut writer = match hound::WavWriter::create(final_output, spec) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[audio-tap] create {final_output:?} failed: {e}");
            return None;
        }
    };
    for seg in segments {
        let reader = match hound::WavReader::open(seg) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[audio-tap] open {seg:?} failed: {e}");
                continue;
            }
        };
        if reader.spec() != spec {
            eprintln!("[audio-tap] spec mismatch in {seg:?}; skipping segment");
            continue;
        }
        for s in reader.into_samples::<f32>() {
            match s {
                Ok(v) => {
                    let _ = writer.write_sample(v);
                }
                Err(e) => {
                    eprintln!("[audio-tap] read error in {seg:?}: {e}");
                    break;
                }
            }
        }
    }
    if let Err(e) = writer.finalize() {
        eprintln!("[audio-tap] finalize {final_output:?} failed: {e}");
        return None;
    }
    for seg in segments {
        let _ = std::fs::remove_file(seg);
    }
    Some(final_output.to_path_buf())
}
