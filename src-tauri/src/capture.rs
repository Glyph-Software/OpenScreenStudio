use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSource {
    pub id: String,    // native device id (SCK mic id / AVCaptureDevice uniqueID)
    pub kind: String,  // "camera" | "audio"
    pub label: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureArtifact {
    pub id: String,
    pub path: String,
    pub duration_ms: u64,
    /// Sidecar WAV with the system (app) audio, when it was recorded.
    #[serde(default)]
    pub system_audio_path: Option<String>,
    /// Sidecar WAV with the microphone audio, when it was recorded.
    #[serde(default)]
    pub mic_path: Option<String>,
    /// Sidecar movie with the camera recording, when it was recorded.
    #[serde(default)]
    pub camera_path: Option<String>,
    /// Camera start relative to the screen recording start (ms; positive
    /// means the camera file starts later than the screen file).
    #[serde(default)]
    pub camera_offset_ms: Option<i64>,
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
    /// Record system (app) audio to a sidecar WAV.
    #[serde(default)]
    pub system_audio: bool,
    /// Record this microphone (SCK device id) to a sidecar WAV.
    #[serde(default)]
    pub mic_device_id: Option<String>,
    /// Record this camera (AVCaptureDevice uniqueID) to a sidecar movie.
    #[serde(default)]
    pub camera_device_id: Option<String>,
    pub framerate: Option<u32>,
    pub crop: Option<CropRect>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CursorSample {
    t_ms: u32,
    x: f64,
    y: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CursorClick {
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
pub(crate) struct CursorShapeChange {
    t_ms: u32,
    shape: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CursorSidecarDisplay {
    id: u32,
    origin_x: f64,
    origin_y: f64,
    width: f64,
    height: f64,
    scale_factor: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CursorSidecar<'a> {
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

pub(crate) struct CursorTrack {
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
pub(crate) fn cursor_t_ms(track: &CursorTrack) -> u32 {
    let base = track.t_offset_ms.load(Ordering::Relaxed);
    let extra = if track.paused.load(Ordering::Relaxed) {
        0
    } else {
        track.started.lock().elapsed().as_millis() as u64
    };
    (base + extra).min(u32::MAX as u64) as u32
}

#[cfg(target_os = "macos")]
pub(crate) type CFRunLoopRef = *mut std::ffi::c_void;

#[cfg(target_os = "macos")]
pub(crate) struct RunLoopHandle(CFRunLoopRef);
#[cfg(target_os = "macos")]
unsafe impl Send for RunLoopHandle {}

#[cfg(target_os = "macos")]
pub(crate) struct SegmentRecorder {
    stream: SCStream,
    _recording_output: SCRecordingOutput,
    segment_path: PathBuf,
    // WAV taps on the same SCStream (one per enabled audio track). Finalized
    // when the segment stops; their files concat into the final track WAVs.
    system_tap: Option<AudioTap>,
    mic_tap: Option<AudioTap>,
    // Set true before we call `stream.stop_capture()` from our own code path
    // so the SCK delegate's `on_stop` firing is recognised as expected and
    // doesn't emit a duplicate "recording-stopped-externally" event.
    stop_emitted: Arc<AtomicBool>,
}

#[cfg(target_os = "macos")]
pub(crate) struct ActiveRecording {
    id: String,
    args: StartCaptureArgs,
    // `Some` while a segment is being written. Goes to `None` on pause,
    // back to `Some` on resume with a fresh SCStream + new segment file.
    active: Option<SegmentRecorder>,
    // Segment files already finalised (one entry per pause). On stop these
    // are concatenated into `final_output` with ffmpeg.
    segments: Vec<PathBuf>,
    // Finalised per-segment audio WAVs, parallel to `segments` in time (but
    // only present for segments where the track was enabled and produced data).
    system_segments: Vec<PathBuf>,
    mic_segments: Vec<PathBuf>,
    // Parallel camera recording (own AVCaptureSession on its own thread).
    camera: Option<camera::CameraRecorder>,
    final_output: PathBuf,
    cursor_track: Arc<CursorTrack>,
    cursor_stop: Arc<AtomicBool>,
    cursor_poll_handle: Option<JoinHandle<()>>,
    cursor_tap_handle: Option<JoinHandle<()>>,
    cursor_tap_runloop: Arc<Mutex<Option<RunLoopHandle>>>,
}

#[cfg(not(target_os = "macos"))]
pub(crate) struct ActiveRecording {
    id: String,
    output: PathBuf,
    started: Instant,
}

#[derive(Default)]
pub(crate) struct RecordingState(Mutex<Option<ActiveRecording>>);

pub(crate) struct MicMeter {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

#[derive(Default)]
pub(crate) struct MeterState(Mutex<Option<MicMeter>>);

/// Resolve the bundled ffmpeg sidecar.
///
/// Tauri's `externalBin` ships the binary next to the main executable. In a
/// production `.app` it lands as `Contents/MacOS/ffmpeg`. In `tauri dev` the
/// platform-triple suffix is preserved (e.g. `ffmpeg-aarch64-apple-darwin`),
/// so we fall back to the suffixed name when the plain one is missing.
pub(crate) fn ffmpeg_path() -> PathBuf {
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

/// Enumerate recordable input devices: microphones via the SCK bridge (their
/// ids feed `with_microphone_capture_device_id` directly) and cameras via
/// AVFoundation (uniqueIDs feed the camera recorder).
#[tauri::command]
pub(crate) fn list_capture_sources() -> Result<Vec<CaptureSource>, String> {
    #[cfg(target_os = "macos")]
    {
        let mut sources: Vec<CaptureSource> = AudioInputDevice::list()
            .into_iter()
            .map(|d| CaptureSource {
                id: d.id,
                kind: "audio".into(),
                label: d.name,
                is_default: d.is_default,
            })
            .collect();
        sources.extend(camera::list_camera_devices());
        Ok(sources)
    }
    #[cfg(not(target_os = "macos"))]
    Ok(Vec::new())
}

/// Map a camera/mic AVAuthorizationStatus to a stable string the frontend
/// switches on: "authorized" | "notDetermined" | "denied" | "restricted".
#[cfg(target_os = "macos")]
pub(crate) fn auth_status_str(video: bool) -> String {
    use objc2_av_foundation::AVAuthorizationStatus;
    match camera::authorization(video) {
        AVAuthorizationStatus::Authorized => "authorized",
        AVAuthorizationStatus::NotDetermined => "notDetermined",
        AVAuthorizationStatus::Denied => "denied",
        AVAuthorizationStatus::Restricted => "restricted",
        _ => "denied",
    }
    .into()
}

/// Current camera TCC status (no prompt). The HUD checks this before turning
/// the camera pill on so it can prompt, guide to Settings, or proceed.
#[tauri::command]
pub(crate) fn check_camera_access() -> String {
    #[cfg(target_os = "macos")]
    {
        return auth_status_str(true);
    }
    #[cfg(not(target_os = "macos"))]
    "authorized".into()
}

/// Current microphone TCC status (no prompt).
#[tauri::command]
pub(crate) fn check_mic_access() -> String {
    #[cfg(target_os = "macos")]
    {
        return auth_status_str(false);
    }
    #[cfg(not(target_os = "macos"))]
    "authorized".into()
}

/// Request camera access, awaiting the TCC prompt. Returns whether access is
/// granted. The HUD calls this when the camera pill is toggled on, so the
/// prompt is resolved before a recording ever starts.
#[tauri::command]
pub(crate) async fn request_camera_access() -> bool {
    #[cfg(target_os = "macos")]
    {
        return tauri::async_runtime::spawn_blocking(|| camera::request_access_blocking(true))
            .await
            .unwrap_or(false);
    }
    #[cfg(not(target_os = "macos"))]
    true
}

/// Request microphone access, awaiting the TCC prompt. Returns whether access
/// is granted.
#[tauri::command]
pub(crate) async fn request_mic_access() -> bool {
    #[cfg(target_os = "macos")]
    {
        return tauri::async_runtime::spawn_blocking(|| camera::request_access_blocking(false))
            .await
            .unwrap_or(false);
    }
    #[cfg(not(target_os = "macos"))]
    true
}

/// Deep-link to the relevant macOS Privacy & Security settings pane.
/// `pane` is "camera" | "microphone" | "screen".
#[tauri::command]
pub(crate) fn open_privacy_settings(pane: String) {
    #[cfg(target_os = "macos")]
    {
        let anchor = match pane.as_str() {
            "camera" => "Privacy_Camera",
            "microphone" => "Privacy_Microphone",
            "screen" => "Privacy_ScreenCapture",
            _ => "Privacy",
        };
        open_settings(&format!(
            "x-apple.systempreferences:com.apple.preference.security?{anchor}"
        ));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = pane;
}

pub(crate) fn output_path(id: &str) -> PathBuf {
    let dir = dirs_recordings_dir().unwrap_or_else(std::env::temp_dir);
    let stamp = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S");
    dir.join(format!("OpenScreen-{stamp}-{id}.mp4"))
}

pub(crate) fn segment_path(id: &str, n: usize) -> PathBuf {
    let dir = dirs_recordings_dir().unwrap_or_else(std::env::temp_dir);
    dir.join(format!(".oss-{id}-seg{n}.mp4"))
}

pub(crate) fn dirs_recordings_dir() -> Option<PathBuf> {
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
pub(crate) fn build_and_start_segment(
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
    //  - full display: SCDisplay reports its size in points, so scale by the
    //    backing factor to capture at native pixel resolution (same as above).
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
        (
            to_even(display.width() as f64 * backing_scale),
            to_even(display.height() as f64 * backing_scale),
        )
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

    let wants_system = args.system_audio;
    let wants_mic = args.mic_device_id.is_some();
    if wants_system {
        config = config
            .with_captures_audio(true)
            .with_excludes_current_process_audio(true)
            .with_sample_rate(48_000)
            .with_channel_count(2);
    }
    if wants_mic {
        config = config.with_captures_microphone(true);
        if let Some(id) = args.mic_device_id.as_deref().filter(|s| !s.is_empty()) {
            config = config.with_microphone_capture_device_id(id);
        }
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

    let mut stream = SCStream::new_with_delegate(&filter, &config, stream_delegate);
    stream
        .add_recording_output(&rec_output)
        .map_err(|e| format!("add_recording_output failed: {e:?}"))?;

    // Audio taps. The WAVs must start exactly at the video segment's first
    // frame; a Screen output handler records that frame's timestamp (all
    // outputs share the stream clock) and each tap aligns against it.
    let mut system_tap = None;
    let mut mic_tap = None;
    if wants_system || wants_mic {
        let video_anchor: VideoAnchor = Arc::new(Mutex::new(None));
        {
            let anchor = Arc::clone(&video_anchor);
            stream.add_output_handler(
                move |sample: screencapturekit::cm::CMSampleBuffer, _ty| {
                    let mut slot = anchor.lock();
                    if slot.is_none() {
                        let t = sample.presentation_timestamp();
                        if t.timescale != 0 {
                            *slot = Some(t.value as f64 / t.timescale as f64);
                        }
                    }
                },
                SCStreamOutputType::Screen,
            );
        }
        if wants_system {
            let tap = AudioTap::new(
                segment_path.with_extension("system.wav"),
                Arc::clone(&video_anchor),
            );
            stream.add_output_handler(tap.handler(), SCStreamOutputType::Audio);
            system_tap = Some(tap);
        }
        if wants_mic {
            let tap = AudioTap::new(
                segment_path.with_extension("mic.wav"),
                Arc::clone(&video_anchor),
            );
            stream.add_output_handler(tap.handler(), SCStreamOutputType::Microphone);
            mic_tap = Some(tap);
        }
    }

    stream
        .start_capture()
        .map_err(|e| format!("start_capture failed: {e:?}"))?;

    Ok(SegmentRecorder {
        stream,
        _recording_output: rec_output,
        segment_path: segment_path.to_path_buf(),
        system_tap,
        mic_tap,
        stop_emitted,
    })
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub(crate) fn start_capture(
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

    // Camera first: it has the slower warm-up and the clearer failure modes
    // (TCC denial, device unplugged). Nothing else is running yet, so a
    // camera error aborts cleanly.
    let camera_rec = match args.camera_device_id.as_deref() {
        Some(device_id) => Some(camera::CameraRecorder::start(
            device_id,
            final_output.with_extension("camera.mov"),
        )?),
        None => None,
    };

    let first_segment = segment_path(&id, 0);
    let segment = match build_and_start_segment(&app, &args, &first_segment) {
        Ok(s) => s,
        Err(e) => {
            if let Some(cam) = camera_rec {
                cam.discard();
            }
            return Err(e);
        }
    };

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
        system_segments: Vec::new(),
        mic_segments: Vec::new(),
        camera: camera_rec,
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
pub(crate) fn remap_to_crop_local(
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
pub(crate) fn run_click_tap(track: Arc<CursorTrack>, runloop_slot: Arc<Mutex<Option<RunLoopHandle>>>) {
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
pub(crate) fn cursor_image_fingerprint(cur: &objc2_app_kit::NSCursor) -> Option<u64> {
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
pub(crate) fn known_cursor_shapes() -> &'static [(u64, &'static str)] {
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
pub(crate) fn current_cursor_shape() -> &'static str {
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
pub(crate) fn start_capture(
    _app: AppHandle,
    _args: StartCaptureArgs,
    _state: State<'_, RecordingState>,
) -> Result<String, String> {
    Err("Screen capture is only implemented on macOS.".into())
}

/// Push a finished segment's files onto the recording's segment lists,
/// finalizing the audio taps so their WAV headers are valid on disk.
#[cfg(target_os = "macos")]
pub(crate) fn collect_segment(rec: &mut ActiveRecording, seg: SegmentRecorder) {
    if let Some(tap) = &seg.system_tap {
        if let Some(p) = tap.finalize() {
            rec.system_segments.push(p);
        }
    }
    if let Some(tap) = &seg.mic_tap {
        if let Some(p) = tap.finalize() {
            rec.mic_segments.push(p);
        }
    }
    rec.segments.push(seg.segment_path.clone());
}

/// Stop the active segment (if any) and push its file onto `segments`.
/// Sets `stop_emitted` first so the SCK delegate's on_stop fires silently.
#[cfg(target_os = "macos")]
pub(crate) fn stop_active_segment(rec: &mut ActiveRecording) -> Result<(), String> {
    if let Some(seg) = rec.active.take() {
        seg.stop_emitted.store(true, Ordering::SeqCst);
        let stop_result = seg
            .stream
            .stop_capture()
            .map_err(|e| format!("stop_capture failed: {e:?}"));
        // SCRecordingOutput finalises the moov atom asynchronously after stop;
        // give it a beat so the segment file is playable when concatenated.
        std::thread::sleep(Duration::from_millis(400));
        // Collect even when stop failed: the taps must be finalized either
        // way or their WAVs are left with invalid headers.
        collect_segment(rec, seg);
        stop_result?;
    }
    Ok(())
}

/// Stop cursor-tracking threads and drain the captured samples + clicks.
#[cfg(target_os = "macos")]
pub(crate) fn drain_cursor_track(
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
pub(crate) fn concat_segments(segments: &[PathBuf], final_output: &Path) -> Result<(), String> {
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
pub(crate) fn finalize_recording(mut rec: ActiveRecording) -> Result<CaptureArtifact, String> {
    // Kick the camera finalize off first, on its own thread: AVFoundation can
    // take seconds to finish writing the movie, so it overlaps with the
    // screen-segment stop + concat below. Sending Stop immediately also
    // guarantees the camera light turns off even if the concat fails or this
    // function returns early — the detached thread finalizes regardless.
    let started_epoch_ms = rec.cursor_track.started_epoch_ms;
    let camera_join = rec.camera.take().map(|cam| {
        std::thread::spawn(move || -> (Option<String>, Option<i64>) {
            let (path, camera_epoch, result) = cam.stop();
            if let Err(e) = &result {
                // Non-fatal: AVFoundation routinely reports an "error" on a
                // clean stop. Log it but decide usability from the file itself.
                eprintln!("[camera] stop reported: {e}");
            }
            let on_disk = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            if on_disk > 0 {
                let offset = camera_epoch.map(|e| e - started_epoch_ms);
                eprintln!(
                    "[camera] using movie {} ({} bytes), offset_ms={:?}",
                    path.display(),
                    on_disk,
                    offset
                );
                (Some(path.to_string_lossy().to_string()), offset)
            } else {
                eprintln!("[camera] no usable movie written at {}", path.display());
                (None, None)
            }
        })
    });

    // Stop the active segment (if `stop_capture` didn't already) so every
    // segment file is on disk and finalised.
    stop_active_segment(&mut rec)?;

    // Duration excludes paused intervals — match the concatenated MP4.
    let duration_ms = cursor_t_ms(&rec.cursor_track) as u64;

    let (samples, clicks, cursor_shapes) = drain_cursor_track(&mut rec);

    concat_segments(&rec.segments, &rec.final_output)?;

    let system_audio_path = concat_wav_segments(
        &rec.system_segments,
        &rec.final_output.with_extension("system.wav"),
    );
    let mic_path = concat_wav_segments(
        &rec.mic_segments,
        &rec.final_output.with_extension("mic.wav"),
    );

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

    let (camera_path, camera_offset_ms) = match camera_join {
        Some(h) => h.join().unwrap_or((None, None)),
        None => (None, None),
    };

    Ok(CaptureArtifact {
        id: rec.id,
        path: rec.final_output.to_string_lossy().to_string(),
        duration_ms,
        system_audio_path: system_audio_path.map(|p| p.to_string_lossy().to_string()),
        mic_path: mic_path.map(|p| p.to_string_lossy().to_string()),
        camera_path,
        camera_offset_ms,
    })
}

/// Discard everything tied to `rec`: stop the active segment, kill cursor
/// threads, and delete every segment file plus any sidecar that was written.
#[cfg(target_os = "macos")]
pub(crate) fn discard_recording(mut rec: ActiveRecording) {
    if let Some(cam) = rec.camera.take() {
        cam.discard();
    }
    let _ = stop_active_segment(&mut rec);
    let _ = drain_cursor_track(&mut rec);
    for seg in rec
        .segments
        .iter()
        .chain(&rec.system_segments)
        .chain(&rec.mic_segments)
    {
        let _ = std::fs::remove_file(seg);
    }
    // The final output isn't written yet (concat hasn't run), but stale
    // sidecars from a prior run could collide; clean them up to be safe.
    let _ = std::fs::remove_file(rec.final_output.with_extension("cursor.json"));
    let _ = std::fs::remove_file(rec.final_output.with_extension("system.wav"));
    let _ = std::fs::remove_file(rec.final_output.with_extension("mic.wav"));
    let _ = std::fs::remove_file(rec.final_output.with_extension("camera.mov"));
}

#[cfg(target_os = "macos")]
// `(async)` runs the command on a worker thread: finalize blocks for hundreds
// of ms (moov sleep, camera finalize, ffmpeg concat) and must not freeze the
// main thread — AVFoundation also services session teardown there.
#[tauri::command(async)]
pub(crate) fn stop_capture(state: State<'_, RecordingState>) -> Result<CaptureArtifact, String> {
    let rec = state
        .0
        .lock()
        .take()
        .ok_or_else(|| "No active recording.".to_string())?;
    finalize_recording(rec)
}

#[cfg(target_os = "macos")]
#[tauri::command(async)]
pub(crate) fn finalize_external_stop(state: State<'_, RecordingState>) -> Result<CaptureArtifact, String> {
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
        collect_segment(&mut rec, seg);
    }
    finalize_recording(rec)
}

#[cfg(target_os = "macos")]
#[tauri::command(async)]
pub(crate) fn pause_capture(state: State<'_, RecordingState>) -> Result<(), String> {
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
    if let Some(cam) = &rec.camera {
        cam.pause();
    }
    stop_active_segment(rec)
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub(crate) fn resume_capture(
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
    if let Some(cam) = &rec.camera {
        cam.resume();
    }
    // Reset the per-segment clock anchor and clear `paused` only after the
    // new stream is up so we don't push cursor samples into a dead segment.
    *rec.cursor_track.started.lock() = Instant::now();
    rec.cursor_track.paused.store(false, Ordering::Relaxed);
    Ok(())
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub(crate) fn cancel_capture(state: State<'_, RecordingState>) -> Result<(), String> {
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
pub(crate) fn restart_capture(
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
pub(crate) fn stop_capture(_state: State<'_, RecordingState>) -> Result<CaptureArtifact, String> {
    Err("Screen capture is only implemented on macOS.".into())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub(crate) fn finalize_external_stop(_state: State<'_, RecordingState>) -> Result<CaptureArtifact, String> {
    Err("Screen capture is only implemented on macOS.".into())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub(crate) fn pause_capture(_state: State<'_, RecordingState>) -> Result<(), String> {
    Err("Screen capture is only implemented on macOS.".into())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub(crate) fn resume_capture(
    _app: AppHandle,
    _state: State<'_, RecordingState>,
) -> Result<(), String> {
    Err("Screen capture is only implemented on macOS.".into())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub(crate) fn cancel_capture(_state: State<'_, RecordingState>) -> Result<(), String> {
    Err("Screen capture is only implemented on macOS.".into())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub(crate) fn restart_capture(
    _app: AppHandle,
    _state: State<'_, RecordingState>,
) -> Result<String, String> {
    Err("Screen capture is only implemented on macOS.".into())
}

#[tauri::command]
pub(crate) fn is_recording(state: State<'_, RecordingState>) -> bool {
    state.0.lock().is_some()
}

pub(crate) fn build_meter_stream(
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
pub(crate) fn start_mic_meter(app: AppHandle, state: State<'_, MeterState>) -> Result<(), String> {
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
pub(crate) fn stop_mic_meter(state: State<'_, MeterState>) -> Result<(), String> {
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
pub(crate) struct CGPoint { pub(crate) x: f64, pub(crate) y: f64 }
#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Copy, Clone)]
pub(crate) struct CGSize { pub(crate) width: f64, pub(crate) height: f64 }
#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Copy, Clone)]
pub(crate) struct CGRect { pub(crate) origin: CGPoint, pub(crate) size: CGSize }

#[cfg(target_os = "macos")]
#[allow(non_camel_case_types)]
pub(crate) type CGDirectDisplayID = u32;

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    pub(crate) fn CGGetActiveDisplayList(max: u32, displays: *mut CGDirectDisplayID, count: *mut u32) -> i32;
    pub(crate) fn CGDisplayBounds(display: CGDirectDisplayID) -> CGRect;
    pub(crate) fn CGDisplayPixelsWide(display: CGDirectDisplayID) -> usize;
    pub(crate) fn CGDisplayPixelsHigh(display: CGDirectDisplayID) -> usize;
    pub(crate) fn CGDisplayCopyDisplayMode(display: CGDirectDisplayID) -> *mut std::ffi::c_void;
    pub(crate) fn CGDisplayModeGetRefreshRate(mode: *mut std::ffi::c_void) -> f64;
    pub(crate) fn CGDisplayModeRelease(mode: *mut std::ffi::c_void);
    pub(crate) fn CGDisplayIsBuiltin(display: CGDirectDisplayID) -> i32;
    pub(crate) fn CGMainDisplayID() -> CGDirectDisplayID;

    pub(crate) fn CGEventCreate(source: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
    pub(crate) fn CGEventGetLocation(event: *mut std::ffi::c_void) -> CGPoint;
    pub(crate) fn CGEventTapCreate(
        tap: u32,
        place: u32,
        options: u32,
        events_of_interest: u64,
        callback: CGEventTapCallBack,
        user_info: *mut std::ffi::c_void,
    ) -> *mut std::ffi::c_void;
    pub(crate) fn CGEventTapEnable(tap: *mut std::ffi::c_void, enable: bool);

    pub(crate) fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> core_foundation::array::CFArrayRef;
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
    pub(crate) fn CFRelease(cf: *const std::ffi::c_void);
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
pub(crate) const CG_EVENT_LEFT_MOUSE_DOWN: u32 = 1;
#[cfg(target_os = "macos")]
pub(crate) const CG_EVENT_LEFT_MOUSE_UP: u32 = 2;
#[cfg(target_os = "macos")]
pub(crate) const CG_EVENT_RIGHT_MOUSE_DOWN: u32 = 3;
#[cfg(target_os = "macos")]
pub(crate) const CG_EVENT_RIGHT_MOUSE_UP: u32 = 4;
#[cfg(target_os = "macos")]
pub(crate) const CG_EVENT_OTHER_MOUSE_DOWN: u32 = 25;
#[cfg(target_os = "macos")]
pub(crate) const CG_EVENT_OTHER_MOUSE_UP: u32 = 26;
// kCGSessionEventTap / kCGHeadInsertEventTap / kCGEventTapOptionListenOnly.
#[cfg(target_os = "macos")]
pub(crate) const CG_SESSION_EVENT_TAP: u32 = 1;
#[cfg(target_os = "macos")]
pub(crate) const CG_HEAD_INSERT_EVENT_TAP: u32 = 0;
#[cfg(target_os = "macos")]
pub(crate) const CG_EVENT_TAP_OPTION_LISTEN_ONLY: u32 = 1;

// CGWindowListOption flags
#[cfg(target_os = "macos")]
pub(crate) const CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY: u32 = 1 << 0;
#[cfg(target_os = "macos")]
pub(crate) const CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS: u32 = 1 << 4;
#[cfg(target_os = "macos")]
pub(crate) const CG_NULL_WINDOW_ID: u32 = 0;

