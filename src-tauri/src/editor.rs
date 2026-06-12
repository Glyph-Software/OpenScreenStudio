use super::*;


pub(crate) fn dev_fixture_path() -> Result<PathBuf, String> {
    let dir = dirs_recordings_dir().ok_or_else(|| {
        "Could not resolve ~/Movies/OpenScreen Studio for the dev fixture.".to_string()
    })?;
    Ok(dir.join("dev-fixture.mp4"))
}

pub(crate) fn ensure_dev_fixture(path: &Path) -> Result<(), String> {
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

pub(crate) fn media_duration_ms(path: &Path) -> Result<u64, String> {
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
pub(crate) fn open_dev_editor(app: AppHandle, tracker: State<'_, PickerTrackerState>) -> Result<(), String> {
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
        system_audio_path: None,
        mic_path: None,
        camera_path: None,
        camera_offset_ms: None,
    };
    open_editor_with_artifact(app, artifact)
}

/// Show a native macOS confirm alert ("Delete this project?"). On confirm,
/// hide the editor and bring the HUD back. Returns whether the user confirmed.
/// The alert blocks on the main thread via `run_on_main_thread`.
#[tauri::command]
pub(crate) fn confirm_and_discard_editor(app: AppHandle) -> Result<bool, String> {
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
pub(crate) fn show_discard_alert() -> bool {
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
pub(crate) fn show_discard_alert() -> bool {
    true
}

/// Open the editor window with a recording artifact loaded.
#[tauri::command]
pub(crate) fn open_editor_with_artifact(app: AppHandle, artifact: CaptureArtifact) -> Result<(), String> {
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
    // Don't leave a live camera running over the editor.
    close_camera_preview(&app);
    Ok(())
}

#[derive(serde::Serialize)]
pub(crate) struct MacWallpaper {
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
pub(crate) fn list_macos_wallpapers() -> Result<Vec<MacWallpaper>, String> {
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
pub(crate) fn current_macos_wallpaper() -> Option<String> {
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

