use super::*;

#[derive(Clone, Serialize)]
pub struct OpenedProject {
    path: String,
    contents: String,
}

/// A `.openscreen` file the OS asked us to open (Finder double-click) that
/// the editor webview hasn't consumed yet. On a cold start the Opened event
/// fires before the frontend has registered any listeners, so the file is
/// stashed here and the editor takes it on mount; for an already-running app
/// the `open-project-file` event reaches the editor directly.
#[derive(Default)]
pub(crate) struct PendingProjectFile(Mutex<Option<OpenedProject>>);

pub(crate) fn handle_opened_project_file(app: &AppHandle, path: PathBuf) {
    if path.extension().and_then(|e| e.to_str()) != Some("openscreen") {
        return;
    }
    let Ok(contents) = fs::read_to_string(&path) else {
        return;
    };
    let opened = OpenedProject {
        path: path.to_string_lossy().to_string(),
        contents,
    };
    *app.state::<PendingProjectFile>().0.lock() = Some(opened.clone());
    if let Some(editor) = app.get_webview_window("editor") {
        let _ = editor.emit("open-project-file", &opened);
        let _ = editor.show();
        let _ = editor.set_focus();
    }
    if let Some(hud) = app.get_webview_window("hud") {
        let _ = hud.hide();
    }
}

#[tauri::command]
pub(crate) fn take_pending_project_file(state: tauri::State<PendingProjectFile>) -> Option<OpenedProject> {
    state.0.lock().take()
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
pub(crate) async fn save_project(
    app: AppHandle,
    default_name: String,
    contents: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, mut rx) = tauri::async_runtime::channel(1);
    let mut builder = app
        .dialog()
        .file()
        .set_title("Save Project")
        .set_file_name(&default_name)
        .add_filter("OpenScreen Project", &["openscreen"]);
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
    fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// Prompt for a `.openscreen` file and return its path + raw JSON contents.
/// Returns `None` if the user cancelled the dialog. Async for the same
/// main-thread reason documented on `save_project`.
#[tauri::command]
pub(crate) async fn open_project(app: AppHandle) -> Result<Option<OpenedProject>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, mut rx) = tauri::async_runtime::channel(1);
    let mut builder = app
        .dialog()
        .file()
        .set_title("Open Project")
        .add_filter("OpenScreen Project", &["openscreen"]);
    if let Some(editor) = app.get_webview_window("editor") {
        builder = builder.set_parent(&editor);
    }
    builder.pick_file(move |path| {
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
pub(crate) fn present_editor(app: AppHandle) -> Result<(), String> {
    if let Some(editor) = app.get_webview_window("editor") {
        editor.show().map_err(|e| e.to_string())?;
        editor.set_focus().map_err(|e| e.to_string())?;
    }
    if let Some(hud) = app.get_webview_window("hud") {
        let _ = hud.hide();
    }
    Ok(())
}

