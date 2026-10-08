use super::*;
use std::io::Read;

// Export frame source: one forward-streaming ffmpeg decoder per (session, size, file), since WebKit <video> seeks freeze once it purges paused decoders.

/// Forward gap (seconds) beyond which re-seeking beats decoding through.
const REOPEN_GAP: f64 = 3.0;
/// Frames whose pts is within this of the target count as "at or before" it.
const PTS_EPS: f64 = 1e-3;

struct Frame {
    pts: f64,
    rgba: Vec<u8>,
}

struct FrameDecoder {
    child: std::process::Child,
    stdout: std::process::ChildStdout,
    pts_rx: mpsc::Receiver<f64>,
    frame_len: usize,
    cur: Option<Frame>,
    next: Option<Frame>,
    eof: bool,
    last_t: f64,
}

impl FrameDecoder {
    fn open(path: &str, t: f64, width: u32, height: u32) -> Result<Self, String> {
        // Keyframe seek + original pts so the frame shown at `t` is produced; untagged SCK mp4s are BT.709, not ffmpeg's 601 default.
        let mut child = Command::new(ffmpeg_path())
            .args(["-hide_banner", "-nostdin", "-noaccurate_seek", "-copyts"])
            .args(["-ss", &format!("{:.6}", t.max(0.0))])
            .args(["-hwaccel", "videotoolbox", "-i", path, "-an", "-sn", "-dn"])
            .args([
                "-vf",
                &format!(
                    "scale={width}:{height}:in_color_matrix=bt709,format=rgba,showinfo=checksum=0"
                ),
            ])
            .args(["-fps_mode", "passthrough", "-f", "rawvideo", "pipe:1"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("failed to start ffmpeg decoder: {e}"))?;
        let stdout = child.stdout.take().ok_or("decoder stdout missing")?;
        let stderr = child.stderr.take().ok_or("decoder stderr missing")?;
        // showinfo logs one line per frame (in order) with its pts_time.
        let (tx, pts_rx) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if !line.contains("Parsed_showinfo") {
                    continue;
                }
                let pts = line
                    .split("pts_time:")
                    .nth(1)
                    .and_then(|s| s.split_whitespace().next())
                    .and_then(|s| s.parse::<f64>().ok());
                if let Some(pts) = pts {
                    if tx.send(pts).is_err() {
                        break;
                    }
                }
            }
        });
        Ok(Self {
            child,
            stdout,
            pts_rx,
            frame_len: width as usize * height as usize * 4,
            cur: None,
            next: None,
            eof: false,
            last_t: t,
        })
    }

    fn read_frame(&mut self) -> Option<Frame> {
        let mut rgba = vec![0u8; self.frame_len];
        if self.stdout.read_exact(&mut rgba).is_err() {
            self.eof = true;
            return None;
        }
        match self.pts_rx.recv() {
            Ok(pts) => Some(Frame { pts, rgba }),
            Err(_) => {
                self.eof = true;
                None
            }
        }
    }

    /// The last decoded frame with pts <= t (or the first frame if t precedes it).
    fn frame_at(&mut self, t: f64) -> Option<Vec<u8>> {
        self.last_t = t;
        loop {
            if self.next.is_none() && !self.eof {
                self.next = self.read_frame();
            }
            match &self.next {
                Some(n) if n.pts <= t + PTS_EPS => self.cur = self.next.take(),
                _ => break,
            }
        }
        self.cur
            .as_ref()
            .or(self.next.as_ref())
            .map(|f| f.rgba.clone())
    }

    fn can_serve(&self, t: f64) -> bool {
        let behind = self.cur.as_ref().map(|f| t < f.pts - PTS_EPS).unwrap_or(false);
        !behind && t >= self.last_t - PTS_EPS && t <= self.last_t + REOPEN_GAP
    }
}

impl Drop for FrameDecoder {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

static FRAME_DECODERS: Lazy<Mutex<HashMap<String, FrameDecoder>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Kill every decoder belonging to an export session.
pub(crate) fn close_frame_decoders(session_id: &str) {
    let prefix = format!("{session_id}|");
    FRAME_DECODERS.lock().retain(|k, _| !k.starts_with(&prefix));
}

/// Raw RGBA (width*height*4) of the frame shown at `t` seconds in `path`.
#[tauri::command]
pub(crate) async fn export_video_frame(
    session_id: String,
    path: String,
    t: f64,
    width: u32,
    height: u32,
) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let key = format!("{session_id}|{width}x{height}|{path}");
        // Take the decoder out so the map isn't locked while decoding.
        let existing = FRAME_DECODERS.lock().remove(&key);
        let mut dec = match existing {
            Some(d) if d.can_serve(t) => d,
            _ => FrameDecoder::open(&path, t, width, height)?,
        };
        let frame = dec
            .frame_at(t)
            .ok_or_else(|| format!("no video frame at {t:.3}s in {path}"))?;
        // Don't resurrect a decoder for a session canceled mid-decode.
        if EXPORT_SESSIONS.lock().contains_key(&session_id) {
            FRAME_DECODERS.lock().insert(key, dec);
        }
        Ok(tauri::ipc::Response::new(frame))
    })
    .await
    .map_err(|e| e.to_string())?
}
