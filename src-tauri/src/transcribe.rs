//! Auto-subtitles: OpenAI key storage + whisper-1 transcription.
//!
//! The key lives in a 0600 file under the app config dir and never goes back
//! to the webview. Audio is downmixed/compressed with the bundled ffmpeg,
//! chunked to stay under the API's 25 MB upload cap, and uploaded with the
//! system `curl` (the auth header is fed through stdin so it never shows up
//! in the process list).

use super::*;
use std::io::Write;

const CHUNK_SEC: u64 = 600;
const KEY_FILE: &str = "openai_api_key";

fn key_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("No config dir: {e}"))?;
    Ok(dir.join(KEY_FILE))
}

fn read_key(app: &AppHandle) -> Option<String> {
    let k = fs::read_to_string(key_path(app).ok()?).ok()?;
    let k = k.trim().to_string();
    (!k.is_empty()).then_some(k)
}

fn mask(key: &str) -> String {
    let tail: String = key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    format!("{}…{}", key.chars().take(3).collect::<String>(), tail)
}

/// Masked hint of the stored key (e.g. `sk-…abcd`), or null when none is set.
#[tauri::command]
pub(crate) fn openai_key_status(app: AppHandle) -> Option<String> {
    read_key(&app).map(|k| mask(&k))
}

#[tauri::command]
pub(crate) fn openai_key_set(app: AppHandle, key: String) -> Result<String, String> {
    let key = key.trim().to_string();
    if key.len() < 20 || key.chars().any(char::is_whitespace) {
        return Err("That doesn't look like an OpenAI API key.".into());
    }
    let path = key_path(&app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Couldn't create config dir: {e}"))?;
    }
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&path).map_err(|e| format!("Couldn't save key: {e}"))?;
    f.write_all(key.as_bytes())
        .map_err(|e| format!("Couldn't save key: {e}"))?;
    Ok(mask(&key))
}

#[tauri::command]
pub(crate) fn openai_key_clear(app: AppHandle) -> Result<(), String> {
    let path = key_path(&app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| format!("Couldn't remove key: {e}"))?;
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranscribeArgs {
    /// One or more audio/video files; several are mixed down together.
    paths: Vec<String>,
    /// ISO-639-1 hint (e.g. "de"); None = auto-detect.
    language: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct TimedText {
    text: String,
    start: f64,
    end: f64,
}

#[derive(Serialize, Default)]
pub(crate) struct Transcript {
    language: String,
    words: Vec<TimedText>,
    segments: Vec<TimedText>,
}

#[derive(Serialize, Clone)]
struct TranscribeProgress {
    done: usize,
    total: usize,
}

#[derive(Deserialize)]
struct ApiWord {
    word: String,
    start: f64,
    end: f64,
}

#[derive(Deserialize)]
struct ApiResponse {
    #[serde(default)]
    language: String,
    #[serde(default)]
    words: Vec<ApiWord>,
    #[serde(default)]
    segments: Vec<TimedText>,
}

fn encode_chunk(paths: &[String], start: u64, out: &Path) -> Result<(), String> {
    let mut cmd = Command::new(ffmpeg_path());
    cmd.args(["-hide_banner", "-loglevel", "error", "-y"]);
    for p in paths {
        cmd.args(["-ss", &start.to_string(), "-t", &CHUNK_SEC.to_string(), "-i", p]);
    }
    if paths.len() > 1 {
        cmd.args([
            "-filter_complex",
            &format!("amix=inputs={}:duration=longest", paths.len()),
        ]);
    }
    cmd.args(["-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "48k"])
        .arg(out)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let o = cmd
        .output()
        .map_err(|e| format!("Failed to invoke bundled ffmpeg: {e}"))?;
    if !o.status.success() {
        return Err(format!(
            "Couldn't prepare audio: {}",
            String::from_utf8_lossy(&o.stderr).trim()
        ));
    }
    Ok(())
}

fn upload_chunk(key: &str, file: &Path, language: Option<&str>) -> Result<ApiResponse, String> {
    let mut cmd = Command::new("/usr/bin/curl");
    cmd.args([
        "-sS",
        "--max-time",
        "900",
        "-X",
        "POST",
        "https://api.openai.com/v1/audio/transcriptions",
        "-H",
        "@-",
        "-F",
        "model=whisper-1",
        "-F",
        "response_format=verbose_json",
        "-F",
        "timestamp_granularities[]=word",
        "-F",
        "timestamp_granularities[]=segment",
    ]);
    if let Some(lang) = language {
        cmd.args(["-F", &format!("language={lang}")]);
    }
    cmd.arg("-F")
        .arg(format!("file=@{}", file.display()))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("Failed to run curl: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        writeln!(stdin, "Authorization: Bearer {key}")
            .map_err(|e| format!("Failed to pass credentials to curl: {e}"))?;
    }
    let o = child
        .wait_with_output()
        .map_err(|e| format!("curl failed: {e}"))?;
    if !o.status.success() {
        return Err(format!(
            "Network error: {}",
            String::from_utf8_lossy(&o.stderr).trim()
        ));
    }
    let v: serde_json::Value = serde_json::from_slice(&o.stdout)
        .map_err(|_| "OpenAI returned an unreadable response.".to_string())?;
    if let Some(msg) = v.pointer("/error/message").and_then(|m| m.as_str()) {
        return Err(format!("OpenAI: {msg}"));
    }
    serde_json::from_value(v).map_err(|e| format!("Unexpected OpenAI response: {e}"))
}

fn run_transcription(app: &AppHandle, key: &str, args: &TranscribeArgs) -> Result<Transcript, String> {
    let paths: Vec<String> = args
        .paths
        .iter()
        .filter(|p| Path::new(p).exists())
        .cloned()
        .collect();
    if paths.is_empty() {
        return Err("No audio found to transcribe.".into());
    }
    let dur_ms = paths
        .iter()
        .filter_map(|p| media_duration_ms(Path::new(p)).ok())
        .max()
        .unwrap_or(0);
    let total = ((dur_ms as f64 / 1000.0) / CHUNK_SEC as f64).ceil().max(1.0) as usize;
    let tmp = std::env::temp_dir().join(format!("oss-transcribe-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&tmp).map_err(|e| format!("Couldn't create temp dir: {e}"))?;
    let lang = args.language.as_deref().filter(|l| !l.is_empty());

    let result = (|| {
        let mut out = Transcript::default();
        let _ = app.emit("transcribe-progress", TranscribeProgress { done: 0, total });
        for i in 0..total {
            let start = i as u64 * CHUNK_SEC;
            let file = tmp.join(format!("chunk-{i}.m4a"));
            encode_chunk(&paths, start, &file)?;
            let r = upload_chunk(key, &file, lang)?;
            let off = start as f64;
            if out.language.is_empty() {
                out.language = r.language;
            }
            out.words.extend(r.words.into_iter().map(|w| TimedText {
                text: w.word,
                start: w.start + off,
                end: w.end + off,
            }));
            out.segments.extend(r.segments.into_iter().map(|s| TimedText {
                text: s.text,
                start: s.start + off,
                end: s.end + off,
            }));
            let _ = app.emit("transcribe-progress", TranscribeProgress { done: i + 1, total });
        }
        Ok(out)
    })();
    let _ = fs::remove_dir_all(&tmp);
    result
}

#[tauri::command]
pub(crate) async fn transcribe_audio(app: AppHandle, args: TranscribeArgs) -> Result<Transcript, String> {
    let key = read_key(&app).ok_or("Add your OpenAI API key first.")?;
    tauri::async_runtime::spawn_blocking(move || run_transcription(&app, &key, &args))
        .await
        .map_err(|e| format!("Transcription task failed: {e}"))?
}
