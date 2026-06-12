use super::*;

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
pub(crate) fn probe_screen_recording_via_subprocess() -> bool {
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
    pub(crate) fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: core_foundation::dictionary::CFDictionaryRef) -> u8;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionsStatus {
    pub screen_recording: bool,
    pub accessibility: bool,
}

pub(crate) fn check_permissions_inner() -> PermissionsStatus {
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

pub(crate) fn requested_flag_path(app: &AppHandle, key: &str) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    let _ = fs::create_dir_all(&dir);
    Some(dir.join(format!(".{}_requested", key)))
}

pub(crate) fn mark_requested(app: &AppHandle, key: &str) {
    if let Some(p) = requested_flag_path(app, key) {
        let _ = fs::write(p, b"1");
    }
}

pub(crate) fn was_requested(app: &AppHandle, key: &str) -> bool {
    requested_flag_path(app, key)
        .map(|p| p.exists())
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
pub(crate) fn open_settings(url: &str) {
    let _ = Command::new("open").arg(url).spawn();
}

#[tauri::command]
pub(crate) fn check_permissions() -> PermissionsStatus {
    check_permissions_inner()
}

#[tauri::command]
pub(crate) fn request_screen_recording(app: AppHandle) -> bool {
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
pub(crate) fn request_accessibility(app: AppHandle) -> bool {
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
pub(crate) fn dismiss_permissions(app: AppHandle) -> Result<(), String> {
    if let Some(p) = app.get_webview_window("permissions") {
        let _ = p.hide();
    }
    if let Some(hud) = app.get_webview_window("hud") {
        hud.show().map_err(|e| e.to_string())?;
        hud.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn quit_app(app: AppHandle) {
    // The HUD's close button means "quit", but never tear down an editor
    // session the user may still be working in — just hide the HUD then.
    if let Some(editor) = app.get_webview_window("editor") {
        if editor.is_visible().unwrap_or(false) {
            if let Some(hud) = app.get_webview_window("hud") {
                let _ = hud.hide();
            }
            return;
        }
    }
    app.exit(0);
}
