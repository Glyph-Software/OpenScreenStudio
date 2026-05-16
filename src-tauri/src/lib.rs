//! Real capture backend.
//!
//! - Screen recording uses ScreenCaptureKit (`screencapturekit` crate) entirely
//!   in-process and writes directly to mp4 via `SCRecordingOutput` (macOS 15+).
//!   The TCC permission attaches to the .app bundle, so once the user grants
//!   Screen Recording once, every recording Just Works — no ffmpeg sidecar,
//!   no AVFoundation device indices, no per-binary permission dance.
//! - Audio device enumeration still uses ffmpeg's `-list_devices` output so
//!   the HUD can show available microphones. Capture itself uses SCK's
//!   built-in microphone capture path.
//! - Mic-level metering uses `cpal` to sample the default input and emits
//!   `mic-level` events at ~30 Hz with the current peak in [0.0, 1.0].

use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
use screencapturekit::{
    cg::CGRect as SCKRect,
    recording_output::{
        RecordingCallbacks, SCRecordingOutput, SCRecordingOutputCodec,
        SCRecordingOutputConfiguration, SCRecordingOutputFileType,
    },
    shareable_content::SCShareableContent,
    stream::{
        configuration::{pixel_format::PixelFormat, SCStreamConfiguration},
        content_filter::SCContentFilter,
        delegate_trait::StreamCallbacks,
        sc_stream::SCStream,
    },
};

#[cfg(target_os = "macos")]
pub fn probe_screen_recording_and_exit() -> ! {
    let granted = unsafe { CGPreflightScreenCaptureAccess() };
    std::process::exit(if granted { 0 } else { 1 });
}

#[cfg(not(target_os = "macos"))]
pub fn probe_screen_recording_and_exit() -> ! {
    std::process::exit(0);
}

#[cfg(target_os = "macos")]
fn probe_screen_recording_via_subprocess() -> bool {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => return false,
    };
    Command::new(exe)
        .arg("--probe-screen-recording")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

// --- macOS permission FFI ---------------------------------------------------

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: core_foundation::dictionary::CFDictionaryRef) -> u8;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionsStatus {
    pub screen_recording: bool,
    pub accessibility: bool,
}

fn check_permissions_inner() -> PermissionsStatus {
    #[cfg(target_os = "macos")]
    {
        // CGPreflightScreenCaptureAccess() caches its answer for the lifetime
        // of the calling process, so we run it in a fresh subprocess to detect
        // grants that happen after launch. AXIsProcessTrusted() updates live.
        PermissionsStatus {
            screen_recording: probe_screen_recording_via_subprocess(),
            accessibility: unsafe { AXIsProcessTrusted() },
        }
    }
    #[cfg(not(target_os = "macos"))]
    PermissionsStatus { screen_recording: true, accessibility: true }
}

fn requested_flag_path(app: &AppHandle, key: &str) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    let _ = fs::create_dir_all(&dir);
    Some(dir.join(format!(".{}_requested", key)))
}

fn mark_requested(app: &AppHandle, key: &str) {
    if let Some(p) = requested_flag_path(app, key) {
        let _ = fs::write(p, b"1");
    }
}

fn was_requested(app: &AppHandle, key: &str) -> bool {
    requested_flag_path(app, key)
        .map(|p| p.exists())
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn open_settings(url: &str) {
    let _ = Command::new("open").arg(url).spawn();
}

#[tauri::command]
fn check_permissions() -> PermissionsStatus {
    check_permissions_inner()
}

#[tauri::command]
fn request_screen_recording(app: AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    {
        if probe_screen_recording_via_subprocess() {
            return true;
        }
        if was_requested(&app, "screen") {
            // Already prompted once; macOS won't prompt again, so deep-link to Settings.
            open_settings(
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
            );
            return false;
        }
        // First click: trigger the native TCC prompt and register the app.
        // Don't open Settings — the user is staring at a dialog.
        unsafe {
            let _ = CGRequestScreenCaptureAccess();
        }
        mark_requested(&app, "screen");
        false
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        true
    }
}

#[tauri::command]
fn request_accessibility(app: AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    {
        use core_foundation::base::TCFType;
        use core_foundation::boolean::CFBoolean;
        use core_foundation::dictionary::CFDictionary;
        use core_foundation::string::CFString;

        unsafe {
            if AXIsProcessTrusted() {
                return true;
            }
        }
        if was_requested(&app, "accessibility") {
            open_settings(
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
            );
            return false;
        }
        unsafe {
            let key = CFString::new("AXTrustedCheckOptionPrompt");
            let opts = CFDictionary::from_CFType_pairs(&[(key, CFBoolean::true_value())]);
            let _ = AXIsProcessTrustedWithOptions(opts.as_concrete_TypeRef());
        }
        mark_requested(&app, "accessibility");
        false
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        true
    }
}

#[tauri::command]
fn dismiss_permissions(app: AppHandle) -> Result<(), String> {
    if let Some(p) = app.get_webview_window("permissions") {
        let _ = p.hide();
    }
    if let Some(hud) = app.get_webview_window("hud") {
        hud.show().map_err(|e| e.to_string())?;
        hud.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSource {
    pub id: String,
    pub kind: String,  // "screen" | "camera" | "audio"
    pub label: String,
    pub index: u32,    // AVFoundation device index
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureArtifact {
    pub id: String,
    pub path: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CropRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartCaptureArgs {
    pub display_id: u32,
    pub window_id: Option<u32>,
    pub audio_index: Option<u32>,
    pub framerate: Option<u32>,
    pub crop: Option<CropRect>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CursorSample {
    t_ms: u32,
    x: f64,
    y: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CursorClick {
    t_ms: u32,
    x: f64,
    y: f64,
    button: &'static str,
    kind: &'static str,
}

// Cursor *shape* transitions (arrow → pointer → text → …). Only emitted when
// the shape actually changes — the shape in effect at time `t` is the last
// entry with `t_ms <= t`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CursorShapeChange {
    t_ms: u32,
    shape: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CursorSidecarDisplay {
    id: u32,
    origin_x: f64,
    origin_y: f64,
    width: f64,
    height: f64,
    scale_factor: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CursorSidecar<'a> {
    version: u32,
    recording_id: &'a str,
    started_epoch_ms: i64,
    duration_ms: u64,
    display: CursorSidecarDisplay,
    crop: Option<&'a CropRect>,
    samples: Vec<CursorSample>,
    clicks: Vec<CursorClick>,
    cursor_shapes: Vec<CursorShapeChange>,
}

struct CursorTrack {
    samples: Mutex<Vec<CursorSample>>,
    clicks: Mutex<Vec<CursorClick>>,
    shapes: Mutex<Vec<CursorShapeChange>>,
    display: DisplayInfo,
    crop: Option<CropRect>,
    // Wall-clock anchor for *active* (non-paused) recording. On pause we
    // bank the elapsed time into `t_offset_ms`; on resume we reset `started`
    // to `Instant::now()`. The effective t_ms used for sidecar samples is
    // `t_offset_ms + (paused ? 0 : started.elapsed())`, so the timeline
    // stays continuous across pause/resume — and lines up with the
    // concatenated MP4 produced by ffmpeg.
    started: Mutex<Instant>,
    t_offset_ms: AtomicU64,
    paused: AtomicBool,
    started_epoch_ms: i64,
}

#[cfg(target_os = "macos")]
fn cursor_t_ms(track: &CursorTrack) -> u32 {
    let base = track.t_offset_ms.load(Ordering::Relaxed);
    let extra = if track.paused.load(Ordering::Relaxed) {
        0
    } else {
        track.started.lock().elapsed().as_millis() as u64
    };
    (base + extra).min(u32::MAX as u64) as u32
}

#[cfg(target_os = "macos")]
type CFRunLoopRef = *mut std::ffi::c_void;

#[cfg(target_os = "macos")]
struct RunLoopHandle(CFRunLoopRef);
#[cfg(target_os = "macos")]
unsafe impl Send for RunLoopHandle {}

#[cfg(target_os = "macos")]
struct SegmentRecorder {
    stream: SCStream,
    _recording_output: SCRecordingOutput,
    segment_path: PathBuf,
    // Set true before we call `stream.stop_capture()` from our own code path
    // so the SCK delegate's `on_stop` firing is recognised as expected and
    // doesn't emit a duplicate "recording-stopped-externally" event.
    stop_emitted: Arc<AtomicBool>,
}

#[cfg(target_os = "macos")]
struct ActiveRecording {
    id: String,
    args: StartCaptureArgs,
    // `Some` while a segment is being written. Goes to `None` on pause,
    // back to `Some` on resume with a fresh SCStream + new segment file.
    active: Option<SegmentRecorder>,
    // Segment files already finalised (one entry per pause). On stop these
    // are concatenated into `final_output` with ffmpeg.
    segments: Vec<PathBuf>,
    final_output: PathBuf,
    cursor_track: Arc<CursorTrack>,
    cursor_stop: Arc<AtomicBool>,
    cursor_poll_handle: Option<JoinHandle<()>>,
    cursor_tap_handle: Option<JoinHandle<()>>,
    cursor_tap_runloop: Arc<Mutex<Option<RunLoopHandle>>>,
}

#[cfg(not(target_os = "macos"))]
struct ActiveRecording {
    id: String,
    output: PathBuf,
    started: Instant,
}

#[derive(Default)]
struct RecordingState(Mutex<Option<ActiveRecording>>);

struct MicMeter {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

#[derive(Default)]
struct MeterState(Mutex<Option<MicMeter>>);

fn parse_ffmpeg_devices(stderr: &str) -> Vec<CaptureSource> {
    // ffmpeg prints lines like:
    //   [AVFoundation indev @ 0x...] AVFoundation video devices:
    //   [AVFoundation indev @ 0x...] [3] Capture screen 0
    //   [AVFoundation indev @ 0x...] AVFoundation audio devices:
    //   [AVFoundation indev @ 0x...] [1] MacBook Pro Microphone
    let mut sources = Vec::new();
    let mut section: Option<&str> = None;
    for raw in stderr.lines() {
        let line = raw.trim();
        if line.contains("AVFoundation video devices:") {
            section = Some("video");
            continue;
        }
        if line.contains("AVFoundation audio devices:") {
            section = Some("audio");
            continue;
        }
        let Some(sec) = section else { continue };
        // Extract "[N] Label" after the closing bracket of the prefix
        let Some(rest) = line.split("] ").nth(1) else { continue };
        // rest looks like "[3] Capture screen 0"
        if !rest.starts_with('[') {
            continue;
        }
        let Some(close) = rest.find(']') else { continue };
        let idx_str = &rest[1..close];
        let Ok(index) = idx_str.parse::<u32>() else { continue };
        let label = rest[close + 1..].trim().to_string();
        let (kind, id_prefix) = match (sec, label.to_lowercase().contains("screen")) {
            ("video", true) => ("screen", "screen"),
            ("video", false) => ("camera", "camera"),
            ("audio", _) => ("audio", "audio"),
            _ => continue,
        };
        sources.push(CaptureSource {
            id: format!("{id_prefix}:{index}"),
            kind: kind.into(),
            label,
            index,
        });
    }
    sources
}

/// Resolve the bundled ffmpeg sidecar.
///
/// Tauri's `externalBin` ships the binary next to the main executable. In a
/// production `.app` it lands as `Contents/MacOS/ffmpeg`. In `tauri dev` the
/// platform-triple suffix is preserved (e.g. `ffmpeg-aarch64-apple-darwin`),
/// so we fall back to the suffixed name when the plain one is missing.
fn ffmpeg_path() -> PathBuf {
    let exe = std::env::current_exe().expect("current_exe");
    let dir = exe.parent().expect("exe dir").to_path_buf();

    let bundled = dir.join("ffmpeg");
    if bundled.exists() {
        return bundled;
    }

    #[cfg(target_arch = "aarch64")]
    let suffixed = dir.join("ffmpeg-aarch64-apple-darwin");
    #[cfg(target_arch = "x86_64")]
    let suffixed = dir.join("ffmpeg-x86_64-apple-darwin");

    suffixed
}

#[tauri::command]
fn list_capture_sources() -> Result<Vec<CaptureSource>, String> {
    let output = Command::new(ffmpeg_path())
        .args(["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""])
        .stderr(Stdio::piped())
        .stdout(Stdio::null())
        .output()
        .map_err(|e| format!("Failed to invoke bundled ffmpeg: {e}"))?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    Ok(parse_ffmpeg_devices(&stderr))
}

fn output_path(id: &str) -> PathBuf {
    let dir = dirs_recordings_dir().unwrap_or_else(std::env::temp_dir);
    let stamp = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S");
    dir.join(format!("OpenScreen-{stamp}-{id}.mp4"))
}

fn segment_path(id: &str, n: usize) -> PathBuf {
    let dir = dirs_recordings_dir().unwrap_or_else(std::env::temp_dir);
    dir.join(format!(".oss-{id}-seg{n}.mp4"))
}

fn dirs_recordings_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let mut p = PathBuf::from(home);
    p.push("Movies");
    p.push("OpenScreen Studio");
    std::fs::create_dir_all(&p).ok()?;
    Some(p)
}

/// Build and start a fresh SCStream writing to `segment_path` for the given
/// args. Used for both the initial start and every resume after a pause.
#[cfg(target_os = "macos")]
fn build_and_start_segment(
    app: &AppHandle,
    args: &StartCaptureArgs,
    segment_path: &Path,
) -> Result<SegmentRecorder, String> {
    let fps = args.framerate.unwrap_or(30);

    let content = SCShareableContent::get()
        .map_err(|e| format!("Failed to query shareable content: {e:?}"))?;
    let display = content
        .displays()
        .into_iter()
        .find(|d| d.display_id() == args.display_id)
        .ok_or_else(|| format!("Display {} not available", args.display_id))?;

    // Build the content filter: a single window when `window_id` is set,
    // otherwise the whole display (excluding our own process windows).
    let target_window = match args.window_id {
        Some(wid) => Some(
            content
                .windows()
                .into_iter()
                .find(|w| w.window_id() == wid)
                .ok_or_else(|| format!("Window {wid} not available"))?,
        ),
        None => None,
    };

    let filter = if let Some(window) = target_window.as_ref() {
        SCContentFilter::create().with_window(window).build()
    } else {
        // Hide our own windows from the recording by excluding the current process.
        let self_pid = std::process::id() as i32;
        let self_app = content
            .applications()
            .into_iter()
            .find(|a| a.process_id() == self_pid);
        let mut filter_builder = SCContentFilter::create().with_display(&display);
        if let Some(a) = self_app.as_ref() {
            filter_builder = filter_builder.with_excluding_applications(&[a], &[]);
        } else {
            filter_builder = filter_builder.with_excluding_windows(&[]);
        }
        filter_builder.build()
    };

    // Stream pixel dimensions:
    //  - window: derive from its (point) frame scaled by the backing scale;
    //  - area (crop): size to the *cropped* region, not the full display —
    //    sizing to the full display while `source_rect` is the crop makes
    //    SCK upscale the crop to fill the frame, distorting the aspect ratio
    //    and breaking the synthetic-cursor overlay's coordinate mapping
    //    (the editor normalises cursor samples against the crop, but the
    //    video frame would carry the full-display aspect ratio);
    //  - full display: use its native pixel size.
    let backing_scale = filter.point_pixel_scale().max(1.0) as f64;
    let to_even = |n: f64| {
        let v = n.round().max(2.0) as u32;
        v - (v % 2)
    };
    let (pixel_w, pixel_h) = if let Some(window) = target_window.as_ref() {
        let frame = window.frame();
        let w = (frame.width * backing_scale).round().max(2.0) as u32;
        let h = (frame.height * backing_scale).round().max(2.0) as u32;
        (w, h)
    } else if let Some(c) = &args.crop {
        (
            to_even(c.width as f64 * backing_scale),
            to_even(c.height as f64 * backing_scale),
        )
    } else {
        (display.width(), display.height())
    };

    let mut config = SCStreamConfiguration::new()
        .with_width(pixel_w)
        .with_height(pixel_h)
        .with_pixel_format(PixelFormat::BGRA)
        // The system cursor is intentionally excluded from the video. Cursor
        // position, clicks and shape are captured into the .cursor.json
        // sidecar instead, so the editor can render a synthetic cursor with
        // custom smoothing/styling.
        .with_shows_cursor(false)
        .with_fps(fps);

    // A crop rect only makes sense for full-display capture; window capture
    // is already tightly scoped to the window's bounds.
    if target_window.is_none() {
        if let Some(c) = &args.crop {
            config = config.with_source_rect(SCKRect {
                x: c.x as f64,
                y: c.y as f64,
                width: c.width as f64,
                height: c.height as f64,
            });
        }
    }

    if args.audio_index.is_some() {
        config = config
            .with_captures_audio(true)
            .with_captures_microphone(true);
    }

    let rec_config = SCRecordingOutputConfiguration::new()
        .with_output_url(segment_path)
        .with_video_codec(SCRecordingOutputCodec::H264)
        .with_output_file_type(SCRecordingOutputFileType::MP4);

    // OS-initiated stops (the macOS menu-bar privacy pill) propagate through
    // *both* SCStream's delegate and SCRecordingOutput's delegate, but which
    // one fires first depends on macOS version and pipeline state. Wire both
    // and dedupe with `stop_emitted` so the in-app stop path (which flips the
    // flag before stopping) stays silent.
    let stop_emitted = Arc::new(AtomicBool::new(false));

    let emit_external_stop = {
        let stop_emitted = Arc::clone(&stop_emitted);
        let app = app.clone();
        move |source: &'static str, err: Option<String>| {
            eprintln!("[capture] external stop callback fired ({source}, err={err:?})");
            if stop_emitted.swap(true, Ordering::SeqCst) {
                eprintln!("[capture] external stop already emitted; skipping");
                return;
            }
            if let Err(e) = app.emit("recording-stopped-externally", ()) {
                eprintln!("[capture] failed to emit recording-stopped-externally: {e}");
            }
        }
    };

    let stream_emit = emit_external_stop.clone();
    let stream_delegate = StreamCallbacks::new().on_stop(move |err| {
        stream_emit("stream.on_stop", err);
    });

    let rec_finish_emit = emit_external_stop.clone();
    let rec_fail_emit = emit_external_stop.clone();
    let rec_delegate = RecordingCallbacks::new()
        .on_finish(move || rec_finish_emit("recording.on_finish", None))
        .on_fail(move |e| rec_fail_emit("recording.on_fail", Some(e)));

    let rec_output = SCRecordingOutput::new_with_delegate(&rec_config, rec_delegate)
        .ok_or_else(|| "Failed to create SCRecordingOutput (requires macOS 15+).".to_string())?;

    let stream = SCStream::new_with_delegate(&filter, &config, stream_delegate);
    stream
        .add_recording_output(&rec_output)
        .map_err(|e| format!("add_recording_output failed: {e:?}"))?;
    stream
        .start_capture()
        .map_err(|e| format!("start_capture failed: {e:?}"))?;

    Ok(SegmentRecorder {
        stream,
        _recording_output: rec_output,
        segment_path: segment_path.to_path_buf(),
        stop_emitted,
    })
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn start_capture(
    app: AppHandle,
    args: StartCaptureArgs,
    state: State<'_, RecordingState>,
) -> Result<String, String> {
    let mut guard = state.0.lock();
    if guard.is_some() {
        return Err("A recording is already in progress.".into());
    }

    let id = uuid::Uuid::new_v4().to_string();
    let final_output = output_path(&id);

    // Pixel dimensions for the fallback DisplayInfo below.
    let (fallback_w, fallback_h) = (1920u32, 1080u32);

    let first_segment = segment_path(&id, 0);
    let segment = build_and_start_segment(&app, &args, &first_segment)?;

    let started = Instant::now();
    let started_epoch_ms = chrono::Local::now().timestamp_millis();

    let display_info = list_displays()
        .ok()
        .and_then(|ds| ds.into_iter().find(|d| d.id == args.display_id))
        .unwrap_or(DisplayInfo {
            id: args.display_id,
            name: String::new(),
            x: 0.0,
            y: 0.0,
            width: fallback_w as f64,
            height: fallback_h as f64,
            scale_factor: 1.0,
            refresh_hz: 60,
            is_main: false,
        });

    let cursor_track = Arc::new(CursorTrack {
        samples: Mutex::new(Vec::new()),
        clicks: Mutex::new(Vec::new()),
        shapes: Mutex::new(Vec::new()),
        display: display_info.clone(),
        crop: args.crop.clone(),
        started: Mutex::new(started),
        t_offset_ms: AtomicU64::new(0),
        paused: AtomicBool::new(false),
        started_epoch_ms,
    });
    let cursor_stop = Arc::new(AtomicBool::new(false));

    // Cursor position poll, matched to the recording framerate so there's one
    // cursor sample per recorded video frame. Skips pushing while paused so
    // the sidecar timeline stays in lock-step with the concatenated MP4.
    let cursor_poll_handle = {
        let track = Arc::clone(&cursor_track);
        let stop = Arc::clone(&cursor_stop);
        let fps = args.framerate.unwrap_or(30).max(1);
        let poll_interval = Duration::from_micros(1_000_000 / fps as u64);
        Some(thread::spawn(move || {
            let mut last_shape: Option<&'static str> = None;
            while !stop.load(Ordering::Relaxed) {
                if !track.paused.load(Ordering::Relaxed) {
                    if let Some(pos) = current_cursor_position() {
                        if let Some(s) =
                            remap_to_crop_local(pos, &track.display, track.crop.as_ref())
                        {
                            let t_ms = cursor_t_ms(&track);
                            track.samples.lock().push(CursorSample { t_ms, x: s.0, y: s.1 });
                        }
                    }
                    let shape = current_cursor_shape();
                    if last_shape != Some(shape) {
                        last_shape = Some(shape);
                        let t_ms = cursor_t_ms(&track);
                        track.shapes.lock().push(CursorShapeChange { t_ms, shape });
                    }
                }
                thread::sleep(poll_interval);
            }
        }))
    };

    let cursor_tap_runloop: Arc<Mutex<Option<RunLoopHandle>>> = Arc::new(Mutex::new(None));
    let cursor_tap_handle = if unsafe { AXIsProcessTrusted() } {
        let track = Arc::clone(&cursor_track);
        let runloop_slot = Arc::clone(&cursor_tap_runloop);
        Some(thread::spawn(move || {
            run_click_tap(track, runloop_slot);
        }))
    } else {
        eprintln!("[cursor] Accessibility not granted; click capture disabled.");
        None
    };

    let _ = started; // anchor only used for the cursor track now.
    *guard = Some(ActiveRecording {
        id: id.clone(),
        args,
        active: Some(segment),
        segments: Vec::new(),
        final_output,
        cursor_track,
        cursor_stop,
        cursor_poll_handle,
        cursor_tap_handle,
        cursor_tap_runloop,
    });
    Ok(id)
}

#[cfg(target_os = "macos")]
fn remap_to_crop_local(
    pos: CGPoint,
    display: &DisplayInfo,
    crop: Option<&CropRect>,
) -> Option<(f64, f64)> {
    let lx = pos.x - display.x;
    let ly = pos.y - display.y;
    if lx < 0.0 || ly < 0.0 || lx > display.width || ly > display.height {
        return None;
    }
    if let Some(c) = crop {
        let cx = lx - c.x as f64;
        let cy = ly - c.y as f64;
        if cx < 0.0 || cy < 0.0 || cx > c.width as f64 || cy > c.height as f64 {
            return None;
        }
        Some((cx, cy))
    } else {
        Some((lx, ly))
    }
}

#[cfg(target_os = "macos")]
extern "C" fn cursor_tap_callback(
    _proxy: *mut std::ffi::c_void,
    event_type: u32,
    event: *mut std::ffi::c_void,
    user_info: *mut std::ffi::c_void,
) -> *mut std::ffi::c_void {
    // user_info is an Arc<CursorTrack> kept alive by the spawning thread; we
    // borrow it without taking ownership so we don't decrement the strong count.
    let (button, kind) = match event_type {
        CG_EVENT_LEFT_MOUSE_DOWN => ("left", "down"),
        CG_EVENT_LEFT_MOUSE_UP => ("left", "up"),
        CG_EVENT_RIGHT_MOUSE_DOWN => ("right", "down"),
        CG_EVENT_RIGHT_MOUSE_UP => ("right", "up"),
        CG_EVENT_OTHER_MOUSE_DOWN => ("other", "down"),
        CG_EVENT_OTHER_MOUSE_UP => ("other", "up"),
        _ => return event,
    };
    if user_info.is_null() {
        return event;
    }
    unsafe {
        let track = &*(user_info as *const CursorTrack);
        if track.paused.load(Ordering::Relaxed) {
            return event;
        }
        let pos = CGEventGetLocation(event);
        if let Some((x, y)) = remap_to_crop_local(pos, &track.display, track.crop.as_ref()) {
            let t_ms = cursor_t_ms(track);
            track.clicks.lock().push(CursorClick { t_ms, x, y, button, kind });
        }
    }
    event
}

#[cfg(target_os = "macos")]
fn run_click_tap(track: Arc<CursorTrack>, runloop_slot: Arc<Mutex<Option<RunLoopHandle>>>) {
    let mask: u64 = (1u64 << CG_EVENT_LEFT_MOUSE_DOWN)
        | (1u64 << CG_EVENT_LEFT_MOUSE_UP)
        | (1u64 << CG_EVENT_RIGHT_MOUSE_DOWN)
        | (1u64 << CG_EVENT_RIGHT_MOUSE_UP)
        | (1u64 << CG_EVENT_OTHER_MOUSE_DOWN)
        | (1u64 << CG_EVENT_OTHER_MOUSE_UP);

    let user_info = Arc::as_ptr(&track) as *mut std::ffi::c_void;
    let tap = unsafe {
        CGEventTapCreate(
            CG_SESSION_EVENT_TAP,
            CG_HEAD_INSERT_EVENT_TAP,
            CG_EVENT_TAP_OPTION_LISTEN_ONLY,
            mask,
            cursor_tap_callback,
            user_info,
        )
    };
    if tap.is_null() {
        eprintln!("[cursor] CGEventTapCreate returned null; click capture skipped.");
        return;
    }
    unsafe {
        let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
        if source.is_null() {
            CFRelease(tap as *const _);
            eprintln!("[cursor] CFMachPortCreateRunLoopSource failed.");
            return;
        }
        let rl = CFRunLoopGetCurrent();
        CFRunLoopAddSource(rl, source, kCFRunLoopCommonModes);
        CGEventTapEnable(tap, true);
        *runloop_slot.lock() = Some(RunLoopHandle(rl));
        CFRunLoopRun();
        // Returns after CFRunLoopStop is called from stop_capture.
        CGEventTapEnable(tap, false);
        CFRelease(source as *const _);
        CFRelease(tap as *const _);
    }
    // Hold the Arc through the run loop lifetime; drop happens here.
    drop(track);
}

// Fingerprint a cursor by its rendered image (TIFF bytes) plus hot-spot. Two
// cursors with the same fingerprint are the same shape. `NSCursor` is one of
// the few AppKit classes Apple documents as thread-safe, so calling this from
// the poll thread is sound (objc2 also models it as non-main-thread-only).
#[cfg(target_os = "macos")]
fn cursor_image_fingerprint(cur: &objc2_app_kit::NSCursor) -> Option<u64> {
    let tiff = cur.image().TIFFRepresentation()?;
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in tiff.to_vec() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    let hs = cur.hotSpot();
    h ^= hs.x.to_bits().rotate_left(17);
    h ^= hs.y.to_bits().rotate_left(31);
    Some(h)
}

// Fingerprint → name table for the standard AppKit cursors, built once. The
// names mirror the CSS `cursor` keyword set where one exists so the editor can
// map them straight onto styled overlay assets.
#[cfg(target_os = "macos")]
#[allow(deprecated)] // resize* cursors: still the correct shapes pre-macOS 15 APIs
fn known_cursor_shapes() -> &'static [(u64, &'static str)] {
    use objc2::rc::Retained;
    use objc2_app_kit::NSCursor;
    use std::sync::OnceLock;
    static TABLE: OnceLock<Vec<(u64, &'static str)>> = OnceLock::new();
    TABLE.get_or_init(|| {
        fn add(v: &mut Vec<(u64, &'static str)>, c: Retained<NSCursor>, name: &'static str) {
            if let Some(fp) = cursor_image_fingerprint(&c) {
                v.push((fp, name));
            }
        }
        let mut v = Vec::new();
        add(&mut v, NSCursor::arrowCursor(), "arrow");
        add(&mut v, NSCursor::IBeamCursor(), "text");
        add(&mut v, NSCursor::IBeamCursorForVerticalLayout(), "verticalText");
        add(&mut v, NSCursor::pointingHandCursor(), "pointer");
        add(&mut v, NSCursor::closedHandCursor(), "grabbing");
        add(&mut v, NSCursor::openHandCursor(), "grab");
        add(&mut v, NSCursor::crosshairCursor(), "crosshair");
        add(&mut v, NSCursor::operationNotAllowedCursor(), "notAllowed");
        add(&mut v, NSCursor::dragLinkCursor(), "alias");
        add(&mut v, NSCursor::dragCopyCursor(), "copy");
        add(&mut v, NSCursor::contextualMenuCursor(), "contextMenu");
        add(&mut v, NSCursor::disappearingItemCursor(), "disappearingItem");
        add(&mut v, NSCursor::resizeLeftCursor(), "resizeLeft");
        add(&mut v, NSCursor::resizeRightCursor(), "resizeRight");
        add(&mut v, NSCursor::resizeLeftRightCursor(), "resizeLeftRight");
        add(&mut v, NSCursor::resizeUpCursor(), "resizeUp");
        add(&mut v, NSCursor::resizeDownCursor(), "resizeDown");
        add(&mut v, NSCursor::resizeUpDownCursor(), "resizeUpDown");
        v
    })
}

#[cfg(target_os = "macos")]
#[allow(deprecated)] // currentSystemCursor: Apple suggests SCK showsCursor, but
                     // a custom overlay is the whole point — we need the shape.
fn current_cursor_shape() -> &'static str {
    let Some(cur) = objc2_app_kit::NSCursor::currentSystemCursor() else {
        return "unknown";
    };
    let Some(fp) = cursor_image_fingerprint(&cur) else {
        return "unknown";
    };
    for (known, name) in known_cursor_shapes() {
        if *known == fp {
            return name;
        }
    }
    "unknown"
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn start_capture(
    _app: AppHandle,
    _args: StartCaptureArgs,
    _state: State<'_, RecordingState>,
) -> Result<String, String> {
    Err("Screen capture is only implemented on macOS.".into())
}

/// Stop the active segment (if any) and push its file onto `segments`.
/// Sets `stop_emitted` first so the SCK delegate's on_stop fires silently.
#[cfg(target_os = "macos")]
fn stop_active_segment(rec: &mut ActiveRecording) -> Result<(), String> {
    if let Some(seg) = rec.active.take() {
        seg.stop_emitted.store(true, Ordering::SeqCst);
        seg.stream
            .stop_capture()
            .map_err(|e| format!("stop_capture failed: {e:?}"))?;
        // SCRecordingOutput finalises the moov atom asynchronously after stop;
        // give it a beat so the segment file is playable when concatenated.
        std::thread::sleep(Duration::from_millis(400));
        rec.segments.push(seg.segment_path);
    }
    Ok(())
}

/// Stop cursor-tracking threads and drain the captured samples + clicks.
#[cfg(target_os = "macos")]
fn drain_cursor_track(
    rec: &mut ActiveRecording,
) -> (Vec<CursorSample>, Vec<CursorClick>, Vec<CursorShapeChange>) {
    rec.cursor_stop.store(true, Ordering::Relaxed);
    if let Some(rl) = rec.cursor_tap_runloop.lock().take() {
        unsafe { CFRunLoopStop(rl.0) };
    }
    if let Some(h) = rec.cursor_poll_handle.take() {
        let _ = h.join();
    }
    if let Some(h) = rec.cursor_tap_handle.take() {
        let _ = h.join();
    }
    let samples = std::mem::take(&mut *rec.cursor_track.samples.lock());
    let clicks = std::mem::take(&mut *rec.cursor_track.clicks.lock());
    let shapes = std::mem::take(&mut *rec.cursor_track.shapes.lock());
    (samples, clicks, shapes)
}

/// Concatenate `segments` into `final_output`. If there's exactly one segment
/// we just rename it; otherwise we shell out to the bundled ffmpeg using the
/// concat demuxer. Segment files are removed on success.
fn concat_segments(segments: &[PathBuf], final_output: &Path) -> Result<(), String> {
    if segments.is_empty() {
        return Err("No recording data to finalize.".into());
    }
    if segments.len() == 1 {
        std::fs::rename(&segments[0], final_output)
            .map_err(|e| format!("Failed to move segment to final output: {e}"))?;
        return Ok(());
    }

    let list_path = std::env::temp_dir().join(format!(
        "oss-concat-{}.txt",
        chrono::Local::now().format("%Y%m%d%H%M%S%f")
    ));
    let mut list = String::new();
    for seg in segments {
        // The concat demuxer needs paths in single quotes with any internal
        // single quotes escaped.
        let p = seg.to_string_lossy().replace('\'', "'\\''");
        list.push_str(&format!("file '{p}'\n"));
    }
    std::fs::write(&list_path, list).map_err(|e| format!("Failed to write concat list: {e}"))?;

    let status = Command::new(ffmpeg_path())
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
        ])
        .arg(&list_path)
        .args(["-c", "copy"])
        .arg(final_output)
        .status()
        .map_err(|e| format!("Failed to invoke ffmpeg: {e}"))?;

    let _ = std::fs::remove_file(&list_path);

    if !status.success() {
        return Err(format!("ffmpeg concat failed: exit {status}"));
    }

    for seg in segments {
        let _ = std::fs::remove_file(seg);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn finalize_recording(mut rec: ActiveRecording) -> Result<CaptureArtifact, String> {
    // Stop the active segment first (if `stop_capture` didn't already) so
    // every segment file is on disk and finalised.
    stop_active_segment(&mut rec)?;

    // Duration excludes paused intervals — match the concatenated MP4.
    let duration_ms = cursor_t_ms(&rec.cursor_track) as u64;

    let (samples, clicks, cursor_shapes) = drain_cursor_track(&mut rec);

    concat_segments(&rec.segments, &rec.final_output)?;

    let sidecar = CursorSidecar {
        version: 2,
        recording_id: &rec.id,
        started_epoch_ms: rec.cursor_track.started_epoch_ms,
        duration_ms,
        display: CursorSidecarDisplay {
            id: rec.cursor_track.display.id,
            origin_x: rec.cursor_track.display.x,
            origin_y: rec.cursor_track.display.y,
            width: rec.cursor_track.display.width,
            height: rec.cursor_track.display.height,
            scale_factor: rec.cursor_track.display.scale_factor,
        },
        crop: rec.cursor_track.crop.as_ref(),
        samples,
        clicks,
        cursor_shapes,
    };
    let sidecar_path = rec.final_output.with_extension("cursor.json");
    if let Err(e) = (|| -> std::io::Result<()> {
        let f = fs::File::create(&sidecar_path)?;
        serde_json::to_writer(f, &sidecar)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
    })() {
        eprintln!("[cursor] failed to write sidecar {sidecar_path:?}: {e}");
    }

    Ok(CaptureArtifact {
        id: rec.id,
        path: rec.final_output.to_string_lossy().to_string(),
        duration_ms,
    })
}

/// Discard everything tied to `rec`: stop the active segment, kill cursor
/// threads, and delete every segment file plus any sidecar that was written.
#[cfg(target_os = "macos")]
fn discard_recording(mut rec: ActiveRecording) {
    let _ = stop_active_segment(&mut rec);
    let _ = drain_cursor_track(&mut rec);
    for seg in &rec.segments {
        let _ = std::fs::remove_file(seg);
    }
    // The final output isn't written yet (concat hasn't run), but a stale
    // sidecar from a prior run could collide; clean it up to be safe.
    let _ = std::fs::remove_file(rec.final_output.with_extension("cursor.json"));
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn stop_capture(state: State<'_, RecordingState>) -> Result<CaptureArtifact, String> {
    let rec = state
        .0
        .lock()
        .take()
        .ok_or_else(|| "No active recording.".to_string())?;
    finalize_recording(rec)
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn finalize_external_stop(state: State<'_, RecordingState>) -> Result<CaptureArtifact, String> {
    // The active SCStream is already stopped by the OS; close out any
    // earlier segments + this one and concat.
    let mut rec = state
        .0
        .lock()
        .take()
        .ok_or_else(|| "No active recording.".to_string())?;
    // The OS stopped the stream itself, so we don't call stop_capture on it
    // — but we still need to push the segment path so it's included in the
    // concat. Take the segment out of `active` without going through
    // `stop_active_segment` (which would try to stop a dead stream).
    if let Some(seg) = rec.active.take() {
        std::thread::sleep(Duration::from_millis(400));
        rec.segments.push(seg.segment_path);
    }
    finalize_recording(rec)
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn pause_capture(state: State<'_, RecordingState>) -> Result<(), String> {
    let mut guard = state.0.lock();
    let rec = guard.as_mut().ok_or_else(|| "No active recording.".to_string())?;
    if rec.active.is_none() {
        return Ok(()); // already paused
    }
    // Bank the time elapsed in this segment before flipping `paused` — the
    // cursor poll/tap callbacks read `paused` to decide whether to push.
    {
        let elapsed = rec.cursor_track.started.lock().elapsed().as_millis() as u64;
        rec.cursor_track
            .t_offset_ms
            .fetch_add(elapsed, Ordering::Relaxed);
        rec.cursor_track.paused.store(true, Ordering::Relaxed);
    }
    stop_active_segment(rec)
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn resume_capture(
    app: AppHandle,
    state: State<'_, RecordingState>,
) -> Result<(), String> {
    let mut guard = state.0.lock();
    let rec = guard.as_mut().ok_or_else(|| "No active recording.".to_string())?;
    if rec.active.is_some() {
        return Ok(()); // already recording
    }
    let next_idx = rec.segments.len();
    let path = segment_path(&rec.id, next_idx);
    let segment = build_and_start_segment(&app, &rec.args, &path)?;
    rec.active = Some(segment);
    // Reset the per-segment clock anchor and clear `paused` only after the
    // new stream is up so we don't push cursor samples into a dead segment.
    *rec.cursor_track.started.lock() = Instant::now();
    rec.cursor_track.paused.store(false, Ordering::Relaxed);
    Ok(())
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn cancel_capture(state: State<'_, RecordingState>) -> Result<(), String> {
    let rec = state
        .0
        .lock()
        .take()
        .ok_or_else(|| "No active recording.".to_string())?;
    discard_recording(rec);
    Ok(())
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn restart_capture(
    app: AppHandle,
    state: State<'_, RecordingState>,
) -> Result<String, String> {
    let prev_args = {
        let mut guard = state.0.lock();
        let rec = guard.take().ok_or_else(|| "No active recording.".to_string())?;
        let args = rec.args.clone();
        discard_recording(rec);
        args
    };
    start_capture(app, prev_args, state)
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn stop_capture(_state: State<'_, RecordingState>) -> Result<CaptureArtifact, String> {
    Err("Screen capture is only implemented on macOS.".into())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn finalize_external_stop(_state: State<'_, RecordingState>) -> Result<CaptureArtifact, String> {
    Err("Screen capture is only implemented on macOS.".into())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn pause_capture(_state: State<'_, RecordingState>) -> Result<(), String> {
    Err("Screen capture is only implemented on macOS.".into())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn resume_capture(
    _app: AppHandle,
    _state: State<'_, RecordingState>,
) -> Result<(), String> {
    Err("Screen capture is only implemented on macOS.".into())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn cancel_capture(_state: State<'_, RecordingState>) -> Result<(), String> {
    Err("Screen capture is only implemented on macOS.".into())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn restart_capture(
    _app: AppHandle,
    _state: State<'_, RecordingState>,
) -> Result<String, String> {
    Err("Screen capture is only implemented on macOS.".into())
}

#[tauri::command]
fn is_recording(state: State<'_, RecordingState>) -> bool {
    state.0.lock().is_some()
}

fn build_meter_stream(
    app: AppHandle,
    stop: Arc<AtomicBool>,
) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();
    let device = host.default_input_device()
        .ok_or_else(|| "No default audio input device.".to_string())?;
    let config = device.default_input_config()
        .map_err(|e| format!("Default input config failed: {e}"))?;

    let last_emit = Arc::new(Mutex::new(Instant::now()));
    let peak = Arc::new(Mutex::new(0f32));
    let err_fn = |e| eprintln!("cpal stream error: {e}");

    macro_rules! handler {
        ($ty:ty, $norm:expr) => {{
            let stop = Arc::clone(&stop);
            let last_emit = Arc::clone(&last_emit);
            let peak = Arc::clone(&peak);
            let app = app.clone();
            move |data: &[$ty], _: &cpal::InputCallbackInfo| {
                if stop.load(Ordering::Relaxed) { return; }
                let mut p = *peak.lock();
                for &s in data {
                    let a = ($norm)(s).abs();
                    if a > p { p = a; }
                }
                *peak.lock() = p;
                let mut last = last_emit.lock();
                if last.elapsed() >= Duration::from_millis(33) {
                    *last = Instant::now();
                    let level = peak.lock().min(1.0);
                    *peak.lock() = 0.0;
                    let _ = app.emit("mic-level", level);
                }
            }
        }};
    }

    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config.into(),
            handler!(f32, |s: f32| s),
            err_fn,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config.into(),
            handler!(i16, |s: i16| s as f32 / i16::MAX as f32),
            err_fn,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &config.into(),
            handler!(u16, |s: u16| (s as f32 - u16::MAX as f32 / 2.0) / (u16::MAX as f32 / 2.0)),
            err_fn,
            None,
        ),
        other => return Err(format!("Unsupported sample format: {other:?}")),
    }
    .map_err(|e| format!("Failed to build mic stream: {e}"))?;

    stream.play().map_err(|e| format!("Failed to start mic stream: {e}"))?;
    Ok(stream)
}

#[tauri::command]
fn start_mic_meter(app: AppHandle, state: State<'_, MeterState>) -> Result<(), String> {
    let mut guard = state.0.lock();
    if guard.is_some() {
        return Ok(()); // already running
    }

    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_thread = Arc::clone(&stop);
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    let app_for_thread = app.clone();

    // cpal::Stream is !Send on macOS, so own it in a dedicated thread.
    let handle = thread::spawn(move || {
        let stream = match build_meter_stream(app_for_thread, Arc::clone(&stop_for_thread)) {
            Ok(s) => {
                let _ = ready_tx.send(Ok(()));
                s
            }
            Err(e) => {
                let _ = ready_tx.send(Err(e));
                return;
            }
        };
        // Park until asked to stop.
        while !stop_for_thread.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(50));
        }
        drop(stream);
    });

    match ready_rx.recv_timeout(Duration::from_secs(2)) {
        Ok(Ok(())) => {
            *guard = Some(MicMeter { stop, handle: Some(handle) });
            Ok(())
        }
        Ok(Err(e)) => Err(e),
        Err(e) => Err(format!("Mic meter init timed out: {e}")),
    }
}

#[tauri::command]
fn stop_mic_meter(state: State<'_, MeterState>) -> Result<(), String> {
    if let Some(mut meter) = state.0.lock().take() {
        meter.stop.store(true, Ordering::Relaxed);
        if let Some(h) = meter.handle.take() {
            let _ = h.join();
        }
    }
    Ok(())
}

// --- Display enumeration + picker overlays ---------------------------------

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Copy, Clone)]
struct CGPoint { x: f64, y: f64 }
#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Copy, Clone)]
struct CGSize { width: f64, height: f64 }
#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Copy, Clone)]
struct CGRect { origin: CGPoint, size: CGSize }

#[cfg(target_os = "macos")]
#[allow(non_camel_case_types)]
type CGDirectDisplayID = u32;

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGGetActiveDisplayList(max: u32, displays: *mut CGDirectDisplayID, count: *mut u32) -> i32;
    fn CGDisplayBounds(display: CGDirectDisplayID) -> CGRect;
    fn CGDisplayPixelsWide(display: CGDirectDisplayID) -> usize;
    fn CGDisplayPixelsHigh(display: CGDirectDisplayID) -> usize;
    fn CGDisplayCopyDisplayMode(display: CGDirectDisplayID) -> *mut std::ffi::c_void;
    fn CGDisplayModeGetRefreshRate(mode: *mut std::ffi::c_void) -> f64;
    fn CGDisplayModeRelease(mode: *mut std::ffi::c_void);
    fn CGDisplayIsBuiltin(display: CGDirectDisplayID) -> i32;
    fn CGMainDisplayID() -> CGDirectDisplayID;

    fn CGEventCreate(source: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
    fn CGEventGetLocation(event: *mut std::ffi::c_void) -> CGPoint;
    fn CGEventTapCreate(
        tap: u32,
        place: u32,
        options: u32,
        events_of_interest: u64,
        callback: CGEventTapCallBack,
        user_info: *mut std::ffi::c_void,
    ) -> *mut std::ffi::c_void;
    fn CGEventTapEnable(tap: *mut std::ffi::c_void, enable: bool);

    fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> core_foundation::array::CFArrayRef;
}

#[cfg(target_os = "macos")]
pub type CGEventTapCallBack = extern "C" fn(
    proxy: *mut std::ffi::c_void,
    event_type: u32,
    event: *mut std::ffi::c_void,
    user_info: *mut std::ffi::c_void,
) -> *mut std::ffi::c_void;

#[cfg(target_os = "macos")]
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: *const std::ffi::c_void);
    fn CFMachPortCreateRunLoopSource(
        allocator: *const std::ffi::c_void,
        port: *mut std::ffi::c_void,
        order: i64,
    ) -> *mut std::ffi::c_void;
    fn CFRunLoopGetCurrent() -> CFRunLoopRef;
    fn CFRunLoopAddSource(
        rl: CFRunLoopRef,
        source: *mut std::ffi::c_void,
        mode: *const std::ffi::c_void,
    );
    fn CFRunLoopRun();
    fn CFRunLoopStop(rl: CFRunLoopRef);
    static kCFRunLoopCommonModes: *const std::ffi::c_void;
}

// CGEventType values we care about (Quartz Event Services).
#[cfg(target_os = "macos")]
const CG_EVENT_LEFT_MOUSE_DOWN: u32 = 1;
#[cfg(target_os = "macos")]
const CG_EVENT_LEFT_MOUSE_UP: u32 = 2;
#[cfg(target_os = "macos")]
const CG_EVENT_RIGHT_MOUSE_DOWN: u32 = 3;
#[cfg(target_os = "macos")]
const CG_EVENT_RIGHT_MOUSE_UP: u32 = 4;
#[cfg(target_os = "macos")]
const CG_EVENT_OTHER_MOUSE_DOWN: u32 = 25;
#[cfg(target_os = "macos")]
const CG_EVENT_OTHER_MOUSE_UP: u32 = 26;
// kCGSessionEventTap / kCGHeadInsertEventTap / kCGEventTapOptionListenOnly.
#[cfg(target_os = "macos")]
const CG_SESSION_EVENT_TAP: u32 = 1;
#[cfg(target_os = "macos")]
const CG_HEAD_INSERT_EVENT_TAP: u32 = 0;
#[cfg(target_os = "macos")]
const CG_EVENT_TAP_OPTION_LISTEN_ONLY: u32 = 1;

// CGWindowListOption flags
#[cfg(target_os = "macos")]
const CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY: u32 = 1 << 0;
#[cfg(target_os = "macos")]
const CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS: u32 = 1 << 4;
#[cfg(target_os = "macos")]
const CG_NULL_WINDOW_ID: u32 = 0;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfo {
    pub id: u32,           // CGDirectDisplayID — fed straight to ScreenCaptureKit
    pub name: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale_factor: f64,
    pub refresh_hz: u32,
    pub is_main: bool,
}

#[tauri::command]
fn list_displays() -> Result<Vec<DisplayInfo>, String> {
    #[cfg(target_os = "macos")]
    {
        unsafe {
            let mut ids = [0u32; 16];
            let mut count: u32 = 0;
            let err = CGGetActiveDisplayList(ids.len() as u32, ids.as_mut_ptr(), &mut count);
            if err != 0 {
                return Err(format!("CGGetActiveDisplayList failed: {err}"));
            }
            let main = CGMainDisplayID();
            let mut out = Vec::with_capacity(count as usize);
            let mut external_n = 1u32;
            for i in 0..(count as usize) {
                let id = ids[i];
                let bounds = CGDisplayBounds(id);
                let pw = CGDisplayPixelsWide(id) as f64;
                let _ph = CGDisplayPixelsHigh(id) as f64;
                let scale = if bounds.size.width > 0.0 { pw / bounds.size.width } else { 1.0 };
                let mode = CGDisplayCopyDisplayMode(id);
                let mut hz = if mode.is_null() { 0.0 } else { CGDisplayModeGetRefreshRate(mode) };
                if !mode.is_null() { CGDisplayModeRelease(mode); }
                if hz < 1.0 { hz = 60.0; }
                let is_main = id == main;
                let is_builtin = CGDisplayIsBuiltin(id) != 0;
                let name = if is_builtin {
                    "Built-in Retina Display".to_string()
                } else {
                    let n = external_n;
                    external_n += 1;
                    format!("External Display {n}")
                };
                out.push(DisplayInfo {
                    id,
                    name,
                    x: bounds.origin.x,
                    y: bounds.origin.y,
                    width: bounds.size.width,
                    height: bounds.size.height,
                    scale_factor: scale,
                    refresh_hz: hz.round() as u32,
                    is_main,
                });
            }
            // Sort: main first, then others (cosmetic; preserves CG order otherwise).
            out.sort_by_key(|d| if d.is_main { 0 } else { 1 });
            Ok(out)
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(Vec::new())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub id: u32,            // CGWindowID
    pub owner: String,
    pub title: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub display_id: u32,    // CGDirectDisplayID containing the window's center
}

#[cfg(target_os = "macos")]
fn list_windows_inner(displays: &[DisplayInfo]) -> Vec<WindowInfo> {
    use core_foundation::array::{CFArray, CFArrayRef};
    use core_foundation::base::{CFType, TCFType, ItemRef};
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;

    let arr_ref: CFArrayRef = unsafe {
        CGWindowListCopyWindowInfo(
            CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY | CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS,
            CG_NULL_WINDOW_ID,
        )
    };
    if arr_ref.is_null() { return Vec::new(); }
    let arr: CFArray<CFType> = unsafe { CFArray::wrap_under_create_rule(arr_ref) };

    let key_layer    = CFString::from_static_string("kCGWindowLayer");
    let key_bounds   = CFString::from_static_string("kCGWindowBounds");
    let key_owner    = CFString::from_static_string("kCGWindowOwnerName");
    let key_title    = CFString::from_static_string("kCGWindowName");
    let key_number   = CFString::from_static_string("kCGWindowNumber");
    let key_alpha    = CFString::from_static_string("kCGWindowAlpha");
    let key_x        = CFString::from_static_string("X");
    let key_y        = CFString::from_static_string("Y");
    let key_w        = CFString::from_static_string("Width");
    let key_h        = CFString::from_static_string("Height");

    let mut out = Vec::new();
    for item in arr.iter() {
        let dict: ItemRef<CFType> = item;
        let dict_ref = dict.as_concrete_TypeRef() as core_foundation::dictionary::CFDictionaryRef;
        let dict: CFDictionary = unsafe { CFDictionary::wrap_under_get_rule(dict_ref) };

        // Layer 0 == normal app windows; skip menubar/dock/etc.
        let layer: i64 = dict.find(key_layer.as_concrete_TypeRef() as *const _)
            .and_then(|v| unsafe { CFNumber::wrap_under_get_rule(*v as *const _) }.to_i64())
            .unwrap_or(99);
        if layer != 0 { continue; }

        // Skip transparent windows (alpha 0).
        let alpha: f64 = dict.find(key_alpha.as_concrete_TypeRef() as *const _)
            .and_then(|v| unsafe { CFNumber::wrap_under_get_rule(*v as *const _) }.to_f64())
            .unwrap_or(1.0);
        if alpha <= 0.01 { continue; }

        let id: u32 = dict.find(key_number.as_concrete_TypeRef() as *const _)
            .and_then(|v| unsafe { CFNumber::wrap_under_get_rule(*v as *const _) }.to_i64())
            .map(|n| n as u32)
            .unwrap_or(0);
        if id == 0 { continue; }

        let owner: String = dict.find(key_owner.as_concrete_TypeRef() as *const _)
            .map(|v| unsafe { CFString::wrap_under_get_rule(*v as *const _) }.to_string())
            .unwrap_or_default();

        let title: String = dict.find(key_title.as_concrete_TypeRef() as *const _)
            .map(|v| unsafe { CFString::wrap_under_get_rule(*v as *const _) }.to_string())
            .unwrap_or_default();

        // Bounds is a CFDictionary { X, Y, Width, Height }.
        let bounds_ref = match dict.find(key_bounds.as_concrete_TypeRef() as *const _) {
            Some(v) => *v as core_foundation::dictionary::CFDictionaryRef,
            None => continue,
        };
        let bounds: CFDictionary = unsafe { CFDictionary::wrap_under_get_rule(bounds_ref) };
        let f = |k: &CFString| bounds.find(k.as_concrete_TypeRef() as *const _)
            .and_then(|v| unsafe { CFNumber::wrap_under_get_rule(*v as *const _) }.to_f64())
            .unwrap_or(0.0);
        let x = f(&key_x); let y = f(&key_y); let w = f(&key_w); let h = f(&key_h);
        if w < 40.0 || h < 40.0 { continue; }
        if owner.is_empty() && title.is_empty() { continue; }

        // Assign to display containing window center.
        let cx = x + w / 2.0;
        let cy = y + h / 2.0;
        let display_id = displays.iter()
            .find(|d| cx >= d.x && cx < d.x + d.width && cy >= d.y && cy < d.y + d.height)
            .map(|d| d.id)
            .unwrap_or(0);
        if display_id == 0 { continue; }

        out.push(WindowInfo { id, owner, title, x, y, width: w, height: h, display_id });
    }
    out
}

#[cfg(not(target_os = "macos"))]
fn list_windows_inner(_displays: &[DisplayInfo]) -> Vec<WindowInfo> { Vec::new() }

#[tauri::command]
fn list_windows() -> Result<Vec<WindowInfo>, String> {
    let displays = list_displays()?;
    Ok(list_windows_inner(&displays))
}

// --- Picker cursor tracker --------------------------------------------------

#[derive(Default)]
struct PickerTrackerState(Mutex<Option<PickerTracker>>);

struct PickerTracker {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

#[cfg(target_os = "macos")]
fn current_cursor_position() -> Option<CGPoint> {
    unsafe {
        let evt = CGEventCreate(std::ptr::null_mut());
        if evt.is_null() { return None; }
        let loc = CGEventGetLocation(evt);
        CFRelease(evt as *const _);
        Some(loc)
    }
}

#[cfg(not(target_os = "macos"))]
fn current_cursor_position() -> Option<CGPoint> { None }

fn start_picker_tracker(
    app: AppHandle,
    mode: String,
    displays: Vec<DisplayInfo>,
    windows: Vec<WindowInfo>,
    state: &PickerTrackerState,
) {
    let mut guard = state.0.lock();
    if let Some(mut t) = guard.take() {
        t.stop.store(true, Ordering::Relaxed);
        if let Some(h) = t.handle.take() { let _ = h.join(); }
    }

    let stop = Arc::new(AtomicBool::new(false));
    let stop_t = Arc::clone(&stop);
    let app_t = app.clone();
    let handle = thread::spawn(move || {
        // Emit every tick (no change-detection): pickers need a few hundred ms
        // to mount their listener, and a missed initial event would leave them
        // looking inert until the cursor moves between displays.
        while !stop_t.load(Ordering::Relaxed) {
            let Some(pos) = current_cursor_position() else {
                thread::sleep(Duration::from_millis(80));
                continue;
            };
            let display_id = displays.iter()
                .find(|d| pos.x >= d.x && pos.x < d.x + d.width
                       && pos.y >= d.y && pos.y < d.y + d.height)
                .map(|d| d.id);

            if mode == "display" {
                let _ = app_t.emit("picker-hover", serde_json::json!({
                    "mode": "display",
                    "displayId": display_id,
                }));
            } else if mode == "window" {
                // Front-to-back hit test (windows snapshot is in CGWindowList order).
                let w = windows.iter().find(|w| {
                    pos.x >= w.x && pos.x < w.x + w.width
                        && pos.y >= w.y && pos.y < w.y + w.height
                });
                let _ = app_t.emit("picker-hover", serde_json::json!({
                    "mode": "window",
                    "displayId": w.map(|w| w.display_id).or(display_id),
                    "windowId": w.map(|w| w.id),
                    "owner": w.map(|w| w.owner.clone()),
                    "title": w.map(|w| w.title.clone()),
                    "rect": w.map(|w| serde_json::json!({
                        "x": w.x, "y": w.y, "w": w.width, "h": w.height,
                    })),
                }));
            }
            thread::sleep(Duration::from_millis(33));
        }
    });
    *guard = Some(PickerTracker { stop, handle: Some(handle) });
}

fn stop_picker_tracker(state: &PickerTrackerState) {
    if let Some(mut t) = state.0.lock().take() {
        t.stop.store(true, Ordering::Relaxed);
        if let Some(h) = t.handle.take() { let _ = h.join(); }
    }
}

#[cfg(target_os = "macos")]
fn set_ns_window_level(win: &tauri::WebviewWindow, level: isize) {
    use objc2_app_kit::NSWindow;
    if let Ok(ns_window) = win.ns_window() {
        let ns_window: &NSWindow = unsafe { &*(ns_window as *const NSWindow) };
        ns_window.setLevel(level);
    }
}

#[cfg(not(target_os = "macos"))]
fn set_ns_window_level(_win: &tauri::WebviewWindow, _level: isize) {}

// NSWindow levels we care about.
const NS_WINDOW_LEVEL_STATUS: isize = 25;        // pickers sit here
const NS_WINDOW_LEVEL_POPUP: isize = 101;        // HUD sits above pickers

#[tauri::command]
fn open_picker_overlays(
    app: AppHandle,
    mode: String,
    tracker: State<'_, PickerTrackerState>,
) -> Result<(), String> {
    let displays = list_displays()?;
    if displays.is_empty() {
        return Err("No displays detected.".into());
    }

    // Close any stale pickers first (and stop any prior tracker).
    let _ = close_picker_overlays_inner(&app, &tracker);

    let windows = if mode == "window" {
        list_windows_inner(&displays)
    } else {
        Vec::new()
    };

    for d in &displays {
        let label = format!("picker-{}", d.id);
        let url = format!(
            "index.html?picker={}&displayId={}&name={}&x={}&y={}&w={}&h={}&hz={}&scale={}",
            urlencoding_lite(&mode),
            d.id,
            urlencoding_lite(&d.name),
            d.x as i32,
            d.y as i32,
            d.width as u32,
            d.height as u32,
            d.refresh_hz,
            d.scale_factor,
        );
        let win = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
            .title("OpenScreen Picker")
            .position(d.x, d.y)
            .inner_size(d.width, d.height)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .focused(false)
            .visible(false)
            .build()
            .map_err(|e| format!("Failed to create picker for display {}: {e}", d.id))?;
        set_ns_window_level(&win, NS_WINDOW_LEVEL_STATUS);
        win.show().map_err(|e| e.to_string())?;
    }

    // Re-raise the HUD above the pickers and notify it to fade.
    if let Some(hud) = app.get_webview_window("hud") {
        set_ns_window_level(&hud, NS_WINDOW_LEVEL_POPUP);
        let _ = hud.set_always_on_top(true);
        let _ = hud.emit("picker-state", "open");
    }

    // Area mode handles drag locally per-overlay; no central cursor tracking needed.
    if mode != "area" {
        start_picker_tracker(app.clone(), mode, displays, windows, &tracker);
    }
    Ok(())
}

fn close_picker_overlays_inner(app: &AppHandle, tracker: &PickerTrackerState) -> Result<(), String> {
    stop_picker_tracker(tracker);
    for (label, win) in app.webview_windows() {
        if label.starts_with("picker-") {
            let _ = win.close();
        }
    }
    if let Some(hud) = app.get_webview_window("hud") {
        let _ = hud.emit("picker-state", "closed");
    }
    Ok(())
}

#[tauri::command]
fn close_picker_overlays(app: AppHandle, tracker: State<'_, PickerTrackerState>) -> Result<(), String> {
    close_picker_overlays_inner(&app, &tracker)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickerSelection {
    pub display_id: u32,
    pub window_id: Option<u32>,
    pub crop: Option<CropRect>,
}

#[tauri::command]
fn picker_select_display(
    app: AppHandle,
    display_id: u32,
    tracker: State<'_, PickerTrackerState>,
) -> Result<(), String> {
    let displays = list_displays()?;
    let d = displays.iter().find(|d| d.id == display_id)
        .ok_or_else(|| format!("Display {display_id} not found"))?;
    let payload = PickerSelection { display_id: d.id, window_id: None, crop: None };
    if let Some(hud) = app.get_webview_window("hud") {
        let _ = hud.emit("picker-selected", payload);
    }
    close_picker_overlays_inner(&app, &tracker)
}

#[tauri::command]
fn picker_select_window(
    app: AppHandle,
    window_id: u32,
    tracker: State<'_, PickerTrackerState>,
) -> Result<(), String> {
    let displays = list_displays()?;
    let windows = list_windows_inner(&displays);
    let w = windows.iter().find(|w| w.id == window_id)
        .ok_or_else(|| format!("Window {window_id} not found"))?;
    let d = displays.iter().find(|d| d.id == w.display_id)
        .ok_or_else(|| "Window's display not found".to_string())?;
    let payload = PickerSelection {
        display_id: d.id,
        window_id: Some(w.id),
        crop: None,
    };
    if let Some(hud) = app.get_webview_window("hud") {
        let _ = hud.emit("picker-selected", payload);
    }
    close_picker_overlays_inner(&app, &tracker)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AreaSelection {
    pub display_id: u32,
    // Logical (point) coordinates relative to the display's top-left.
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[tauri::command]
fn picker_select_area(
    app: AppHandle,
    sel: AreaSelection,
    tracker: State<'_, PickerTrackerState>,
) -> Result<(), String> {
    let displays = list_displays()?;
    displays
        .iter()
        .find(|d| d.id == sel.display_id)
        .ok_or_else(|| format!("Display {} not found", sel.display_id))?;
    // SCK's source_rect is in display points, relative to the display's
    // top-left — same coordinate space the picker drag emits — so we pass
    // through without scaling. Round to even for encoder friendliness.
    let to_even = |n: f64| {
        let v = n.round().max(2.0) as u32;
        v - (v % 2)
    };
    let crop = CropRect {
        x: to_even(sel.x),
        y: to_even(sel.y),
        width: to_even(sel.width),
        height: to_even(sel.height),
    };
    let payload = PickerSelection {
        display_id: sel.display_id,
        window_id: None,
        crop: Some(crop),
    };
    if let Some(hud) = app.get_webview_window("hud") {
        let _ = hud.emit("picker-selected", payload);
    }
    close_picker_overlays_inner(&app, &tracker)
}

// Small URL-encoder for the bits of text that go into the picker URL.
// Avoids pulling in a full URL crate just for query strings.
fn urlencoding_lite(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn dev_fixture_path() -> Result<PathBuf, String> {
    let dir = dirs_recordings_dir().ok_or_else(|| {
        "Could not resolve ~/Movies/OpenScreen Studio for the dev fixture.".to_string()
    })?;
    Ok(dir.join("dev-fixture.mp4"))
}

fn ensure_dev_fixture(path: &Path) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }

    let status = Command::new(ffmpeg_path())
        .args([
            "-hide_banner",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=12:size=1280x720:rate=30",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=12",
            "-shortest",
            "-c:v",
            "h264_videotoolbox",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
        ])
        .arg(path)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .status()
        .map_err(|e| format!("Failed to invoke bundled ffmpeg: {e}"))?;

    if !status.success() {
        return Err("Failed to generate the dev fixture video.".into());
    }
    Ok(())
}

fn media_duration_ms(path: &Path) -> Result<u64, String> {
    let output = Command::new(ffmpeg_path())
        .args(["-hide_banner", "-i"])
        .arg(path)
        .stderr(Stdio::piped())
        .stdout(Stdio::null())
        .output()
        .map_err(|e| format!("Failed to probe media duration: {e}"))?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    for line in stderr.lines() {
        let Some(rest) = line.strip_prefix("  Duration:") else {
            continue;
        };
        let stamp = rest.trim().split(',').next().unwrap_or_default().trim();
        let mut parts = stamp.split(':');
        let hours: f64 = parts
            .next()
            .and_then(|p| p.parse().ok())
            .ok_or_else(|| format!("Could not parse duration in {line}"))?;
        let minutes: f64 = parts
            .next()
            .and_then(|p| p.parse().ok())
            .ok_or_else(|| format!("Could not parse duration in {line}"))?;
        let seconds: f64 = parts
            .next()
            .and_then(|p| p.parse().ok())
            .ok_or_else(|| format!("Could not parse duration in {line}"))?;
        return Ok(((hours * 3600.0 + minutes * 60.0 + seconds) * 1000.0).round() as u64);
    }
    Err("Could not read media duration.".into())
}

/// Open the editor with a bundled dev fixture so capture can be skipped in debug builds.
#[tauri::command]
fn open_dev_editor(app: AppHandle, tracker: State<'_, PickerTrackerState>) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err("Dev Mode is only available in debug builds.".into());
    }

    close_picker_overlays_inner(&app, &tracker)?;

    let path = dev_fixture_path()?;
    ensure_dev_fixture(&path)?;
    let duration_ms = media_duration_ms(&path).unwrap_or(12_000);
    let artifact = CaptureArtifact {
        id: "dev-fixture".into(),
        path: path.to_string_lossy().to_string(),
        duration_ms,
    };
    open_editor_with_artifact(app, artifact)
}

/// Show a native macOS confirm alert ("Delete this project?"). On confirm,
/// hide the editor and bring the HUD back. Returns whether the user confirmed.
/// The alert blocks on the main thread via `run_on_main_thread`.
#[tauri::command]
fn confirm_and_discard_editor(app: AppHandle) -> Result<bool, String> {
    let (tx, rx) = std::sync::mpsc::channel::<bool>();
    let app_main = app.clone();
    app.run_on_main_thread(move || {
        let confirmed = show_discard_alert();
        if confirmed {
            if let Some(editor) = app_main.get_webview_window("editor") {
                let _ = editor.hide();
            }
            if let Some(hud) = app_main.get_webview_window("hud") {
                let _ = hud.show();
                let _ = hud.set_focus();
            }
        }
        let _ = tx.send(confirmed);
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn show_discard_alert() -> bool {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSAlert, NSAlertStyle};
    use objc2_foundation::NSString;

    let Some(mtm) = MainThreadMarker::new() else { return false; };
    // NSAlertFirstButtonReturn = 1000; buttons are laid out right-to-left in
    // the order added, so "Delete" (added first) becomes the default rightmost
    // button and "Cancel" sits to its left.
    let alert = NSAlert::new(mtm);
    alert.setMessageText(&NSString::from_str("Delete this project?"));
    alert.setInformativeText(&NSString::from_str("This action cannot be undone."));
    alert.setAlertStyle(NSAlertStyle::Warning);
    let _ = alert.addButtonWithTitle(&NSString::from_str("Delete"));
    let _ = alert.addButtonWithTitle(&NSString::from_str("Cancel"));
    alert.runModal() == 1000
}

#[cfg(not(target_os = "macos"))]
fn show_discard_alert() -> bool {
    true
}

/// Open the editor window with a recording artifact loaded.
#[tauri::command]
fn open_editor_with_artifact(app: AppHandle, artifact: CaptureArtifact) -> Result<(), String> {
    if let Some(editor) = app.get_webview_window("editor") {
        editor.show().map_err(|e| e.to_string())?;
        editor.set_focus().map_err(|e| e.to_string())?;
        // Defer the emit slightly so the editor's listener is mounted.
        let app_clone = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            let _ = app_clone.emit("recording-artifact", artifact);
        });
    }
    if let Some(hud) = app.get_webview_window("hud") {
        let _ = hud.hide();
    }
    Ok(())
}

#[derive(serde::Serialize)]
struct MacWallpaper {
    name: String,
    thumb: String,
    full: String,
}

/// Enumerate the macOS desktop wallpapers that exist on disk at full
/// resolution. The ~138 entries under `.thumbnails/` are 214×130 previews
/// whose full-res source is a MobileAsset that macOS downloads on demand and
/// is *not* cached locally — applying those to the canvas would look blurry.
/// We therefore only list wallpapers backed by a real high-resolution file:
/// the root `*.heic` (6016px) and any full-res image under `.wallpapers/`.
/// The swatch uses a small sibling thumbnail when one exists.
#[tauri::command]
fn list_macos_wallpapers() -> Result<Vec<MacWallpaper>, String> {
    let base = Path::new("/System/Library/Desktop Pictures");
    let thumbs_dir = base.join(".thumbnails");
    let mut out: Vec<MacWallpaper> = Vec::new();

    let is_heic = |p: &Path| p.extension().and_then(|s| s.to_str()) == Some("heic");
    let stem_of = |p: &Path| p.file_stem().and_then(|s| s.to_str()).map(str::to_string);

    // Root-level full-res stills (Sonoma, iMac/Mac colors, Radial Sky Blue …).
    for entry in fs::read_dir(base).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if !path.is_file() || !is_heic(&path) {
            continue;
        }
        let Some(stem) = stem_of(&path) else { continue };
        let thumb_candidate = thumbs_dir.join(format!("{stem}.heic"));
        let thumb = if thumb_candidate.is_file() {
            thumb_candidate.to_string_lossy().to_string()
        } else {
            path.to_string_lossy().to_string()
        };
        out.push(MacWallpaper {
            name: stem,
            thumb,
            full: path.to_string_lossy().to_string(),
        });
    }

    // Full-res images bundled under `.wallpapers/<Name>/` (e.g. Sonoma Horizon).
    if let Ok(dirs) = fs::read_dir(base.join(".wallpapers")) {
        for dir in dirs.flatten() {
            let Ok(files) = fs::read_dir(dir.path()) else { continue };
            let files: Vec<PathBuf> = files.flatten().map(|e| e.path()).collect();
            for path in files.iter().filter(|p| is_heic(p)) {
                let lower = path.to_string_lossy().to_lowercase();
                if lower.contains("thumbnail") {
                    continue;
                }
                let Some(stem) = stem_of(path) else { continue };
                let thumb = files
                    .iter()
                    .find(|p| {
                        let l = p.to_string_lossy().to_lowercase();
                        l.contains("thumbnail") && l.ends_with("@2x.png")
                    })
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|| path.to_string_lossy().to_string());
                out.push(MacWallpaper {
                    name: stem,
                    thumb,
                    full: path.to_string_lossy().to_string(),
                });
            }
        }
    }

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

/// Absolute path of the wallpaper currently set on the primary desktop, or
/// `None` if it can't be resolved (e.g. the user denied the System Events
/// automation prompt, or a dynamic/aerial wallpaper has no static file).
/// The frontend maps this back onto a `list_macos_wallpapers` entry; if it
/// doesn't match anything it falls back to the first bundled wallpaper.
#[tauri::command]
fn current_macos_wallpaper() -> Option<String> {
    let out = std::process::Command::new("osascript")
        .arg("-e")
        .arg("tell application \"System Events\" to get picture of desktop 1")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

#[derive(Serialize)]
pub struct OpenedProject {
    path: String,
    contents: String,
}

/// Prompt for a destination and write the serialized project JSON there.
/// Returns the chosen path, or `None` if the user cancelled the dialog.
///
/// Async + the non-blocking callback dialog API on purpose: a sync command
/// runs on the main thread, and `blocking_save_file()` needs that same
/// thread to pump the NSSavePanel run loop — calling it there deadlocks
/// (the dialog "hangs"). The callback is dispatched to the main thread by
/// the plugin while this task awaits off-thread.
#[tauri::command]
async fn save_project(
    app: AppHandle,
    default_name: String,
    contents: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, mut rx) = tauri::async_runtime::channel(1);
    app.dialog()
        .file()
        .set_title("Save Project")
        .set_file_name(&default_name)
        .add_filter("OpenScreen Project", &["openscreen"])
        .save_file(move |path| {
            let _ = tx.blocking_send(path);
        });

    let Some(file_path) = rx.recv().await.flatten() else {
        return Ok(None);
    };
    let path = file_path.into_path().map_err(|e| e.to_string())?;
    fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// Prompt for a `.openscreen` file and return its path + raw JSON contents.
/// Returns `None` if the user cancelled the dialog. Async for the same
/// main-thread reason documented on `save_project`.
#[tauri::command]
async fn open_project(app: AppHandle) -> Result<Option<OpenedProject>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, mut rx) = tauri::async_runtime::channel(1);
    app.dialog()
        .file()
        .set_title("Open Project")
        .add_filter("OpenScreen Project", &["openscreen"])
        .pick_file(move |path| {
            let _ = tx.blocking_send(path);
        });

    let Some(file_path) = rx.recv().await.flatten() else {
        return Ok(None);
    };
    let path = file_path.into_path().map_err(|e| e.to_string())?;
    let contents = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(Some(OpenedProject {
        path: path.to_string_lossy().to_string(),
        contents,
    }))
}

/// Bring the editor forward and hide the HUD. The two windows are mutually
/// exclusive: HUD visible ⇔ editor hidden, and vice versa. Called by the
/// editor after a project is successfully opened (e.g. from the HUD's
/// File menu) so the recording UI doesn't linger behind it.
#[tauri::command]
fn present_editor(app: AppHandle) -> Result<(), String> {
    if let Some(editor) = app.get_webview_window("editor") {
        editor.show().map_err(|e| e.to_string())?;
        editor.set_focus().map_err(|e| e.to_string())?;
    }
    if let Some(hud) = app.get_webview_window("hud") {
        let _ = hud.hide();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .on_menu_event(|app, event| {
            let target = match event.id().as_ref() {
                "oss-open-project" => Some("menu:open-project"),
                "oss-save-project" => Some("menu:save-project"),
                _ => None,
            };
            // Deliver to the (possibly hidden) editor webview; its handler
            // runs the dialog and only then promotes the window via
            // `present_editor`. Don't show the editor here — a cancelled
            // Open dialog should leave the HUD in front.
            if let Some(evt) = target {
                if let Some(editor) = app.get_webview_window("editor") {
                    let _ = editor.emit(evt, ());
                }
            }
        })
        .manage(RecordingState::default())
        .manage(MeterState::default())
        .manage(PickerTrackerState::default())
        .setup(|app| {
            // In debug builds (or when OSS_SKIP_PERMS=1) skip the onboarding
            // window — `tauri dev` runs as the dev shell and re-prompts every
            // launch, which is just noise during iteration.
            let skip_perms = cfg!(debug_assertions)
                || std::env::var("OSS_SKIP_PERMS").ok().as_deref() == Some("1");
            let status = check_permissions_inner();
            let need_perms = !skip_perms && (!status.screen_recording || !status.accessibility);

            // Attach a real NSVisualEffectView to the HUD so the pill blur is
            // stable. CSS `backdrop-filter` on a transparent NSWindow flickers
            // because there is no opaque surface for the compositor to blur.
            #[cfg(target_os = "macos")]
            if let Some(hud) = app.get_webview_window("hud") {
                use window_vibrancy::{
                    apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState,
                };
                let _ = apply_vibrancy(
                    &hud,
                    NSVisualEffectMaterial::HudWindow,
                    Some(NSVisualEffectState::Active),
                    Some(32.0),
                );
            }

            if let Some(hud) = app.get_webview_window("hud") {
                let app_handle = app.handle().clone();
                hud.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { .. } = event {
                        app_handle.exit(0);
                    }
                });
            }

            // Inject Open/Save Project into the *existing* File submenu of the
            // platform default menu (don't create a second "File"). Clicks
            // route through `.on_menu_event` into the editor window.
            {
                use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
                let handle = app.handle();
                let menu = Menu::default(handle)?;
                let open_item = MenuItem::with_id(
                    handle,
                    "oss-open-project",
                    "Open Project…",
                    true,
                    Some("CmdOrCtrl+O"),
                )?;
                let save_item = MenuItem::with_id(
                    handle,
                    "oss-save-project",
                    "Save Project…",
                    true,
                    Some("CmdOrCtrl+S"),
                )?;
                let sep = PredefinedMenuItem::separator(handle)?;

                let file_submenu = menu.items()?.into_iter().find_map(|kind| match kind {
                    MenuItemKind::Submenu(s)
                        if s.text().map(|t| t == "File").unwrap_or(false) =>
                    {
                        Some(s)
                    }
                    _ => None,
                });

                match file_submenu {
                    Some(file) => {
                        // Prepend in reverse so final order is Open, Save, ─.
                        file.prepend(&sep)?;
                        file.prepend(&save_item)?;
                        file.prepend(&open_item)?;
                    }
                    None => {
                        let file = Submenu::with_items(
                            handle,
                            "File",
                            true,
                            &[&open_item, &save_item],
                        )?;
                        menu.append(&file)?;
                    }
                }
                app.set_menu(menu)?;
            }

            // `tauri dev` runs the raw binary (no .app bundle), so macOS can't
            // resolve CFBundleIconFile / CFBundleName and falls back to the
            // executable's filename ("openscreen-studio") and the generic
            // folder glyph for the icon. Override both at startup so Dock /
            // menu bar / About dialog look right under dev too. In a real
            // .app bundle these values come from Info.plist and these calls
            // are no-ops in practice.
            #[cfg(target_os = "macos")]
            {
                use objc2::{AnyThread, MainThreadMarker};
                use objc2_app_kit::{NSApplication, NSImage, NSMenu};
                use objc2_foundation::{NSData, NSProcessInfo, NSString};

                if let Some(mtm) = MainThreadMarker::new() {
                    let png: &[u8] = include_bytes!("../icons/icon.png");
                    let data = NSData::with_bytes(png);
                    if let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) {
                        let nsapp = NSApplication::sharedApplication(mtm);
                        unsafe { nsapp.setApplicationIconImage(Some(&image)) };
                    }

                    // Display name rewrite. Dock title comes from
                    // NSProcessInfo.processName. macOS-generated app-menu
                    // items (About / Hide / Quit) bake the kebab-case
                    // executable name in at creation; rewrite each title.
                    let display = NSString::from_str("OpenScreen Studio");
                    let kebab = NSString::from_str("openscreen-studio");
                    let proc_info = NSProcessInfo::processInfo();
                    proc_info.setProcessName(&display);

                    let nsapp = NSApplication::sharedApplication(mtm);
                    if let Some(menu) = nsapp.mainMenu() {
                        if let Some(app_item) = menu.itemAtIndex(0) {
                            app_item.setTitle(&display);
                            if let Some(submenu) = app_item.submenu() {
                                submenu.setTitle(&display);
                                let count = submenu.numberOfItems();
                                for i in 0..count {
                                    if let Some(item) = submenu.itemAtIndex(i) {
                                        let current = item.title();
                                        let updated = current
                                            .stringByReplacingOccurrencesOfString_withString(
                                                &kebab, &display,
                                            );
                                        item.setTitle(&updated);
                                    }
                                }
                            }
                        }

                        // Give our File-menu items real macOS SF Symbol
                        // glyphs. SF Symbols are template images, so they
                        // adapt to the menu's light/dark appearance and
                        // stay crisp at any scale.
                        let set_symbol = |submenu: &NSMenu, title: &str, symbol: &str| {
                            for i in 0..submenu.numberOfItems() {
                                let Some(item) = submenu.itemAtIndex(i) else {
                                    continue;
                                };
                                if item.title().to_string() != title {
                                    continue;
                                }
                                let name = NSString::from_str(symbol);
                                if let Some(img) =
                                    NSImage::imageWithSystemSymbolName_accessibilityDescription(
                                        &name, None,
                                    )
                                {
                                    item.setImage(Some(&img));
                                }
                            }
                        };
                        for i in 0..menu.numberOfItems() {
                            let Some(item) = menu.itemAtIndex(i) else {
                                continue;
                            };
                            let Some(submenu) = item.submenu() else {
                                continue;
                            };
                            if submenu.title().to_string() == "File" {
                                set_symbol(&submenu, "Open Project…", "folder");
                                set_symbol(
                                    &submenu,
                                    "Save Project…",
                                    "square.and.arrow.down",
                                );
                            }
                        }
                    }
                }
            }

            if need_perms {
                if let Some(p) = app.get_webview_window("permissions") {
                    let _ = p.show();
                    let _ = p.set_focus();
                }
            } else if let Some(hud) = app.get_webview_window("hud") {
                let _ = hud.show();
                let _ = hud.set_focus();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_capture_sources,
            start_capture,
            stop_capture,
            finalize_external_stop,
            pause_capture,
            resume_capture,
            cancel_capture,
            restart_capture,
            is_recording,
            start_mic_meter,
            stop_mic_meter,
            open_editor_with_artifact,
            open_dev_editor,
            confirm_and_discard_editor,
            check_permissions,
            request_screen_recording,
            request_accessibility,
            dismiss_permissions,
            list_displays,
            list_windows,
            open_picker_overlays,
            close_picker_overlays,
            picker_select_display,
            picker_select_window,
            picker_select_area,
            list_macos_wallpapers,
            current_macos_wallpaper,
            save_project,
            open_project,
            present_editor,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
