//! Camera (webcam) recorder.
//!
//! Records the selected camera to a sidecar QuickTime movie next to the
//! screen recording, using AVFoundation's file-output pipeline
//! (`AVCaptureSession` + `AVCaptureMovieFileOutput`) — hardware-encoded by
//! the OS, correct timestamps, no transcoding on our side.
//!
//! AVFoundation objects aren't `Send`, so the session lives on a dedicated
//! thread that owns every Objective-C object and is driven through a command
//! channel (same pattern as the cpal mic meter). Pause/resume map onto
//! `AVCaptureFileOutput`'s native pause/resume, which drops the paused
//! stretch from the file — mirroring how the screen recording's segment
//! concat drops it.
//!
//! Sync: the delegate's `didStartRecording` callback stamps a wall-clock
//! epoch; the editor aligns the camera against the screen recording via
//! `camera_offset_ms = camera_epoch - screen_epoch`.

use std::path::PathBuf;
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;
use std::time::Duration;

use objc2::rc::Retained;
use objc2::runtime::{Bool, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
use objc2_av_foundation::{
    AVAuthorizationStatus, AVCaptureConnection, AVCaptureDevice,
    AVCaptureDeviceDiscoverySession, AVCaptureDeviceInput, AVCaptureDevicePosition,
    AVCaptureDeviceTypeBuiltInWideAngleCamera, AVCaptureDeviceTypeContinuityCamera,
    AVCaptureDeviceTypeExternal, AVCaptureFileOutput, AVCaptureFileOutputRecordingDelegate,
    AVCaptureMovieFileOutput, AVCaptureSession, AVCaptureSessionPresetHigh,
    AVErrorRecordingSuccessfullyFinishedKey, AVMediaType, AVMediaTypeAudio, AVMediaTypeVideo,
};
use objc2_foundation::{NSArray, NSError, NSNumber, NSObject, NSObjectProtocol, NSString, NSURL};
use parking_lot::Mutex;

use crate::CaptureSource;

/// Cameras available for recording. `id` is the AVCaptureDevice uniqueID and
/// feeds straight into [`CameraRecorder::start`].
pub fn list_camera_devices() -> Vec<CaptureSource> {
    unsafe {
        let Some(video) = AVMediaTypeVideo else {
            return Vec::new();
        };
        let types = NSArray::from_slice(&[
            AVCaptureDeviceTypeBuiltInWideAngleCamera,
            AVCaptureDeviceTypeExternal,
            AVCaptureDeviceTypeContinuityCamera,
        ]);
        let session = AVCaptureDeviceDiscoverySession::discoverySessionWithDeviceTypes_mediaType_position(
            &types,
            Some(video),
            AVCaptureDevicePosition::Unspecified,
        );
        let default_id = AVCaptureDevice::defaultDeviceWithMediaType(video)
            .map(|d| d.uniqueID().to_string());
        session
            .devices()
            .iter()
            .map(|d| {
                let id = d.uniqueID().to_string();
                CaptureSource {
                    is_default: Some(&id) == default_id.as_ref(),
                    id,
                    kind: "camera".into(),
                    label: d.localizedName().to_string(),
                }
            })
            .collect()
    }
}

/// The AVMediaType for the given track kind: `true` → video (camera),
/// `false` → audio (microphone).
fn media_type(video: bool) -> Option<&'static AVMediaType> {
    unsafe {
        if video {
            AVMediaTypeVideo
        } else {
            AVMediaTypeAudio
        }
    }
}

/// TCC authorization status for the camera (`video = true`) or microphone
/// (`video = false`).
pub fn authorization(video: bool) -> AVAuthorizationStatus {
    unsafe {
        match media_type(video) {
            Some(mt) => AVCaptureDevice::authorizationStatusForMediaType(mt),
            None => AVAuthorizationStatus::Denied,
        }
    }
}

pub fn camera_authorization() -> AVAuthorizationStatus {
    authorization(true)
}

/// Request camera (`video = true`) or microphone (`video = false`) access,
/// blocking until the user answers the TCC prompt. Returns whether access is
/// granted. Already-determined states resolve immediately without prompting.
pub fn request_access_blocking(video: bool) -> bool {
    unsafe {
        let Some(mt) = media_type(video) else { return false };
        match AVCaptureDevice::authorizationStatusForMediaType(mt) {
            AVAuthorizationStatus::Authorized => return true,
            AVAuthorizationStatus::Denied | AVAuthorizationStatus::Restricted => return false,
            _ => {}
        }
        // NotDetermined: fire the prompt and wait for the completion handler,
        // which fires on an arbitrary dispatch queue after the user answers.
        let (tx, rx) = mpsc::channel::<bool>();
        let block = block2::RcBlock::new(move |granted: Bool| {
            let _ = tx.send(granted.as_bool());
        });
        AVCaptureDevice::requestAccessForMediaType_completionHandler(mt, &block);
        rx.recv_timeout(Duration::from_secs(120)).unwrap_or(false)
    }
}

/// Fire the async TCC camera prompt (no-op if already determined). Called
/// when the user toggles the camera pill on, so the prompt is resolved well
/// before recording starts.
pub fn request_camera_access() {
    unsafe {
        let Some(video) = AVMediaTypeVideo else { return };
        if AVCaptureDevice::authorizationStatusForMediaType(video)
            != AVAuthorizationStatus::NotDetermined
        {
            return;
        }
        let block = block2::RcBlock::new(|_granted: Bool| {});
        AVCaptureDevice::requestAccessForMediaType_completionHandler(video, &block);
    }
}

/// AVFoundation hands `didFinishRecording` a non-nil `error` even when the
/// movie was written successfully — a normal stop, or hitting a size/duration
/// limit, both surface as an "error" whose userInfo carries
/// `AVErrorRecordingSuccessfullyFinishedKey == YES`. That flag is the
/// authoritative signal: when it's set the file is complete and playable, so
/// the recording must NOT be reported as failed. Treating every non-nil error
/// as a failure is what silently dropped a perfectly good camera movie.
fn recording_failed(error: &NSError) -> bool {
    unsafe {
        let Some(key) = AVErrorRecordingSuccessfullyFinishedKey else {
            return true;
        };
        match error.userInfo().objectForKey(key) {
            Some(val) => match val.downcast::<NSNumber>() {
                Ok(num) => !num.boolValue(),
                Err(_) => true,
            },
            None => true,
        }
    }
}

struct CameraDelegateIvars {
    started_epoch_ms: Arc<Mutex<Option<i64>>>,
    // Some(err) = recording ended with an error; None = clean finish.
    finished_tx: Mutex<Option<mpsc::Sender<Option<String>>>>,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements and the delegate
    // does not implement Drop.
    #[unsafe(super = NSObject)]
    #[thread_kind = AllocAnyThread]
    #[name = "OSSCameraRecorderDelegate"]
    #[ivars = CameraDelegateIvars]
    struct CameraDelegate;

    unsafe impl NSObjectProtocol for CameraDelegate {}

    unsafe impl AVCaptureFileOutputRecordingDelegate for CameraDelegate {
        #[unsafe(method(captureOutput:didStartRecordingToOutputFileAtURL:fromConnections:))]
        unsafe fn did_start(
            &self,
            _output: &AVCaptureFileOutput,
            _url: &NSURL,
            _connections: &NSArray<AVCaptureConnection>,
        ) {
            *self.ivars().started_epoch_ms.lock() =
                Some(chrono::Local::now().timestamp_millis());
        }

        #[unsafe(method(captureOutput:didFinishRecordingToOutputFileAtURL:fromConnections:error:))]
        unsafe fn did_finish(
            &self,
            _output: &AVCaptureFileOutput,
            _url: &NSURL,
            _connections: &NSArray<AVCaptureConnection>,
            error: Option<&NSError>,
        ) {
            let err = match error {
                Some(e) if recording_failed(e) => Some(e.localizedDescription().to_string()),
                _ => None,
            };
            if let Some(tx) = self.ivars().finished_tx.lock().take() {
                let _ = tx.send(err);
            }
        }
    }
);

impl CameraDelegate {
    fn new(
        started_epoch_ms: Arc<Mutex<Option<i64>>>,
        finished_tx: mpsc::Sender<Option<String>>,
    ) -> Retained<Self> {
        let this = Self::alloc().set_ivars(CameraDelegateIvars {
            started_epoch_ms,
            finished_tx: Mutex::new(Some(finished_tx)),
        });
        unsafe { msg_send![super(this), init] }
    }
}

enum CameraCmd {
    Pause,
    Resume,
    /// Finalize the movie and shut the session down. Replies once the file
    /// is fully written (or errored).
    Stop(mpsc::Sender<Result<(), String>>),
    /// Shut down and delete the file (cancel/restart paths).
    Discard(mpsc::Sender<()>),
}

pub struct CameraRecorder {
    cmd_tx: mpsc::Sender<CameraCmd>,
    handle: Option<JoinHandle<()>>,
    started_epoch_ms: Arc<Mutex<Option<i64>>>,
    path: PathBuf,
}

impl CameraRecorder {
    /// Start recording `device_id` (AVCaptureDevice uniqueID; empty = default
    /// camera) to `path`. Blocks until the session is up and the file output
    /// has been asked to record, so failures surface to the caller.
    pub fn start(device_id: &str, path: PathBuf) -> Result<Self, String> {
        match camera_authorization() {
            AVAuthorizationStatus::Authorized => {}
            AVAuthorizationStatus::NotDetermined => {
                request_camera_access();
                return Err(
                    "Camera access not determined yet — respond to the permission prompt, then start the recording again.".into(),
                );
            }
            _ => {
                return Err(
                    "Camera access is denied. Grant it in System Settings → Privacy & Security → Camera.".into(),
                );
            }
        }

        let started_epoch_ms: Arc<Mutex<Option<i64>>> = Arc::new(Mutex::new(None));
        let (cmd_tx, cmd_rx) = mpsc::channel::<CameraCmd>();
        let (init_tx, init_rx) = mpsc::channel::<Result<(), String>>();

        let thread_epoch = Arc::clone(&started_epoch_ms);
        let thread_path = path.clone();
        let thread_device_id = device_id.to_string();
        let handle = std::thread::spawn(move || {
            camera_thread(thread_device_id, thread_path, thread_epoch, cmd_rx, init_tx);
        });

        match init_rx.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(())) => Ok(Self {
                cmd_tx,
                handle: Some(handle),
                started_epoch_ms,
                path,
            }),
            Ok(Err(e)) => {
                let _ = handle.join();
                Err(e)
            }
            Err(_) => Err("Camera session start timed out.".into()),
        }
    }

    pub fn pause(&self) {
        let _ = self.cmd_tx.send(CameraCmd::Pause);
    }

    pub fn resume(&self) {
        let _ = self.cmd_tx.send(CameraCmd::Resume);
    }

    /// Finalize the movie. Always returns the output path + start epoch (so the
    /// caller can fall back to the file actually written to disk); `result`
    /// carries any error AVFoundation surfaced while finishing. Note that a
    /// non-fatal `result` error does NOT mean the movie is unusable — a clean
    /// stop frequently reports an "error" yet still writes a complete file.
    pub fn stop(mut self) -> (PathBuf, Option<i64>, Result<(), String>) {
        let result = (|| -> Result<(), String> {
            let (tx, rx) = mpsc::channel();
            self.cmd_tx
                .send(CameraCmd::Stop(tx))
                .map_err(|_| "Camera thread is gone.".to_string())?;
            rx.recv_timeout(Duration::from_secs(8))
                .map_err(|_| "Camera finalize timed out.".to_string())?
        })();
        // Deliberately DO NOT join the camera thread. By the time the reply
        // above arrives, the movie file is fully finalized; the thread then
        // calls `session.stopRunning()`, which AVFoundation services on the
        // main thread. Joining here would block the caller (often the main
        // thread itself) and deadlock against that teardown. Detach instead and
        // let the thread wind the session down on its own.
        self.handle.take();
        let epoch = *self.started_epoch_ms.lock();
        (self.path.clone(), epoch, result)
    }

    /// Tear down and delete the movie file.
    pub fn discard(mut self) {
        let (tx, rx) = mpsc::channel();
        if self.cmd_tx.send(CameraCmd::Discard(tx)).is_ok() {
            let _ = rx.recv_timeout(Duration::from_secs(8));
        }
        // Detach rather than join, for the same deadlock reason as `stop()`:
        // the thread's `session.stopRunning()` is serviced on the main thread.
        self.handle.take();
    }
}

type CameraSetup = (
    Retained<AVCaptureSession>,
    Retained<AVCaptureMovieFileOutput>,
    Retained<CameraDelegate>,
);

/// Body of the session-owning thread. Every AVFoundation object is created,
/// used, and dropped here.
fn camera_thread(
    device_id: String,
    path: PathBuf,
    started_epoch_ms: Arc<Mutex<Option<i64>>>,
    cmd_rx: mpsc::Receiver<CameraCmd>,
    init_tx: mpsc::Sender<Result<(), String>>,
) {
    let (finished_tx, finished_rx) = mpsc::channel::<Option<String>>();

    let setup = || -> Result<CameraSetup, String> {
        unsafe {
            let device = if device_id.is_empty() {
                AVMediaTypeVideo.and_then(|v| AVCaptureDevice::defaultDeviceWithMediaType(v))
            } else {
                AVCaptureDevice::deviceWithUniqueID(&NSString::from_str(&device_id))
                    // The saved camera may have been unplugged — fall back to
                    // the default one rather than failing the recording.
                    .or_else(|| {
                        AVMediaTypeVideo.and_then(|v| AVCaptureDevice::defaultDeviceWithMediaType(v))
                    })
            };
            let device = device.ok_or("No camera available.")?;

            let input = AVCaptureDeviceInput::deviceInputWithDevice_error(&device)
                .map_err(|e| format!("Camera input failed: {}", e.localizedDescription()))?;

            let session = AVCaptureSession::new();
            session.setSessionPreset(AVCaptureSessionPresetHigh);
            if !session.canAddInput(&input) {
                return Err("Camera input can't be added to the session.".into());
            }
            session.addInput(&input);

            let output = AVCaptureMovieFileOutput::new();
            if !session.canAddOutput(&output) {
                return Err("Movie output can't be added to the session.".into());
            }
            session.addOutput(&output);

            session.startRunning();

            let delegate = CameraDelegate::new(Arc::clone(&started_epoch_ms), finished_tx.clone());
            let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
            output.startRecordingToOutputFileURL_recordingDelegate(
                &url,
                ProtocolObject::from_ref(&*delegate),
            );
            Ok((session, output, delegate))
        }
    };

    let (session, output, _delegate) = match setup() {
        Ok(v) => {
            let _ = init_tx.send(Ok(()));
            v
        }
        Err(e) => {
            let _ = init_tx.send(Err(e));
            return;
        }
    };

    // Wait for stop/discard while honoring pause/resume. A disconnected
    // channel (recorder dropped without stop) tears everything down too.
    let mut delete_file = false;
    let mut reply_stop: Option<mpsc::Sender<Result<(), String>>> = None;
    let mut reply_discard: Option<mpsc::Sender<()>> = None;
    loop {
        match cmd_rx.recv() {
            Ok(CameraCmd::Pause) => unsafe { output.pauseRecording() },
            Ok(CameraCmd::Resume) => unsafe { output.resumeRecording() },
            Ok(CameraCmd::Stop(reply)) => {
                reply_stop = Some(reply);
                break;
            }
            Ok(CameraCmd::Discard(reply)) => {
                delete_file = true;
                reply_discard = Some(reply);
                break;
            }
            Err(_) => {
                delete_file = true;
                break;
            }
        }
    }

    unsafe { output.stopRecording() };
    // didFinishRecording fires after trailing samples are flushed; only then
    // is the movie's moov atom in place and the file playable.
    let finish = finished_rx
        .recv_timeout(Duration::from_secs(6))
        .unwrap_or(Some("Camera finalize timed out.".into()));

    // The movie is finalized now (didFinishRecording fired above), so the
    // caller has everything it needs — reply BEFORE tearing the session down.
    // This ordering is critical: `session.stopRunning()` marshals to the main
    // thread via `performSelector:waitUntilDone:`, and the caller
    // (finalize_recording / discard) frequently runs on the main thread — if it
    // were still blocked waiting on this reply, the main thread could never
    // service that selector and both threads would deadlock. Unblocking first
    // lets the caller return to its runloop so teardown can complete.
    if delete_file {
        let _ = std::fs::remove_file(&path);
    }
    if let Some(reply) = reply_stop.take() {
        let _ = reply.send(match &finish {
            None => Ok(()),
            Some(e) => Err(format!("Camera recording failed: {e}")),
        });
    }
    if let Some(reply) = reply_discard.take() {
        let _ = reply.send(());
    }

    unsafe { session.stopRunning() };
}
