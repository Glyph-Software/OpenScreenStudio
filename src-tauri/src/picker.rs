use super::*;

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
pub(crate) fn list_displays() -> Result<Vec<DisplayInfo>, String> {
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
pub(crate) fn list_windows_inner(displays: &[DisplayInfo]) -> Vec<WindowInfo> {
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
pub(crate) fn list_windows_inner(_displays: &[DisplayInfo]) -> Vec<WindowInfo> { Vec::new() }

#[tauri::command]
pub(crate) fn list_windows() -> Result<Vec<WindowInfo>, String> {
    let displays = list_displays()?;
    Ok(list_windows_inner(&displays))
}

// --- Picker cursor tracker --------------------------------------------------

#[derive(Default)]
pub(crate) struct PickerTrackerState(Mutex<Option<PickerTracker>>);

pub(crate) struct PickerTracker {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

#[cfg(target_os = "macos")]
pub(crate) fn current_cursor_position() -> Option<CGPoint> {
    unsafe {
        let evt = CGEventCreate(std::ptr::null_mut());
        if evt.is_null() { return None; }
        let loc = CGEventGetLocation(evt);
        CFRelease(evt as *const _);
        Some(loc)
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn current_cursor_position() -> Option<CGPoint> { None }

pub(crate) fn start_picker_tracker(
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

pub(crate) fn stop_picker_tracker(state: &PickerTrackerState) {
    if let Some(mut t) = state.0.lock().take() {
        t.stop.store(true, Ordering::Relaxed);
        if let Some(h) = t.handle.take() { let _ = h.join(); }
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn set_ns_window_level(win: &tauri::WebviewWindow, level: isize) {
    use objc2_app_kit::NSWindow;
    if let Ok(ns_window) = win.ns_window() {
        let ns_window: &NSWindow = unsafe { &*(ns_window as *const NSWindow) };
        ns_window.setLevel(level);
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn set_ns_window_level(_win: &tauri::WebviewWindow, _level: isize) {}

// NSWindow levels we care about.
pub(crate) const NS_WINDOW_LEVEL_STATUS: isize = 25;        // pickers sit here
pub(crate) const NS_WINDOW_LEVEL_POPUP: isize = 101;        // HUD sits above pickers

pub(crate) const CAMERA_PREVIEW_LABEL: &str = "camera-preview";
pub(crate) const CAMERA_PREVIEW_SIZE: f64 = 240.0;
pub(crate) const CAMERA_PREVIEW_MARGIN: f64 = 32.0;

/// Show the floating camera preview window, creating it if needed. The webview
/// runs `getUserMedia` and matches the requested camera by `device_label`
/// (WebKit hashes deviceIds per-origin, so the AVCaptureDevice uniqueID can't
/// be used directly). The window is our own process, so ScreenCaptureKit's
/// self-exclusion keeps it out of every recording. Stays up during recording.
#[tauri::command]
pub(crate) fn show_camera_preview(app: AppHandle, device_label: Option<String>) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(CAMERA_PREVIEW_LABEL) {
        let _ = app.emit_to(CAMERA_PREVIEW_LABEL, "camera-preview-device", device_label);
        win.show().map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Bottom-left of the main display, inset by a margin.
    let displays = list_displays()?;
    let main = displays
        .iter()
        .find(|d| d.is_main)
        .or_else(|| displays.first());
    let (x, y) = match main {
        Some(d) => (
            d.x + CAMERA_PREVIEW_MARGIN,
            d.y + d.height - CAMERA_PREVIEW_SIZE - CAMERA_PREVIEW_MARGIN,
        ),
        None => (CAMERA_PREVIEW_MARGIN, CAMERA_PREVIEW_MARGIN),
    };

    let label = device_label.unwrap_or_default();
    let url = format!(
        "index.html?cameraPreview=1&label={}",
        urlencoding_lite(&label)
    );
    let win = WebviewWindowBuilder::new(&app, CAMERA_PREVIEW_LABEL, WebviewUrl::App(url.into()))
        .title("Camera")
        .position(x, y)
        .inner_size(CAMERA_PREVIEW_SIZE, CAMERA_PREVIEW_SIZE)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focused(false)
        .build()
        .map_err(|e| format!("Failed to create camera preview: {e}"))?;
    set_ns_window_level(&win, NS_WINDOW_LEVEL_POPUP);
    win.show().map_err(|e| e.to_string())?;
    Ok(())
}

/// Hide (and tear down) the camera preview. We close rather than hide so
/// WKWebView releases the camera and the green LED turns off.
#[tauri::command]
pub(crate) fn hide_camera_preview(app: AppHandle) {
    close_camera_preview(&app);
}

pub(crate) fn close_camera_preview(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(CAMERA_PREVIEW_LABEL) {
        let _ = win.close();
    }
}

/// Switch the live preview to a different camera (matched by label).
#[tauri::command]
pub(crate) fn set_camera_preview_device(app: AppHandle, device_label: Option<String>) {
    let _ = app.emit_to(CAMERA_PREVIEW_LABEL, "camera-preview-device", device_label);
}

#[tauri::command]
pub(crate) fn open_picker_overlays(
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

pub(crate) fn close_picker_overlays_inner(app: &AppHandle, tracker: &PickerTrackerState) -> Result<(), String> {
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
pub(crate) fn close_picker_overlays(app: AppHandle, tracker: State<'_, PickerTrackerState>) -> Result<(), String> {
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
pub(crate) fn picker_select_display(
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
pub(crate) fn picker_select_window(
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
pub(crate) fn picker_select_area(
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
pub(crate) fn urlencoding_lite(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}
