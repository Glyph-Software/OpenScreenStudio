import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

// Floating, draggable squircle webcam preview. Runs in its own transparent,
// always-on-top WebviewWindow (label "camera-preview") created from Rust. The
// window belongs to our process, so ScreenCaptureKit's self-exclusion keeps it
// out of every recording — it stays visible while recording without appearing
// in the captured video.
//
// Device selection note: WebKit hashes getUserMedia deviceIds per-origin, so we
// can't reuse the AVCaptureDevice uniqueID the HUD persists. We match the
// requested camera by *label* instead, falling back to the default device.

const startDrag = (e: React.MouseEvent) => {
  if (e.button !== 0) return;
  e.preventDefault();
  void getCurrentWindow().startDragging();
};

function deviceIdForLabel(
  devices: MediaDeviceInfo[],
  label: string | null,
): string | null {
  const cams = devices.filter((d) => d.kind === "videoinput");
  if (label) {
    const match = cams.find((d) => d.label === label);
    if (match) return match.deviceId;
  }
  return cams[0]?.deviceId ?? null;
}

export function CameraPreview() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const stop = () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };

    const acquire = async (label: string | null) => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("Camera unavailable");
        return;
      }
      try {
        // First grab unlocks device labels in enumerateDevices().
        const probe = await navigator.mediaDevices.getUserMedia({ video: true });
        const devices = await navigator.mediaDevices.enumerateDevices();
        const id = deviceIdForLabel(devices, label);
        // Reuse the probe stream when it already targets the right device.
        const probeId = probe.getVideoTracks()[0]?.getSettings().deviceId;
        let stream = probe;
        if (id && id !== probeId) {
          probe.getTracks().forEach((t) => t.stop());
          stream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: id } },
          });
        }
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        stop();
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        setError(null);
      } catch {
        if (!cancelled) setError("Camera unavailable");
      }
    };

    const params = new URLSearchParams(window.location.search);
    void acquire(params.get("label") || null);

    const unlistenP = listen<string | null>("camera-preview-device", (e) => {
      void acquire(e.payload || null);
    });

    return () => {
      cancelled = true;
      stop();
      void unlistenP.then((un) => un());
    };
  }, []);

  return (
    <div className="cam-preview" onMouseDown={startDrag}>
      {error ? (
        <div className="cam-preview-error">{error}</div>
      ) : (
        <video ref={videoRef} autoPlay muted playsInline />
      )}
    </div>
  );
}
