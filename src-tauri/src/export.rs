use super::*;

// ---------------------------------------------------------------------------
// Video export
//
// The webview composites each frame (baking in wallpaper/zoom/cursor/crop) and
// streams PNGs here; we collect them in a temp dir and let the bundled ffmpeg
// sidecar encode the final MP4/GIF. Audio (MP4 only) is muxed from the
// original recording, trimmed to the exported range.
// ---------------------------------------------------------------------------

/// The long-lived ffmpeg encoder for raw-RGBA streaming exports: frames are
/// piped straight into its stdin (no PNG round-trip) and it encodes the
/// video-only mp4 concurrently with the webview's compositing.
pub(crate) struct ExportEncoder {
    child: std::process::Child,
    stdin: Option<std::process::ChildStdin>,
    video_path: PathBuf,
}

pub(crate) struct ExportSession {
    dir: PathBuf,
    fps: u32,
    format: String,
    preset: String,
    width: u32,
    height: u32,
    canceled: Arc<AtomicBool>,
    encoder: Option<ExportEncoder>,
}

pub(crate) static EXPORT_SESSIONS: Lazy<Mutex<HashMap<String, ExportSession>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Whether the bundled ffmpeg has the macOS hardware H.264 encoder.
pub(crate) static VIDEOTOOLBOX_AVAILABLE: Lazy<bool> = Lazy::new(|| {
    Command::new(ffmpeg_path())
        .args(["-hide_banner", "-encoders"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("h264_videotoolbox"))
        .unwrap_or(false)
});

/// H.264 encoder args: VideoToolbox (hardware) with a per-preset bitrate
/// ladder when available, otherwise the previous libx264 CRF settings.
/// VideoToolbox is rate-controlled (no CRF), so quality tiers map to the
/// same Mbps table the frontend uses for its size estimate.
pub(crate) fn mp4_video_args(preset: &str, height: u32) -> Vec<String> {
    if *VIDEOTOOLBOX_AVAILABLE {
        let tier = if height <= 720 {
            0
        } else if height <= 1080 {
            1
        } else {
            2
        };
        let mbps: [f32; 3] = match preset {
            "studio" => [8.0, 16.0, 50.0],
            "social" => [5.0, 10.0, 32.0],
            "web" => [2.5, 5.0, 18.0],
            _ => [1.0, 2.0, 8.0], // weblow
        };
        vec![
            "-c:v".into(),
            "h264_videotoolbox".into(),
            "-b:v".into(),
            format!("{}k", (mbps[tier] * 1000.0) as u32),
            "-profile:v".into(),
            "high".into(),
            // Fall back to Apple's software encoder if the hw one declines.
            "-allow_sw".into(),
            "1".into(),
        ]
    } else {
        let mut v: Vec<String> = vec!["-c:v".into(), "libx264".into()];
        for a in x264_args(preset) {
            v.push(a.into());
        }
        v
    }
}

#[tauri::command]
pub(crate) fn export_begin(
    width: u32,
    height: u32,
    fps: u32,
    format: String,
    preset: String,
    raw: Option<bool>,
) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let dir = std::env::temp_dir().join(format!("osstudio-export-{id}"));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // Raw streaming mode (GPU-composited mp4 exports): spawn ffmpeg now and
    // feed it RGBA frames as they arrive. Frames come out of WebGL bottom-up,
    // hence the vflip.
    let encoder = if raw.unwrap_or(false) && format == "mp4" {
        let video_path = dir.join("video.mp4");
        let mut args: Vec<String> = vec![
            "-y".into(),
            "-hide_banner".into(),
            "-loglevel".into(),
            "error".into(),
            "-f".into(),
            "rawvideo".into(),
            "-pix_fmt".into(),
            "rgba".into(),
            "-s".into(),
            format!("{width}x{height}"),
            "-r".into(),
            fps.to_string(),
            "-i".into(),
            "pipe:0".into(),
            "-vf".into(),
            "vflip".into(),
        ];
        args.extend(mp4_video_args(&preset, height));
        args.push("-pix_fmt".into());
        args.push("yuv420p".into());
        args.push("-movflags".into());
        args.push("+faststart".into());
        args.push(video_path.to_string_lossy().to_string());
        let mut child = Command::new(ffmpeg_path())
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn ffmpeg encoder: {e}"))?;
        let stdin = child.stdin.take();
        Some(ExportEncoder {
            child,
            stdin,
            video_path,
        })
    } else {
        None
    };

    EXPORT_SESSIONS.lock().insert(
        id.clone(),
        ExportSession {
            dir,
            fps,
            format,
            preset,
            width,
            height,
            canceled: Arc::new(AtomicBool::new(false)),
            encoder,
        },
    );
    Ok(id)
}

/// Receive one composited frame. The PNG bytes are the raw IPC body; the
/// session id and frame index ride along as headers (no JSON/base64 bloat).
#[tauri::command]
pub(crate) fn export_frame(request: tauri::ipc::Request) -> Result<(), String> {
    let headers = request.headers();
    let session = headers
        .get("x-export-session")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing x-export-session header")?
        .to_string();
    let index: u64 = headers
        .get("x-export-index")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
        .ok_or("missing/invalid x-export-index header")?;
    let bytes: &[u8] = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b,
        _ => return Err("export_frame expects a raw body".into()),
    };
    let mut map = EXPORT_SESSIONS.lock();
    let s = map.get_mut(&session).ok_or("unknown export session")?;
    if s.canceled.load(Ordering::Relaxed) {
        return Err("export canceled".into());
    }
    if let Some(enc) = s.encoder.as_mut() {
        // Raw RGBA streaming: frames arrive strictly in order (the exporter
        // awaits each send), so piping is equivalent to the indexed files.
        let expected = (s.width as usize) * (s.height as usize) * 4;
        if bytes.len() != expected {
            return Err(format!(
                "raw frame {index} has {} bytes, expected {expected}",
                bytes.len()
            ));
        }
        let stdin = enc.stdin.as_mut().ok_or("encoder stdin already closed")?;
        use std::io::Write;
        stdin
            .write_all(bytes)
            .map_err(|e| format!("ffmpeg encoder rejected frame {index}: {e}"))?;
        return Ok(());
    }
    let path = s.dir.join(format!("{index:06}.png"));
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn x264_args(preset: &str) -> Vec<&'static str> {
    match preset {
        "studio" => vec!["-crf", "16", "-preset", "slow"],
        "social" => vec!["-crf", "20", "-preset", "medium"],
        "web" => vec!["-crf", "24", "-preset", "medium"],
        _ => vec!["-crf", "30", "-preset", "faster"], // weblow
    }
}

// (gif scale factor of full width, palette colors, dither algorithm)
pub(crate) fn gif_params(preset: &str) -> (f32, u32, &'static str) {
    match preset {
        "studio" => (1.0, 256, "sierra2_4a"),
        "social" => (1.0, 256, "sierra2_4a"),
        "web" => (0.8, 192, "bayer"),
        _ => (0.6, 128, "none"), // weblow
    }
}

pub(crate) fn count_frames(dir: &Path) -> u64 {
    fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| {
                    e.path()
                        .extension()
                        .map(|x| x == "png")
                        .unwrap_or(false)
                })
                .count() as u64
        })
        .unwrap_or(0)
}

/// Spawn ffmpeg, stream `frame=` progress from its `-progress` pipe, and emit
/// `export-progress` events. Blocks until ffmpeg exits.
pub(crate) fn run_ffmpeg_with_progress(
    app: &AppHandle,
    args: &[String],
    total: u64,
    canceled: &Arc<AtomicBool>,
) -> Result<(), String> {
    let mut child = Command::new(ffmpeg_path())
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn ffmpeg: {e}"))?;

    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if canceled.load(Ordering::Relaxed) {
                let _ = child.kill();
                break;
            }
            if let Some(rest) = line.strip_prefix("frame=") {
                if let Ok(done) = rest.trim().parse::<u64>() {
                    let _ = app.emit(
                        "export-progress",
                        serde_json::json!({
                            "phase": "encoding",
                            "done": done,
                            "total": total,
                        }),
                    );
                }
            }
        }
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    if canceled.load(Ordering::Relaxed) {
        return Err("export canceled".into());
    }
    if !status.success() {
        let mut err = String::new();
        if let Some(mut se) = child.stderr.take() {
            use std::io::Read;
            let _ = se.read_to_string(&mut err);
        }
        return Err(format!("ffmpeg failed: {}", err.trim()));
    }
    Ok(())
}

/// One audio source to mix into the export: read `[src_start, src_end]`
/// seconds from `path`, scale by `gain`, and place it `delay` seconds into
/// the output timeline.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTrackSpec {
    pub path: String,
    pub src_start: f64,
    pub src_end: f64,
    pub delay: f64,
    pub gain: f64,
}

/// Append the audio trim/gain/delay filter graph and stream maps. Audio
/// inputs are assumed to start at ffmpeg input index 1 (input 0 is the
/// video). Per track: cut its window, rebase timestamps, apply gain, then
/// delay it to its position in the exported timeline; mix all tracks without
/// normalization (each keeps its set level).
pub(crate) fn append_audio_mix_args(args: &mut Vec<String>, audio_tracks: &[AudioTrackSpec]) {
    let mut fc = String::new();
    for (i, t) in audio_tracks.iter().enumerate() {
        let delay_ms = (t.delay.max(0.0) * 1000.0).round() as u64;
        fc.push_str(&format!(
            "[{input}:a]atrim=start={s0:.3}:end={s1:.3},asetpts=PTS-STARTPTS,volume={g:.3},adelay={d}:all=1[a{i}];",
            input = i + 1,
            s0 = t.src_start.max(0.0),
            s1 = t.src_end.max(t.src_start),
            g = t.gain.clamp(0.0, 1.0),
            d = delay_ms,
        ));
    }
    if audio_tracks.len() == 1 {
        // Single track: its labeled output is the mix.
        fc.pop(); // trailing ';'
        args.push("-filter_complex".into());
        args.push(fc);
        args.push("-map".into());
        args.push("0:v".into());
        args.push("-map".into());
        args.push("[a0]".into());
    } else {
        for i in 0..audio_tracks.len() {
            fc.push_str(&format!("[a{i}]"));
        }
        fc.push_str(&format!(
            "amix=inputs={}:duration=longest:normalize=0[aout]",
            audio_tracks.len()
        ));
        args.push("-filter_complex".into());
        args.push(fc);
        args.push("-map".into());
        args.push("0:v".into());
        args.push("-map".into());
        args.push("[aout]".into());
    }
}

#[tauri::command]
pub(crate) fn export_finish(
    app: AppHandle,
    session_id: String,
    out_path: String,
    audio_tracks: Vec<AudioTrackSpec>,
) -> Result<String, String> {
    let (dir, fps, format, preset, height, canceled, encoder) = {
        let mut map = EXPORT_SESSIONS.lock();
        let s = map.get_mut(&session_id).ok_or("unknown export session")?;
        (
            s.dir.clone(),
            s.fps,
            s.format.clone(),
            s.preset.clone(),
            s.height,
            s.canceled.clone(),
            s.encoder.take(),
        )
    };

    // No explicit destination → write into the temp dir (Clipboard target).
    let ext = if format == "gif" { "gif" } else { "mp4" };
    let final_path: PathBuf = if out_path.is_empty() {
        dir.join(format!("export.{ext}"))
    } else {
        PathBuf::from(&out_path)
    };

    // Raw streaming path: close the encoder's stdin, let it finish, then mux
    // audio with a stream-copied video (no re-encode).
    if let Some(mut enc) = encoder {
        drop(enc.stdin.take()); // EOF → ffmpeg drains and finalizes the mp4
        let mut stderr_text = String::new();
        if let Some(mut se) = enc.child.stderr.take() {
            use std::io::Read;
            let _ = se.read_to_string(&mut stderr_text);
        }
        let status = enc.child.wait().map_err(|e| e.to_string())?;
        if canceled.load(Ordering::Relaxed) {
            cleanup_session(&session_id);
            return Err("export canceled".into());
        }
        if !status.success() {
            cleanup_session(&session_id);
            return Err(format!("ffmpeg encoder failed: {}", stderr_text.trim()));
        }
        if audio_tracks.is_empty() {
            if fs::rename(&enc.video_path, &final_path).is_err() {
                fs::copy(&enc.video_path, &final_path).map_err(|e| e.to_string())?;
                let _ = fs::remove_file(&enc.video_path);
            }
        } else {
            let mut args: Vec<String> = vec![
                "-y".into(),
                "-hide_banner".into(),
                "-loglevel".into(),
                "error".into(),
                "-progress".into(),
                "pipe:1".into(),
                "-nostats".into(),
                "-i".into(),
                enc.video_path.to_string_lossy().to_string(),
            ];
            for t in &audio_tracks {
                args.push("-i".into());
                args.push(t.path.clone());
            }
            append_audio_mix_args(&mut args, &audio_tracks);
            args.push("-c:v".into());
            args.push("copy".into());
            args.push("-c:a".into());
            args.push("aac".into());
            args.push("-b:a".into());
            args.push("192k".into());
            args.push("-movflags".into());
            args.push("+faststart".into());
            args.push(final_path.to_string_lossy().to_string());
            run_ffmpeg_with_progress(&app, &args, 1, &canceled)?;
        }
        let result = final_path.to_string_lossy().to_string();
        if out_path.is_empty() {
            // Clipboard target: the temp dir holds the final file — keep it.
            EXPORT_SESSIONS.lock().remove(&session_id);
        } else {
            cleanup_session(&session_id);
        }
        return Ok(result);
    }

    let total = count_frames(&dir);
    if total == 0 {
        cleanup_session(&session_id);
        return Err("no frames were rendered".into());
    }

    let input = dir.join("%06d.png").to_string_lossy().to_string();
    let fps_s = fps.to_string();

    if format == "gif" {
        let (factor, colors, dither) = gif_params(&preset);
        // Filter that produces the (optionally downscaled) video stream. At
        // full size we still need a real filter to label its output, so use a
        // no-op `null`. Note the label attaches with NO trailing comma.
        let scale_filter = if factor >= 0.999 {
            "null".to_string()
        } else {
            format!("scale=trunc(iw*{factor}/2)*2:-1:flags=lanczos")
        };
        let palette = dir.join("palette.png").to_string_lossy().to_string();
        let pass1: Vec<String> = vec![
            "-y".into(),
            "-hide_banner".into(),
            "-loglevel".into(),
            "error".into(),
            "-framerate".into(),
            fps_s.clone(),
            "-start_number".into(),
            "0".into(),
            "-i".into(),
            input.clone(),
            "-vf".into(),
            format!("{scale_filter},palettegen=max_colors={colors}"),
            palette.clone(),
        ];
        run_ffmpeg_with_progress(&app, &pass1, total, &canceled)?;
        let pass2: Vec<String> = vec![
            "-y".into(),
            "-hide_banner".into(),
            "-loglevel".into(),
            "error".into(),
            "-progress".into(),
            "pipe:1".into(),
            "-nostats".into(),
            "-framerate".into(),
            fps_s.clone(),
            "-start_number".into(),
            "0".into(),
            "-i".into(),
            input.clone(),
            "-i".into(),
            palette,
            "-lavfi".into(),
            format!(
                "{scale_filter}[x];[x][1:v]paletteuse=dither={dither}"
            ),
            final_path.to_string_lossy().to_string(),
        ];
        run_ffmpeg_with_progress(&app, &pass2, total, &canceled)?;
    } else {
        let mut args: Vec<String> = vec![
            "-y".into(),
            "-hide_banner".into(),
            "-loglevel".into(),
            "error".into(),
            "-progress".into(),
            "pipe:1".into(),
            "-nostats".into(),
            "-framerate".into(),
            fps_s.clone(),
            "-start_number".into(),
            "0".into(),
            "-i".into(),
            input,
        ];
        for t in &audio_tracks {
            args.push("-i".into());
            args.push(t.path.clone());
        }
        let has_audio = !audio_tracks.is_empty();
        if has_audio {
            append_audio_mix_args(&mut args, &audio_tracks);
        } else {
            args.push("-map".into());
            args.push("0:v".into());
        }
        for a in mp4_video_args(&preset, height) {
            args.push(a);
        }
        args.push("-pix_fmt".into());
        args.push("yuv420p".into());
        args.push("-movflags".into());
        args.push("+faststart".into());
        if has_audio {
            args.push("-c:a".into());
            args.push("aac".into());
            args.push("-b:a".into());
            args.push("192k".into());
        }
        args.push(final_path.to_string_lossy().to_string());
        run_ffmpeg_with_progress(&app, &args, total, &canceled)?;
    }

    let result = final_path.to_string_lossy().to_string();
    // Keep the temp file alive for the Clipboard target (it points at it);
    // only drop the PNG frames. Otherwise remove the whole session dir.
    if out_path.is_empty() {
        let _ = remove_export_pngs(&dir);
        EXPORT_SESSIONS.lock().remove(&session_id);
    } else {
        cleanup_session(&session_id);
    }
    Ok(result)
}

pub(crate) fn remove_export_pngs(dir: &Path) {
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.filter_map(|e| e.ok()) {
            let p = e.path();
            if p.extension().map(|x| x == "png").unwrap_or(false) {
                let _ = fs::remove_file(p);
            }
        }
    }
}

pub(crate) fn cleanup_session(session_id: &str) {
    if let Some(s) = EXPORT_SESSIONS.lock().remove(session_id) {
        let _ = fs::remove_dir_all(&s.dir);
    }
}

#[tauri::command]
pub(crate) fn export_cancel(session_id: String) {
    let encoder = {
        let mut map = EXPORT_SESSIONS.lock();
        match map.get_mut(&session_id) {
            Some(s) => {
                s.canceled.store(true, Ordering::Relaxed);
                s.encoder.take()
            }
            None => None,
        }
    };
    if let Some(mut enc) = encoder {
        drop(enc.stdin.take());
        let _ = enc.child.kill();
        let _ = enc.child.wait();
    }
    cleanup_session(&session_id);
}

/// Put a file reference on the general pasteboard so it can be pasted into
/// Finder, Slack, Messages, etc.
#[tauri::command]
pub(crate) fn copy_file_to_clipboard(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSPasteboard, NSPasteboardWriting};
        use objc2_foundation::{NSArray, NSString, NSURL};

        let ns_path = NSString::from_str(&path);
        let url = NSURL::fileURLWithPath(&ns_path);
        let writer: &objc2::runtime::ProtocolObject<dyn NSPasteboardWriting> =
            objc2::runtime::ProtocolObject::from_ref(&*url);
        let arr = NSArray::from_slice(&[writer]);
        let pb = NSPasteboard::generalPasteboard();
        pb.clearContents();
        if !pb.writeObjects(&arr) {
            return Err("pasteboard rejected the file".into());
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("clipboard file copy is only implemented on macOS".into())
    }
}

/// Native save dialog for the export destination. Same async/main-thread
/// rationale as `save_project`.
#[tauri::command]
pub(crate) async fn pick_export_path(
    app: AppHandle,
    default_name: String,
    ext: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, mut rx) = tauri::async_runtime::channel(1);
    let mut builder = app
        .dialog()
        .file()
        .set_title("Export Video")
        .set_file_name(&default_name)
        .add_filter("Video", &[ext.as_str()]);
    // Anchor the panel to the editor. Without a parent the panel can attach to
    // a hidden window (the always-present "permissions" window), surfacing it
    // and, on dismiss, bringing the HUD forward.
    if let Some(editor) = app.get_webview_window("editor") {
        builder = builder.set_parent(&editor);
    }
    builder.save_file(move |path| {
        let _ = tx.blocking_send(path);
    });

    let Some(file_path) = rx.recv().await.flatten() else {
        return Ok(None);
    };
    let path = file_path.into_path().map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}
