// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--probe-screen-recording") {
        openscreen_studio_lib::probe_screen_recording_and_exit();
    }
    openscreen_studio_lib::run()
}
