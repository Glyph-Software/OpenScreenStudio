//! Real capture backend.
//!
//! - Screen recording uses ScreenCaptureKit (`screencapturekit` crate) entirely
//!   in-process and writes directly to mp4 via `SCRecordingOutput` (macOS 15+).
//!   The TCC permission attaches to the .app bundle, so once the user grants
//!   Screen Recording once, every recording Just Works — no ffmpeg sidecar,
//!   no AVFoundation device indices, no per-binary permission dance.
//! - System audio and microphone are tapped off the same SCStream as raw PCM
//!   (`SCStreamOutputType::Audio` / `::Microphone`) and written to sidecar
//!   WAVs next to the mp4, so the editor gets independently editable tracks.
//!   Microphone enumeration uses the SCK bridge's `AudioInputDevice::list()`.
//! - Mic-level metering uses `cpal` to sample the default input and emits
//!   `mic-level` events at ~30 Hz with the current peak in [0.0, 1.0].

#[cfg(target_os = "macos")]
mod audio_tap;
#[cfg(target_os = "macos")]
mod camera;

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

use std::collections::HashMap;
use std::io::{BufRead, BufReader};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
use screencapturekit::{
    audio_devices::AudioInputDevice,
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
        output_type::SCStreamOutputType,
        sc_stream::SCStream,
    },
};

#[cfg(target_os = "macos")]
use audio_tap::{concat_wav_segments, AudioTap, VideoAnchor};

mod capture;
mod editor;
mod export;
mod permissions;
mod picker;
mod project;

pub use permissions::probe_screen_recording_and_exit;

use capture::*;
use editor::*;
use export::*;
use permissions::*;
use picker::*;
use project::*;

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
        .manage(PendingProjectFile::default())
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
            request_camera_access,
            request_mic_access,
            check_camera_access,
            check_mic_access,
            open_privacy_settings,
            show_camera_preview,
            hide_camera_preview,
            set_camera_preview_device,
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
            export_begin,
            export_frame,
            export_finish,
            export_cancel,
            copy_file_to_clipboard,
            pick_export_path,
            quit_app,
            take_pending_project_file,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // Finder double-click on a .openscreen file (also drag-onto-Dock).
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = event {
                for url in urls {
                    if let Ok(path) = url.to_file_path() {
                        handle_opened_project_file(app, path);
                    }
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
